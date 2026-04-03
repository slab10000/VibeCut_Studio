use std::path::{Path, PathBuf};

use anyhow::Context;
use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::models::{
    JobRecord, MediaAsset, PauseRange, ProjectSnapshot, ProjectSummary, SequenceItem, TranscriptMetadata, TranscriptSegment,
    TranscriptWord,
};

#[derive(Clone)]
pub struct Database {
    db_path: PathBuf,
}

impl Database {
    pub fn new(db_path: PathBuf) -> Self {
        Self { db_path }
    }

    fn connection(&self) -> anyhow::Result<Connection> {
        Connection::open(&self.db_path).with_context(|| format!("failed to open {}", self.db_path.display()))
    }

    fn column_exists(connection: &Connection, table: &str, column: &str) -> anyhow::Result<bool> {
        let pragma = format!("PRAGMA table_info({table})");
        let mut statement = connection.prepare(&pragma)?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(columns.iter().any(|name| name == column))
    }

    fn ensure_column(connection: &Connection, table: &str, column: &str, definition: &str) -> anyhow::Result<()> {
        if Self::column_exists(connection, table, column)? {
            return Ok(());
        }

        let statement = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
        connection.execute(&statement, [])?;
        Ok(())
    }

    pub fn initialize(&self) -> anyhow::Result<()> {
        if let Some(parent) = self.db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let connection = self.connection()?;
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS projects (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS media_assets (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              source_path TEXT NOT NULL,
              fingerprint TEXT NOT NULL,
              file_name TEXT NOT NULL,
              duration REAL NOT NULL,
              duration_ms INTEGER NOT NULL,
              status TEXT NOT NULL,
              transcript_status TEXT NOT NULL,
              embedding_status TEXT NOT NULL,
              transcript_metadata TEXT NOT NULL DEFAULT '{}',
              transcript_segments TEXT NOT NULL,
              pause_ranges TEXT NOT NULL,
              waveform TEXT NOT NULL,
              preview_path TEXT,
              thumbnail_path TEXT,
              waveform_path TEXT,
              proxy_path TEXT,
              video_codec TEXT,
              audio_codec TEXT,
              width INTEGER,
              height INTEGER,
              has_audio INTEGER,
              error TEXT
            );

            CREATE TABLE IF NOT EXISTS sequence_items (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              item_type TEXT NOT NULL,
              source_clip_id TEXT,
              source_start_time REAL NOT NULL,
              source_end_time REAL NOT NULL,
              duration REAL NOT NULL,
              label TEXT,
              image_src TEXT,
              sequence_id TEXT,
              track INTEGER NOT NULL,
              timeline_start_ms INTEGER NOT NULL,
              duration_ms INTEGER NOT NULL,
              media_id TEXT,
              source_in_ms INTEGER NOT NULL,
              playback_rate REAL NOT NULL,
              enabled INTEGER NOT NULL,
              kind TEXT NOT NULL,
              effects TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS transcript_segments (
              id TEXT PRIMARY KEY,
              source_clip_id TEXT NOT NULL,
              start_time REAL NOT NULL,
              end_time REAL NOT NULL,
              text TEXT NOT NULL,
              raw_text TEXT NOT NULL DEFAULT '',
              alignment_source TEXT,
              word_edit_capable INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS transcript_words (
              id TEXT PRIMARY KEY,
              source_clip_id TEXT NOT NULL,
              segment_id TEXT NOT NULL,
              text TEXT NOT NULL,
              start_time REAL NOT NULL,
              end_time REAL NOT NULL,
              confidence REAL,
              aligned INTEGER NOT NULL,
              timing_mode TEXT NOT NULL DEFAULT 'exact',
              editable INTEGER NOT NULL DEFAULT 1,
              start_sample INTEGER,
              end_sample INTEGER
            );

            CREATE TABLE IF NOT EXISTS pause_ranges (
              id TEXT PRIMARY KEY,
              source_clip_id TEXT NOT NULL,
              start_time REAL NOT NULL,
              end_time REAL NOT NULL,
              duration REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              target_kind TEXT,
              target_id TEXT NOT NULL,
              status TEXT NOT NULL,
              progress REAL NOT NULL,
              message TEXT,
              payload TEXT,
              result TEXT,
              error_message TEXT,
              fingerprint TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            "#,
        )?;

        Self::ensure_column(&connection, "media_assets", "transcript_metadata", "TEXT NOT NULL DEFAULT '{}'")?;
        Self::ensure_column(&connection, "transcript_segments", "raw_text", "TEXT NOT NULL DEFAULT ''")?;
        Self::ensure_column(&connection, "transcript_words", "timing_mode", "TEXT NOT NULL DEFAULT 'exact'")?;
        Self::ensure_column(&connection, "transcript_words", "editable", "INTEGER NOT NULL DEFAULT 1")?;

        connection.execute(
            "UPDATE media_assets
             SET transcript_metadata = '{}'
             WHERE transcript_metadata IS NULL OR trim(transcript_metadata) = ''",
            [],
        )?;
        connection.execute(
            "UPDATE transcript_segments
             SET raw_text = text
             WHERE raw_text IS NULL OR raw_text = ''",
            [],
        )?;
        connection.execute(
            "UPDATE transcript_words
             SET timing_mode = CASE WHEN aligned > 0 THEN 'exact' ELSE 'approximate' END
             WHERE timing_mode IS NULL OR trim(timing_mode) = ''",
            [],
        )?;
        connection.execute(
            "UPDATE transcript_words
             SET editable = CASE WHEN timing_mode = 'approximate' THEN 0 ELSE 1 END
             WHERE editable IS NULL",
            [],
        )?;

        if connection
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .unwrap_or(0)
            == 0
        {
            connection.execute(
                "INSERT INTO projects (id, name) VALUES (?1, ?2)",
                params!["default-project", "VibeCut Studio"],
            )?;
        }

        drop(connection);
        self.backfill_normalized_transcript_data()?;

        Ok(())
    }

    pub fn project_path(&self) -> &Path {
        &self.db_path
    }

    pub fn reset_session_state(&self) -> anyhow::Result<()> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;

        tx.execute("DELETE FROM transcript_words", [])?;
        tx.execute("DELETE FROM transcript_segments", [])?;
        tx.execute("DELETE FROM pause_ranges", [])?;
        tx.execute("DELETE FROM sequence_items", [])?;
        tx.execute("DELETE FROM media_assets", [])?;
        tx.execute("DELETE FROM jobs", [])?;

        tx.commit()?;
        Ok(())
    }

    pub fn load_project_summary(&self) -> anyhow::Result<ProjectSummary> {
        let connection = self.connection()?;
        connection
            .query_row("SELECT id, name FROM projects ORDER BY rowid LIMIT 1", [], |row| {
                Ok(ProjectSummary {
                    project_id: row.get(0)?,
                    name: row.get(1)?,
                })
            })
            .context("failed to load project summary")
    }

    pub fn load_snapshot(&self) -> anyhow::Result<ProjectSnapshot> {
        let project = self.load_project_summary()?;
        Ok(ProjectSnapshot {
            project_id: project.project_id.clone(),
            name: project.name,
            media_assets: self.load_media_assets(&project.project_id)?,
            sequence_items: self.load_sequence_items(&project.project_id)?,
        })
    }

    pub fn load_media_assets(&self, project_id: &str) -> anyhow::Result<Vec<MediaAsset>> {
        let connection = self.connection()?;
        let mut media_statement = connection.prepare(
            "SELECT
              id, source_path, fingerprint, file_name, duration, duration_ms, status,
              transcript_status, embedding_status, transcript_metadata, transcript_segments, pause_ranges, waveform,
              preview_path, thumbnail_path, waveform_path, proxy_path, video_codec, audio_codec,
              width, height, has_audio, error
             FROM media_assets
             WHERE project_id = ?1
             ORDER BY rowid",
        )?;
        let rows = media_statement
            .query_map(params![project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, f64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, Option<String>>(13)?,
                    row.get::<_, Option<String>>(14)?,
                    row.get::<_, Option<String>>(15)?,
                    row.get::<_, Option<String>>(16)?,
                    row.get::<_, Option<String>>(17)?,
                    row.get::<_, Option<String>>(18)?,
                    row.get::<_, Option<i64>>(19)?,
                    row.get::<_, Option<i64>>(20)?,
                    row.get::<_, Option<i64>>(21)?,
                    row.get::<_, Option<String>>(22)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(media_statement);

        let mut assets = Vec::with_capacity(rows.len());
        for (
            asset_id,
            source_path,
            fingerprint,
            file_name,
            duration,
            duration_ms,
            status,
            transcript_status,
            embedding_status,
            transcript_metadata,
            transcript_segments_blob,
            pause_ranges_blob,
            waveform,
            preview_path,
            thumbnail_path,
            waveform_path,
            proxy_path,
            video_codec,
            audio_codec,
            width,
            height,
            has_audio,
            error,
        ) in rows
        {
            let transcript_segments = self
                .load_transcript_segments_for_asset(&connection, &asset_id)
                .unwrap_or_else(|_| serde_json::from_str(&transcript_segments_blob).unwrap_or_default());
            let pause_ranges = self
                .load_pause_ranges_for_asset(&connection, &asset_id)
                .unwrap_or_else(|_| serde_json::from_str(&pause_ranges_blob).unwrap_or_default());

            assets.push(MediaAsset {
                id: asset_id,
                source_path,
                fingerprint,
                file_name,
                duration,
                duration_ms,
                status,
                transcript_status,
                embedding_status: embedding_status.clone(),
                transcript_metadata: serde_json::from_str::<TranscriptMetadata>(&transcript_metadata).ok(),
                transcript_segments,
                pause_ranges,
                embeddings_ready: embedding_status == "embedding_ready",
                waveform: serde_json::from_str(&waveform).unwrap_or_default(),
                preview_path,
                thumbnail_path,
                waveform_path,
                proxy_path,
                video_codec,
                audio_codec,
                width,
                height,
                has_audio: has_audio.map(|value| value > 0),
                error,
            });
        }

        Ok(assets)
    }

    pub fn load_media_asset(&self, asset_id: &str) -> anyhow::Result<Option<MediaAsset>> {
        let project = self.load_project_summary()?;
        Ok(self
            .load_media_assets(&project.project_id)?
            .into_iter()
            .find(|asset| asset.id == asset_id))
    }

    pub fn load_sequence_items(&self, project_id: &str) -> anyhow::Result<Vec<SequenceItem>> {
        let connection = self.connection()?;
        let mut sequence_statement = connection.prepare(
            "SELECT
              id, item_type, source_clip_id, source_start_time, source_end_time, duration,
              label, image_src, sequence_id, track, timeline_start_ms, duration_ms, media_id,
              source_in_ms, playback_rate, enabled, kind, effects
             FROM sequence_items
             WHERE project_id = ?1
             ORDER BY timeline_start_ms ASC, rowid ASC",
        )?;

        let items = sequence_statement
            .query_map(params![project_id], |row| {
                let effects: String = row.get(17)?;
                Ok(SequenceItem {
                    id: row.get(0)?,
                    r#type: row.get(1)?,
                    source_clip_id: row.get(2)?,
                    source_start_time: row.get(3)?,
                    source_end_time: row.get(4)?,
                    duration: row.get(5)?,
                    label: row.get(6)?,
                    image_src: row.get(7)?,
                    sequence_id: row.get(8)?,
                    track: row.get(9)?,
                    timeline_start_ms: row.get(10)?,
                    duration_ms: row.get(11)?,
                    media_id: row.get(12)?,
                    source_in_ms: row.get(13)?,
                    playback_rate: row.get(14)?,
                    enabled: row.get::<_, i64>(15)? > 0,
                    kind: row.get(16)?,
                    effects: serde_json::from_str(&effects).unwrap_or_default(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(sequence_statement);
        Ok(items)
    }

    pub fn upsert_media_assets(&self, project_id: &str, assets: &[MediaAsset]) -> anyhow::Result<()> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;

        for asset in assets {
            tx.execute(
                "INSERT INTO media_assets (
                  id, project_id, source_path, fingerprint, file_name, duration, duration_ms, status,
                  transcript_status, embedding_status, transcript_metadata, transcript_segments, pause_ranges, waveform,
                  preview_path, thumbnail_path, waveform_path, proxy_path, video_codec, audio_codec,
                  width, height, has_audio, error
                 ) VALUES (
                  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
                  ?19, ?20, ?21, ?22, ?23, ?24
                 )
                 ON CONFLICT(id) DO UPDATE SET
                  source_path = excluded.source_path,
                  fingerprint = excluded.fingerprint,
                  file_name = excluded.file_name,
                  duration = excluded.duration,
                  duration_ms = excluded.duration_ms,
                  status = excluded.status,
                  transcript_status = excluded.transcript_status,
                  embedding_status = excluded.embedding_status,
                  transcript_metadata = excluded.transcript_metadata,
                  transcript_segments = excluded.transcript_segments,
                  pause_ranges = excluded.pause_ranges,
                  waveform = excluded.waveform,
                  preview_path = excluded.preview_path,
                  thumbnail_path = excluded.thumbnail_path,
                  waveform_path = excluded.waveform_path,
                  proxy_path = excluded.proxy_path,
                  video_codec = excluded.video_codec,
                  audio_codec = excluded.audio_codec,
                  width = excluded.width,
                  height = excluded.height,
                  has_audio = excluded.has_audio,
                  error = excluded.error",
                params![
                    asset.id,
                    project_id,
                    asset.source_path,
                    asset.fingerprint,
                    asset.file_name,
                    asset.duration,
                    asset.duration_ms,
                    asset.status,
                    asset.transcript_status,
                    asset.embedding_status,
                    serde_json::to_string(&asset.transcript_metadata)?,
                    serde_json::to_string(&asset.transcript_segments)?,
                    serde_json::to_string(&asset.pause_ranges)?,
                    serde_json::to_string(&asset.waveform)?,
                    asset.preview_path,
                    asset.thumbnail_path,
                    asset.waveform_path,
                    asset.proxy_path,
                    asset.video_codec,
                    asset.audio_codec,
                    asset.width,
                    asset.height,
                    asset.has_audio.map(|value| if value { 1 } else { 0 }),
                    asset.error,
                ],
            )?;

            self.replace_transcript_state(&tx, asset)?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn remove_media_asset(&self, project_id: &str, asset_id: &str) -> anyhow::Result<bool> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;

        let removed = tx.execute(
            "DELETE FROM media_assets WHERE project_id = ?1 AND id = ?2",
            params![project_id, asset_id],
        )? > 0;

        if removed {
            tx.execute("DELETE FROM transcript_words WHERE source_clip_id = ?1", params![asset_id])?;
            tx.execute("DELETE FROM transcript_segments WHERE source_clip_id = ?1", params![asset_id])?;
            tx.execute("DELETE FROM pause_ranges WHERE source_clip_id = ?1", params![asset_id])?;
            tx.execute(
                "DELETE FROM sequence_items
                 WHERE project_id = ?1 AND (source_clip_id = ?2 OR media_id = ?2)",
                params![project_id, asset_id],
            )?;
        }

        tx.commit()?;
        Ok(removed)
    }

    pub fn replace_sequence_items(&self, project_id: &str, items: &[SequenceItem]) -> anyhow::Result<()> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        tx.execute("DELETE FROM sequence_items WHERE project_id = ?1", params![project_id])?;

        for item in items {
            tx.execute(
                "INSERT INTO sequence_items (
                  id, project_id, item_type, source_clip_id, source_start_time, source_end_time, duration,
                  label, image_src, sequence_id, track, timeline_start_ms, duration_ms, media_id, source_in_ms,
                  playback_rate, enabled, kind, effects
                ) VALUES (
                  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
                )",
                params![
                    item.id,
                    project_id,
                    item.r#type,
                    item.source_clip_id,
                    item.source_start_time,
                    item.source_end_time,
                    item.duration,
                    item.label,
                    item.image_src,
                    item.sequence_id,
                    item.track,
                    item.timeline_start_ms,
                    item.duration_ms,
                    item.media_id,
                    item.source_in_ms,
                    item.playback_rate,
                    if item.enabled { 1 } else { 0 },
                    item.kind,
                    serde_json::to_string(&item.effects)?,
                ],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn list_jobs(&self) -> anyhow::Result<Vec<JobRecord>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT
              id, kind, target_kind, target_id, status, progress, message, payload, result, error_message,
              fingerprint, created_at, updated_at
             FROM jobs
             ORDER BY updated_at DESC, created_at DESC",
        )?;

        let jobs = statement
            .query_map([], |row| self.map_job_row(row))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        Ok(jobs)
    }

    pub fn find_active_job(&self, kind: &str, target_id: &str) -> anyhow::Result<Option<JobRecord>> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT
                  id, kind, target_kind, target_id, status, progress, message, payload, result, error_message,
                  fingerprint, created_at, updated_at
                 FROM jobs
                 WHERE kind = ?1 AND target_id = ?2 AND status IN ('queued', 'running')
                 ORDER BY updated_at DESC
                 LIMIT 1",
                params![kind, target_id],
                |row| self.map_job_row(row),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn upsert_job(&self, job: &JobRecord) -> anyhow::Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO jobs (
              id, kind, target_kind, target_id, status, progress, message, payload, result, error_message,
              fingerprint, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
            )
            ON CONFLICT(id) DO UPDATE SET
              kind = excluded.kind,
              target_kind = excluded.target_kind,
              target_id = excluded.target_id,
              status = excluded.status,
              progress = excluded.progress,
              message = excluded.message,
              payload = excluded.payload,
              result = excluded.result,
              error_message = excluded.error_message,
              fingerprint = excluded.fingerprint,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at",
            params![
                job.id,
                job.kind,
                job.target_kind,
                job.target_id,
                job.status,
                job.progress,
                job.message,
                job.payload.as_ref().map(serde_json::to_string).transpose()?,
                job.result.as_ref().map(serde_json::to_string).transpose()?,
                job.error_message,
                job.fingerprint,
                job.created_at,
                job.updated_at,
            ],
        )?;

        Ok(())
    }

    fn map_job_row(&self, row: &rusqlite::Row<'_>) -> rusqlite::Result<JobRecord> {
        let payload: Option<String> = row.get(7)?;
        let result: Option<String> = row.get(8)?;
        Ok(JobRecord {
            id: row.get(0)?,
            kind: row.get(1)?,
            target_kind: row.get(2)?,
            target_id: row.get(3)?,
            status: row.get(4)?,
            progress: row.get(5)?,
            message: row.get(6)?,
            payload: payload.and_then(|value| serde_json::from_str(&value).ok()),
            result: result.and_then(|value| serde_json::from_str(&value).ok()),
            error_message: row.get(9)?,
            fingerprint: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        })
    }

    fn load_transcript_segments_for_asset(
        &self,
        connection: &Connection,
        asset_id: &str,
    ) -> anyhow::Result<Vec<TranscriptSegment>> {
        let mut segment_statement = connection.prepare(
            "SELECT id, start_time, end_time, text, raw_text, alignment_source, word_edit_capable
             FROM transcript_segments
             WHERE source_clip_id = ?1
             ORDER BY start_time ASC, rowid ASC",
        )?;

        let segment_rows = segment_statement
            .query_map(params![asset_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(segment_statement);

        let mut segments = Vec::with_capacity(segment_rows.len());
        for (segment_id, start_time, end_time, text, raw_text, alignment_source, word_edit_capable) in segment_rows {
            let mut word_statement = connection.prepare(
                "SELECT id, text, start_time, end_time, confidence, aligned, timing_mode, editable, start_sample, end_sample
                 FROM transcript_words
                 WHERE segment_id = ?1
                 ORDER BY start_time ASC, rowid ASC",
            )?;

            let words = word_statement
                .query_map(params![segment_id.clone()], |word_row| {
                    Ok(TranscriptWord {
                        id: word_row.get(0)?,
                        source_clip_id: asset_id.to_string(),
                        segment_id: segment_id.clone(),
                        text: word_row.get(1)?,
                        start_time: word_row.get(2)?,
                        end_time: word_row.get(3)?,
                        confidence: word_row.get(4)?,
                        aligned: word_row.get::<_, i64>(5)? > 0,
                        timing_mode: word_row.get(6)?,
                        editable: word_row.get::<_, i64>(7)? > 0,
                        start_sample: word_row.get(8)?,
                        end_sample: word_row.get(9)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(word_statement);

            segments.push(TranscriptSegment {
                id: segment_id,
                source_clip_id: asset_id.to_string(),
                start_time,
                end_time,
                text,
                raw_text,
                words,
                alignment_source,
                word_edit_capable: word_edit_capable > 0,
            });
        }

        Ok(segments)
    }

    fn load_pause_ranges_for_asset(&self, connection: &Connection, asset_id: &str) -> anyhow::Result<Vec<PauseRange>> {
        let mut statement = connection.prepare(
            "SELECT id, start_time, end_time, duration
             FROM pause_ranges
             WHERE source_clip_id = ?1
             ORDER BY start_time ASC, rowid ASC",
        )?;

        let pauses = statement
            .query_map(params![asset_id], |row| {
                Ok(PauseRange {
                    id: row.get(0)?,
                    source_clip_id: asset_id.to_string(),
                    start_time: row.get(1)?,
                    end_time: row.get(2)?,
                    duration: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        Ok(pauses)
    }

    fn replace_transcript_state(&self, tx: &Transaction<'_>, asset: &MediaAsset) -> anyhow::Result<()> {
        tx.execute("DELETE FROM transcript_words WHERE source_clip_id = ?1", params![asset.id])?;
        tx.execute("DELETE FROM transcript_segments WHERE source_clip_id = ?1", params![asset.id])?;
        tx.execute("DELETE FROM pause_ranges WHERE source_clip_id = ?1", params![asset.id])?;

        for segment in &asset.transcript_segments {
            tx.execute(
                "INSERT INTO transcript_segments (
                  id, source_clip_id, start_time, end_time, text, raw_text, alignment_source, word_edit_capable
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    segment.id,
                    asset.id,
                    segment.start_time,
                    segment.end_time,
                    segment.text,
                    segment.raw_text,
                    segment.alignment_source,
                    if segment.word_edit_capable { 1 } else { 0 },
                ],
            )?;

            for word in &segment.words {
                tx.execute(
                    "INSERT INTO transcript_words (
                      id, source_clip_id, segment_id, text, start_time, end_time, confidence, aligned,
                      timing_mode, editable, start_sample, end_sample
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        word.id,
                        asset.id,
                        segment.id,
                        word.text,
                        word.start_time,
                        word.end_time,
                        word.confidence,
                        if word.aligned { 1 } else { 0 },
                        word.timing_mode,
                        if word.editable { 1 } else { 0 },
                        word.start_sample,
                        word.end_sample,
                    ],
                )?;
            }
        }

        for pause in &asset.pause_ranges {
            tx.execute(
                "INSERT INTO pause_ranges (id, source_clip_id, start_time, end_time, duration)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![pause.id, asset.id, pause.start_time, pause.end_time, pause.duration],
            )?;
        }

        Ok(())
    }

    fn backfill_normalized_transcript_data(&self) -> anyhow::Result<()> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let mut statement = tx.prepare("SELECT id, transcript_segments, pause_ranges FROM media_assets ORDER BY rowid")?;

        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;

        for row in rows {
            let (asset_id, segments_blob, pauses_blob) = row?;
            let segment_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM transcript_segments WHERE source_clip_id = ?1",
                params![asset_id.clone()],
                |count_row| count_row.get(0),
            )?;
            let pause_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM pause_ranges WHERE source_clip_id = ?1",
                params![asset_id.clone()],
                |count_row| count_row.get(0),
            )?;

            if segment_count > 0 || pause_count > 0 {
                continue;
            }

            let segments: Vec<TranscriptSegment> = serde_json::from_str(&segments_blob).unwrap_or_default();
            let pauses: Vec<PauseRange> = serde_json::from_str(&pauses_blob).unwrap_or_default();

            let asset = MediaAsset {
                id: asset_id,
                source_path: String::new(),
                fingerprint: String::new(),
                file_name: String::new(),
                duration: 0.0,
                duration_ms: 0,
                status: String::new(),
                transcript_status: String::new(),
                embedding_status: String::new(),
                transcript_metadata: None,
                transcript_segments: segments,
                pause_ranges: pauses,
                embeddings_ready: false,
                waveform: Vec::new(),
                preview_path: None,
                thumbnail_path: None,
                waveform_path: None,
                proxy_path: None,
                video_codec: None,
                audio_codec: None,
                width: None,
                height: None,
                has_audio: None,
                error: None,
            };

            self.replace_transcript_state(&tx, &asset)?;
        }

        drop(statement);
        tx.commit()?;
        Ok(())
    }
}
