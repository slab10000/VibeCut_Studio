use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use uuid::Uuid;

use crate::{
    application::events::{emit_entity_change, emit_job_update},
    domain::jobs::{create_job, mark_job_complete, mark_job_error, mark_job_running},
    infrastructure::{
        providers::{
            clean_json_response, embedding_request_body, extract_text_from_response, fetch_video_bytes,
            gemini_batch_embed, gemini_generate_content, gemini_generate_videos,
            gemini_image_model, gemini_reasoning_model, poll_video_operation, request_transcription,
        },
        runtime::{
            base64_decode, command_available, detect_hardware_encoding, ffprobe_json, generate_thumbnail,
            normalize_media_path, now_fingerprint, placeholder_waveform, sidecar_available,
        },
    },
    models::{
        AiFontResponse, AiImageResponse, AiStyleSuggestion, AiVideoResponse, AppCapabilities, DesktopBootstrap,
        EditCommandResponse, JobRecord, MediaAsset, PauseRange, ProjectSnapshot, ProjectSummary, SearchHit,
        SequenceItem, TimelinePatchRequest, TranscriptResponse, TranscriptSegment, TranscriptWord,
    },
    state::AppState,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEmbeddingResponse {
    pub embeddings: Vec<Vec<f64>>,
}

fn build_media_asset(path: &Path) -> anyhow::Result<MediaAsset> {
    let probe = ffprobe_json(path).ok();
    let duration = probe
        .as_ref()
        .and_then(|value| value["format"]["duration"].as_str())
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);

    let mut video_codec = None;
    let mut audio_codec = None;
    let mut width = None;
    let mut height = None;
    let mut has_audio = false;

    if let Some(streams) = probe.as_ref().and_then(|value| value["streams"].as_array()) {
        for stream in streams {
            match stream["codec_type"].as_str() {
                Some("video") => {
                    video_codec = stream["codec_name"].as_str().map(ToOwned::to_owned);
                    width = stream["width"].as_i64();
                    height = stream["height"].as_i64();
                }
                Some("audio") => {
                    audio_codec = stream["codec_name"].as_str().map(ToOwned::to_owned);
                    has_audio = true;
                }
                _ => {}
            }
        }
    }

    let id = Uuid::new_v4().to_string();
    let fingerprint = now_fingerprint(path)?;

    Ok(MediaAsset {
        id,
        source_path: path.to_string_lossy().to_string(),
        fingerprint: fingerprint.clone(),
        file_name: path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "Untitled".to_string()),
        duration,
        duration_ms: (duration * 1000.0).round() as i64,
        status: "ready".to_string(),
        transcript_status: "not_requested".to_string(),
        embedding_status: "not_requested".to_string(),
        transcript_segments: Vec::new(),
        pause_ranges: Vec::new(),
        embeddings_ready: false,
        waveform: placeholder_waveform(&fingerprint, 36),
        preview_path: Some(path.to_string_lossy().to_string()),
        thumbnail_path: None,
        waveform_path: None,
        proxy_path: None,
        video_codec,
        audio_codec,
        width,
        height,
        has_audio: probe.as_ref().map(|_| has_audio),
        error: None,
    })
}

fn spawn_thumbnail_generation(app: AppHandle, state: AppState, project_id: String, asset_id: String, path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let cache_dir = state.cache_dir.clone();
        let asset_id_for_thumbnail = asset_id.clone();
        let path_for_thumbnail = path.clone();

        let thumbnail_result = tauri::async_runtime::spawn_blocking(move || {
            generate_thumbnail(&cache_dir, &path_for_thumbnail, &asset_id_for_thumbnail)
        })
        .await;

        let Ok(Some(thumbnail_path)) = thumbnail_result else {
            return;
        };

        let Ok(Some(mut asset)) = state.database.load_media_asset(&asset_id) else {
            return;
        };

        asset.thumbnail_path = Some(thumbnail_path);

        if state.database.upsert_media_assets(&project_id, &[asset.clone()]).is_ok() {
            let _ = emit_entity_change(&app, "library", Some(asset.id), "updated");
        }
    });
}

fn parse_transcription_payload(asset: &MediaAsset, payload: Value) -> (Vec<TranscriptSegment>, Vec<PauseRange>) {
    let segments = payload["segments"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|segment| {
            let id = segment["id"].as_str()?.to_string();
            let start_time = segment["startTime"].as_f64().or_else(|| segment["start"].as_f64())?;
            let end_time = segment["endTime"].as_f64().or_else(|| segment["end"].as_f64())?;
            let text = segment["text"].as_str()?.to_string();
            let words = segment["words"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|word| {
                    let word_id = word["id"]
                        .as_str()
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| Uuid::new_v4().to_string());

                    Some(TranscriptWord {
                        id: word_id,
                        source_clip_id: asset.id.clone(),
                        segment_id: id.clone(),
                        text: word["text"]
                            .as_str()
                            .or_else(|| word["word"].as_str())
                            .unwrap_or_default()
                            .to_string(),
                        start_time: word["startTime"].as_f64().or_else(|| word["start"].as_f64()).unwrap_or(start_time),
                        end_time: word["endTime"].as_f64().or_else(|| word["end"].as_f64()).unwrap_or(end_time),
                        confidence: word["confidence"].as_f64().or_else(|| word["score"].as_f64()),
                        aligned: word["aligned"].as_bool().unwrap_or(true),
                        start_sample: word["startSample"].as_i64(),
                        end_sample: word["endSample"].as_i64(),
                    })
                })
                .collect::<Vec<_>>();

            Some(TranscriptSegment {
                id,
                source_clip_id: asset.id.clone(),
                start_time,
                end_time,
                text,
                word_edit_capable: words.iter().any(|word| word.aligned),
                words,
                alignment_source: payload["metadata"]["provider"].as_str().map(ToOwned::to_owned),
            })
        })
        .collect::<Vec<_>>();

    let pauses = payload["pauses"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|pause| {
            Some(PauseRange {
                id: pause["id"].as_str()?.to_string(),
                source_clip_id: asset.id.clone(),
                start_time: pause["startTime"].as_f64().or_else(|| pause["start"].as_f64())?,
                end_time: pause["endTime"].as_f64().or_else(|| pause["end"].as_f64())?,
                duration: pause["duration"].as_f64().unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();

    (segments, pauses)
}

pub async fn get_capabilities(state: &AppState) -> Result<AppCapabilities, String> {
    Ok(AppCapabilities {
        ffmpeg_available: command_available("ffmpeg", &["-version"]),
        ffprobe_available: command_available("ffprobe", &["-version"]),
        sidecar_available: sidecar_available().await,
        ai_configured: std::env::var("GEMINI_API_KEY").map(|value| !value.trim().is_empty()).unwrap_or(false),
        hardware_encoding: detect_hardware_encoding(),
        project_path: state.database.project_path().to_string_lossy().to_string(),
        cache_path: state.cache_dir.to_string_lossy().to_string(),
    })
}

pub async fn project_bootstrap(app: &AppHandle, state: &AppState) -> Result<DesktopBootstrap, String> {
    let project = state.database.load_snapshot().map_err(|error| error.to_string())?;
    let jobs = state.database.list_jobs().map_err(|error| error.to_string())?;
    let capabilities = get_capabilities(state).await?;

    emit_entity_change(app, "project", Some(project.project_id.clone()), "refreshed")?;

    Ok(DesktopBootstrap {
        project,
        jobs,
        capabilities,
    })
}

pub fn get_project(state: &AppState) -> Result<ProjectSummary, String> {
    state.database.load_project_summary().map_err(|error| error.to_string())
}

pub fn get_snapshot(state: &AppState) -> Result<ProjectSnapshot, String> {
    state.database.load_snapshot().map_err(|error| error.to_string())
}

pub fn list_library(state: &AppState) -> Result<Vec<MediaAsset>, String> {
    let project = state.database.load_project_summary().map_err(|error| error.to_string())?;
    state.database.load_media_assets(&project.project_id).map_err(|error| error.to_string())
}

pub fn get_timeline(state: &AppState) -> Result<Vec<SequenceItem>, String> {
    let project = state.database.load_project_summary().map_err(|error| error.to_string())?;
    state.database.load_sequence_items(&project.project_id).map_err(|error| error.to_string())
}

pub fn get_transcript(state: &AppState, asset_id: String) -> Result<MediaAsset, String> {
    state
        .database
        .load_media_asset(&asset_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Media asset not found".to_string())
}

pub fn list_jobs(state: &AppState) -> Result<Vec<JobRecord>, String> {
    state.database.list_jobs().map_err(|error| error.to_string())
}

pub fn import_media_paths(app: &AppHandle, state: &AppState, paths: Vec<String>) -> Result<Vec<MediaAsset>, String> {
    let project = state.database.load_project_summary().map_err(|error| error.to_string())?;
    let mut imported = Vec::new();

    for raw_path in paths {
        let path = normalize_media_path(&raw_path).map_err(|error| error.to_string())?;
        let asset = build_media_asset(&path).map_err(|error| error.to_string())?;
        state
            .database
            .upsert_media_assets(&project.project_id, &[asset.clone()])
            .map_err(|error| error.to_string())?;
        imported.push(asset.clone());
        emit_entity_change(app, "library", Some(asset.id.clone()), "created")?;
        spawn_thumbnail_generation(
            app.clone(),
            state.clone(),
            project.project_id.clone(),
            asset.id.clone(),
            path,
        );
    }

    Ok(imported)
}

pub fn remove_library_asset(app: &AppHandle, state: &AppState, asset_id: String) -> Result<(), String> {
    let project = state.database.load_project_summary().map_err(|error| error.to_string())?;
    let removed = state
        .database
        .remove_media_asset(&project.project_id, &asset_id)
        .map_err(|error| error.to_string())?;

    if !removed {
        return Err("Media asset not found".to_string());
    }

    emit_entity_change(app, "library", Some(asset_id), "deleted")?;
    emit_entity_change(app, "timeline", None, "updated")?;
    Ok(())
}

pub fn apply_timeline_patch(
    app: &AppHandle,
    state: &AppState,
    patch: TimelinePatchRequest,
) -> Result<Vec<SequenceItem>, String> {
    let project = state.database.load_project_summary().map_err(|error| error.to_string())?;

    match patch.kind.as_str() {
        "replace_clips" => {
            state
                .database
                .replace_sequence_items(&project.project_id, &patch.clips)
                .map_err(|error| error.to_string())?;
            emit_entity_change(app, "timeline", Some(project.project_id), "updated")?;
            Ok(patch.clips)
        }
        _ => Err(format!("Unsupported timeline patch kind: {}", patch.kind)),
    }
}

pub fn search_query(state: &AppState, query: String) -> Result<Vec<SearchHit>, String> {
    let snapshot = state.database.load_snapshot().map_err(|error| error.to_string())?;
    let tokens = query
        .to_lowercase()
        .split_whitespace()
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();

    if tokens.is_empty() {
        return Ok(Vec::new());
    }

    let mut hits = snapshot
        .media_assets
        .iter()
        .flat_map(|asset| asset.transcript_segments.iter())
        .filter_map(|segment| {
            let normalized = segment.text.to_lowercase();
            let score = tokens
                .iter()
                .fold(0.0, |value, token| value + if normalized.contains(token) { 1.0 } else { 0.0 })
                / tokens.len() as f64;

            if score > 0.0 {
                Some(SearchHit {
                    id: segment.id.clone(),
                    source_clip_id: segment.source_clip_id.clone(),
                    score,
                })
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    hits.sort_by(|left, right| right.score.total_cmp(&left.score));
    Ok(hits)
}

pub async fn transcript_run_direct(
    app: &AppHandle,
    state: &AppState,
    asset_id: String,
) -> Result<TranscriptResponse, String> {
    let project = state.database.load_project_summary().map_err(|error| error.to_string())?;
    let mut asset = state
        .database
        .load_media_asset(&asset_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Media asset not found".to_string())?;

    let job = create_job(
        "transcript",
        Some("library"),
        &asset_id,
        Some(json!({ "assetId": asset_id.clone() })),
        None,
    );
    let running_job = mark_job_running(&job, 0.1, Some("Uploading media to transcription provider".to_string()));
    emit_job_update(app, &state.database, &running_job)?;

    let payload = request_transcription(asset.source_path.clone(), asset.file_name.clone()).await?;
    let (segments, pauses) = parse_transcription_payload(&asset, payload);

    asset.transcript_segments = segments;
    asset.pause_ranges = pauses;
    asset.status = "alignment_ready".to_string();
    asset.transcript_status = "alignment_ready".to_string();
    asset.error = None;

    if state
        .database
        .load_media_asset(&asset_id)
        .map_err(|error| error.to_string())?
        .is_none()
    {
        return Err("Media asset was removed before transcription completed".to_string());
    }

    state
        .database
        .upsert_media_assets(&project.project_id, &[asset.clone()])
        .map_err(|error| error.to_string())?;
    emit_entity_change(app, "transcript", Some(asset.id.clone()), "updated")?;
    emit_entity_change(app, "library", Some(asset.id.clone()), "updated")?;

    let complete_job = mark_job_complete(
        &running_job,
        Some("Transcript and alignment ready".to_string()),
        Some(json!({ "assetId": asset.id.clone() })),
    );
    emit_job_update(app, &state.database, &complete_job)?;

    Ok(TranscriptResponse {
        asset,
        jobs: state.database.list_jobs().map_err(|error| error.to_string())?,
    })
}

pub fn enqueue_transcript(app: AppHandle, state: AppState, asset_id: String) -> Result<JobRecord, String> {
    if let Some(job) = state
        .database
        .find_active_job("transcript", &asset_id)
        .map_err(|error| error.to_string())?
    {
        return Ok(job);
    }

    if let Ok(project) = state.database.load_project_summary() {
        if let Ok(Some(mut asset)) = state.database.load_media_asset(&asset_id) {
            asset.status = "processing".to_string();
            asset.transcript_status = "processing".to_string();
            asset.error = None;
            let _ = state.database.upsert_media_assets(&project.project_id, &[asset]);
            let _ = emit_entity_change(&app, "library", Some(asset_id.clone()), "updated");
        }
    }

    let initial_job = create_job(
        "transcript",
        Some("library"),
        &asset_id,
        Some(json!({ "assetId": asset_id.clone() })),
        None,
    );
    emit_job_update(&app, &state.database, &initial_job)?;

    let app_handle = app.clone();
    let queued_job = initial_job.clone();
    tauri::async_runtime::spawn(async move {
        let running_job = mark_job_running(&queued_job, 0.1, Some("Uploading media to transcription provider".to_string()));
        let _ = emit_job_update(&app_handle, &state.database, &running_job);

        let result = async {
            let project = state.database.load_project_summary().map_err(|error| error.to_string())?;
            let mut asset = state
                .database
                .load_media_asset(&asset_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "Media asset not found".to_string())?;

            let payload = request_transcription(asset.source_path.clone(), asset.file_name.clone()).await?;
            let (segments, pauses) = parse_transcription_payload(&asset, payload);

            asset.transcript_segments = segments;
            asset.pause_ranges = pauses;
            asset.status = "alignment_ready".to_string();
            asset.transcript_status = "alignment_ready".to_string();
            asset.error = None;

            if state
                .database
                .load_media_asset(&asset_id)
                .map_err(|error| error.to_string())?
                .is_none()
            {
                return Err("Media asset was removed before transcription completed".to_string());
            }

            state
                .database
                .upsert_media_assets(&project.project_id, &[asset.clone()])
                .map_err(|error| error.to_string())?;
            emit_entity_change(&app_handle, "transcript", Some(asset.id.clone()), "updated")?;
            emit_entity_change(&app_handle, "library", Some(asset.id.clone()), "updated")?;

            Ok::<MediaAsset, String>(asset)
        }
        .await;

        match result {
            Ok(asset) => {
                let complete_job = mark_job_complete(
                    &running_job,
                    Some("Transcript and alignment ready".to_string()),
                    Some(json!({ "assetId": asset.id })),
                );
                let _ = emit_job_update(&app_handle, &state.database, &complete_job);
            }
            Err(error) => {
                if let Ok(project) = state.database.load_project_summary() {
                    if let Ok(Some(mut asset)) = state.database.load_media_asset(&asset_id) {
                        asset.status = "error".to_string();
                        asset.transcript_status = "error".to_string();
                        asset.error = Some(error.clone());
                        let _ = state.database.upsert_media_assets(&project.project_id, &[asset]);
                        let _ = emit_entity_change(&app_handle, "library", Some(asset_id.clone()), "updated");
                    }
                }

                let error_job = mark_job_error(&running_job, error);
                let _ = emit_job_update(&app_handle, &state.database, &error_job);
            }
        }
    });

    Ok(initial_job)
}

pub fn enqueue_export(
    app: AppHandle,
    state: AppState,
    clips: Vec<SequenceItem>,
    output_path: String,
) -> Result<JobRecord, String> {
    if let Some(job) = state
        .database
        .find_active_job("export", &output_path)
        .map_err(|error| error.to_string())?
    {
        return Ok(job);
    }

    let job = create_job(
        "export",
        Some("timeline"),
        &output_path,
        Some(json!({ "outputPath": output_path.clone(), "clipCount": clips.len() })),
        None,
    );
    emit_job_update(&app, &state.database, &job)?;

    let app_handle = app.clone();
    let queued_job = job.clone();
    tauri::async_runtime::spawn(async move {
        let running_job = mark_job_running(&queued_job, 0.1, Some("Building export graph...".to_string()));
        let _ = emit_job_update(&app_handle, &state.database, &running_job);

        match export_timeline_internal(&app_handle, &state, clips, output_path.clone(), &running_job).await {
            Ok(path) => {
                let complete_job = mark_job_complete(
                    &running_job,
                    Some("Export complete".to_string()),
                    Some(json!({ "outputPath": path })),
                );
                let _ = emit_job_update(&app_handle, &state.database, &complete_job);
            }
            Err(error) => {
                let error_job = mark_job_error(&running_job, error);
                let _ = emit_job_update(&app_handle, &state.database, &error_job);
            }
        }
    });

    Ok(job)
}

async fn export_timeline_internal(
    app: &AppHandle,
    state: &AppState,
    clips: Vec<SequenceItem>,
    output_path: String,
    job: &JobRecord,
) -> Result<String, String> {
    if !command_available("ffmpeg", &["-version"]) {
        return Err("ffmpeg is not available".to_string());
    }

    let snapshot = state.database.load_snapshot().map_err(|error| error.to_string())?;
    let video_clips: Vec<_> = clips.iter().filter(|clip| clip.r#type == "video").collect();
    if video_clips.is_empty() {
        return Err("No video clips to export".to_string());
    }

    let first_source = video_clips[0]
        .source_clip_id
        .as_deref()
        .or(video_clips[0].media_id.as_deref())
        .and_then(|id| snapshot.media_assets.iter().find(|asset| asset.id == id));

    let (out_w, out_h) = first_source
        .and_then(|asset| asset.width.zip(asset.height))
        .unwrap_or((1280, 720));

    let mut args: Vec<String> = vec!["-y".to_string()];
    let mut filter_parts: Vec<String> = Vec::new();
    let mut concat_inputs: Vec<String> = Vec::new();
    let mut input_idx: usize = 0;
    let mut filter_idx: usize = 0;
    let mut source_input_map: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for clip in &clips {
        if clip.r#type == "video" {
            let source_id = clip.source_clip_id.as_deref().or(clip.media_id.as_deref()).unwrap_or("");
            if !source_input_map.contains_key(source_id) {
                let asset = snapshot.media_assets.iter().find(|item| item.id == source_id);
                if let Some(asset) = asset {
                    args.extend(["-i".to_string(), asset.source_path.clone()]);
                    source_input_map.insert(source_id.to_string(), input_idx);
                    input_idx += 1;
                }
            }
        }
    }

    let temp_dir = state.cache_dir.join("export_tmp");
    let _ = fs::create_dir_all(&temp_dir);

    for clip in &clips {
        if clip.r#type == "video" {
            let source_id = clip.source_clip_id.as_deref().or(clip.media_id.as_deref()).unwrap_or("");
            let asset = snapshot
                .media_assets
                .iter()
                .find(|item| item.id == source_id)
                .ok_or_else(|| format!("Missing media asset for clip {}", clip.id))?;
            let src_idx = *source_input_map
                .get(source_id)
                .ok_or_else(|| format!("Missing source input for clip {}", clip.id))?;

            let v_label = format!("v{filter_idx}");
            let a_label = format!("a{filter_idx}");

            filter_parts.push(format!(
                "[{src_idx}:v]trim=start={start}:end={end},setpts=PTS-STARTPTS,scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2[{v_label}]",
                start = clip.source_start_time,
                end = clip.source_end_time,
            ));

            if asset.has_audio.unwrap_or(false) {
                filter_parts.push(format!(
                    "[{src_idx}:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS[{a_label}]",
                    start = clip.source_start_time,
                    end = clip.source_end_time,
                ));
            } else {
                filter_parts.push(format!(
                    "anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:{dur}[{a_label}]",
                    dur = clip.duration,
                ));
            }

            concat_inputs.push(format!("[{v_label}][{a_label}]"));
            filter_idx += 1;
        } else if clip.r#type == "image" {
            if let Some(ref img_src) = clip.image_src {
                let img_path = temp_dir.join(format!("img_{filter_idx}.png"));

                if img_src.starts_with("data:") {
                    if let Some(b64) = img_src.split(";base64,").nth(1) {
                        if let Ok(bytes) = base64_decode(b64) {
                            let _ = fs::write(&img_path, bytes);
                        }
                    }
                } else {
                    let _ = fs::copy(img_src, &img_path);
                }

                args.extend([
                    "-loop".to_string(),
                    "1".to_string(),
                    "-t".to_string(),
                    clip.duration.to_string(),
                    "-i".to_string(),
                    img_path.to_string_lossy().to_string(),
                ]);

                let v_label = format!("v{filter_idx}");
                let a_label = format!("a{filter_idx}");

                filter_parts.push(format!(
                    "[{input_idx}:v]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS[{v_label}]"
                ));
                filter_parts.push(format!(
                    "anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:{dur}[{a_label}]",
                    dur = clip.duration,
                ));

                concat_inputs.push(format!("[{v_label}][{a_label}]"));
                input_idx += 1;
                filter_idx += 1;
            }
        }
    }

    if filter_idx == 0 {
        return Err("No valid clips to export".to_string());
    }

    filter_parts.push(format!("{}concat=n={filter_idx}:v=1:a=1[outv][outa]", concat_inputs.join("")));

    let hw_encoders = detect_hardware_encoding();
    let (video_encoder, extra_args): (&str, Vec<&str>) = if hw_encoders.contains(&"h264_videotoolbox".to_string()) {
        ("h264_videotoolbox", vec!["-q:v", "65"])
    } else if hw_encoders.contains(&"h264_nvenc".to_string()) {
        ("h264_nvenc", vec!["-preset", "p4", "-cq", "23"])
    } else {
        ("libx264", vec!["-preset", "fast", "-crf", "23"])
    };

    let encoding_job = mark_job_running(job, 0.3, Some(format!("Encoding with {video_encoder}...")));
    emit_job_update(app, &state.database, &encoding_job)?;

    args.extend([
        "-filter_complex".to_string(),
        filter_parts.join(";"),
        "-map".to_string(),
        "[outv]".to_string(),
        "-map".to_string(),
        "[outa]".to_string(),
        "-c:v".to_string(),
        video_encoder.to_string(),
    ]);
    args.extend(extra_args.iter().map(|value| value.to_string()));
    args.extend([
        "-c:a".to_string(),
        "aac".to_string(),
        output_path.clone(),
    ]);

    let output = Command::new("ffmpeg")
        .args(&args)
        .output()
        .map_err(|error| format!("ffmpeg exec failed: {error}"))?;

    let _ = fs::remove_dir_all(&temp_dir);

    if !output.status.success() {
        return Err(format!("ffmpeg export failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    Ok(output_path)
}

pub async fn export_timeline_direct(
    app: &AppHandle,
    state: &AppState,
    clips: Vec<SequenceItem>,
    output_path: String,
) -> Result<String, String> {
    let job = create_job(
        "export",
        Some("timeline"),
        &output_path,
        Some(json!({ "outputPath": output_path.clone(), "clipCount": clips.len() })),
        None,
    );
    let running_job = mark_job_running(&job, 0.1, Some("Building export graph...".to_string()));
    emit_job_update(app, &state.database, &running_job)?;
    match export_timeline_internal(app, state, clips, output_path, &running_job).await {
        Ok(path) => {
            let complete = mark_job_complete(&running_job, Some("Export complete".to_string()), Some(json!({ "outputPath": path.clone() })));
            emit_job_update(app, &state.database, &complete)?;
            Ok(path)
        }
        Err(error) => {
            let failed = mark_job_error(&running_job, error.clone());
            emit_job_update(app, &state.database, &failed)?;
            Err(error)
        }
    }
}

pub fn merge_videos(app: &AppHandle, state: &AppState, input_paths: Vec<String>, output_path: String) -> Result<String, String> {
    if !command_available("ffmpeg", &["-version"]) {
        return Err("ffmpeg is not available".to_string());
    }

    let job = create_job(
        "merge",
        Some("library"),
        &output_path,
        Some(json!({ "outputPath": output_path.clone(), "inputCount": input_paths.len() })),
        None,
    );
    let running_job = mark_job_running(&job, 0.2, Some("Merging videos...".to_string()));
    emit_job_update(app, &state.database, &running_job)?;

    let temp_dir = state.cache_dir.join("merge_tmp");
    let _ = fs::create_dir_all(&temp_dir);
    let concat_file = temp_dir.join("concat.txt");

    let concat_content: String = input_paths
        .iter()
        .map(|path| format!("file '{}'\n", path.replace('\'', "'\\''")))
        .collect();

    fs::write(&concat_file, &concat_content).map_err(|error| error.to_string())?;

    let output = Command::new("ffmpeg")
        .args([
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            &concat_file.to_string_lossy(),
            "-c",
            "copy",
            &output_path,
        ])
        .output()
        .map_err(|error| format!("ffmpeg exec failed: {error}"))?;

    let _ = fs::remove_dir_all(&temp_dir);

    if !output.status.success() {
        let error = format!("ffmpeg merge failed: {}", String::from_utf8_lossy(&output.stderr));
        let failed = mark_job_error(&running_job, error.clone());
        emit_job_update(app, &state.database, &failed)?;
        return Err(error);
    }

    let complete = mark_job_complete(&running_job, Some("Merge complete".to_string()), Some(json!({ "outputPath": output_path.clone() })));
    emit_job_update(app, &state.database, &complete)?;
    Ok(output_path)
}

pub fn ai_status() -> Value {
    json!({
        "configured": std::env::var("GEMINI_API_KEY").map(|value| !value.trim().is_empty()).unwrap_or(false)
    })
}

pub fn enqueue_ai_edit(app: AppHandle, state: AppState, command: String, transcript: Value, timeline: Value, pauses: Value) -> Result<JobRecord, String> {
    let target_id = Uuid::new_v4().to_string();
    let job = create_job(
        "ai.edit",
        Some("timeline"),
        &target_id,
        Some(json!({
            "command": command,
            "transcriptSegmentCount": transcript.as_array().map(|items| items.len()).unwrap_or(0),
            "timelineClipCount": timeline.as_array().map(|items| items.len()).unwrap_or(0),
        })),
        None,
    );
    emit_job_update(&app, &state.database, &job)?;

    let app_handle = app.clone();
    let queued_job = job.clone();
    tauri::async_runtime::spawn(async move {
        let running_job = mark_job_running(&queued_job, 0.2, Some("Planning AI edit...".to_string()));
        let _ = emit_job_update(&app_handle, &state.database, &running_job);

        match ai_edit_command(command, transcript, timeline, pauses).await {
            Ok(response) => {
                let complete_job = mark_job_complete(
                    &running_job,
                    Some("AI edit plan ready".to_string()),
                    Some(json!({
                        "operations": response.operations,
                        "explanation": response.explanation,
                    })),
                );
                let _ = emit_job_update(&app_handle, &state.database, &complete_job);
            }
            Err(error) => {
                let error_job = mark_job_error(&running_job, error);
                let _ = emit_job_update(&app_handle, &state.database, &error_job);
            }
        }
    });

    Ok(job)
}

pub async fn ai_generate_image(
    prompt: String,
    reference_base64: Option<String>,
    reference_mime: Option<String>,
) -> Result<AiImageResponse, String> {
    let mut parts = vec![];

    if let Some(reference_data) = &reference_base64 {
        let clean = reference_data.split(";base64,").nth(1).unwrap_or(reference_data);
        let mime = reference_mime
            .as_deref()
            .or_else(|| reference_data.split(';').next().map(|value| value.trim_start_matches("data:")))
            .unwrap_or("image/jpeg");

        parts.push(json!({
            "inlineData": {
                "data": clean,
                "mimeType": mime
            }
        }));
        parts.push(json!({
            "text": format!("Analyze the visual style of this reference image. Create a NEW high-resolution cinematic image based on: {prompt}. The image should match the reference's color palette and atmosphere.")
        }));
    } else {
        parts.push(json!({
            "text": format!("A hyper-realistic, cinematic, high-resolution image: {prompt}. Dramatic lighting, detailed texture, 8k resolution.")
        }));
    }

    let body = json!({
        "contents": [{ "role": "user", "parts": parts }],
        "generationConfig": {
            "responseModalities": ["IMAGE"]
        }
    });

    let response = gemini_generate_content(gemini_image_model(), body).await?;
    let candidates = response["candidates"].as_array().ok_or("No candidates in response")?;

    for candidate in candidates {
        if let Some(parts) = candidate["content"]["parts"].as_array() {
            for part in parts {
                if let Some(inline) = part.get("inlineData") {
                    return Ok(AiImageResponse {
                        image_base64: inline["data"].as_str().unwrap_or("").to_string(),
                        mime_type: inline["mimeType"].as_str().unwrap_or("image/png").to_string(),
                    });
                }
            }
        }
    }

    Err("No image generated in response".to_string())
}

pub async fn ai_style_suggestions(text: String, reference_image: Option<String>) -> Result<Vec<AiStyleSuggestion>, String> {
    let mut parts = vec![];

    let prompt = if reference_image.is_some() {
        format!(
            "Analyze this image and generate THREE distinct descriptions for a cinematic text animation of the word/phrase: \"{text}\". \
             Each styling must match the material, lighting, and environment of this frame but offer a different creative interpretation."
        )
    } else {
        format!(
            "Generate THREE distinct descriptions for a cinematic text animation of the word/phrase: \"{text}\". \
             Focus on material, lighting, and environment. Give each one a unique artistic flavor."
        )
    };

    parts.push(json!({
        "text": format!("{prompt}\n\nReturn the response strictly as a JSON array of THREE objects:\n[\n  {{\n    \"style\": \"A short (10-15 words) description of the visual atmosphere and environment\",\n    \"typography\": \"A short (10-15 words) description of how the text itself should look\"\n  }}\n]")
    }));

    if let Some(reference_data) = &reference_image {
        let clean = reference_data.split(";base64,").nth(1).unwrap_or(reference_data);
        let mime = reference_data
            .split(';')
            .next()
            .map(|value| value.trim_start_matches("data:"))
            .unwrap_or("image/jpeg");

        parts.push(json!({
            "inlineData": { "data": clean, "mimeType": mime }
        }));
    }

    let body = json!({
        "contents": [{ "role": "user", "parts": parts }],
        "generationConfig": {
            "responseMimeType": "application/json"
        }
    });

    let response = gemini_generate_content(gemini_reasoning_model(), body).await?;
    let text = extract_text_from_response(&response);
    let parsed = clean_json_response(&text);

    Ok(parsed
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(AiStyleSuggestion {
                        style: item["style"].as_str()?.to_string(),
                        typography: item["typography"].as_str()?.to_string(),
                    })
                })
                .take(3)
                .collect()
        })
        .unwrap_or_default())
}

pub async fn ai_generate_video(
    app: &AppHandle,
    state: &AppState,
    prompt: String,
    image_base64: String,
    image_mime_type: String,
) -> Result<AiVideoResponse, String> {
    let job = create_job("ai.video", Some("artifact"), "video-gen", Some(json!({ "prompt": prompt })), None);
    let running_job = mark_job_running(&job, 0.1, Some("Starting video generation...".to_string()));
    emit_job_update(app, &state.database, &running_job)?;

    let clean_image = image_base64.split(";base64,").nth(1).unwrap_or(&image_base64);
    let body = json!({
        "instances": [{
            "prompt": format!("Cinematic animation. {prompt}. High quality, 8k, smooth motion."),
            "image": {
                "bytesBase64Encoded": clean_image,
                "mimeType": image_mime_type
            }
        }],
        "parameters": {
            "sampleCount": 1,
            "aspectRatio": "16:9"
        }
    });

    let operation = gemini_generate_videos(body).await?;
    let operation_name = operation["name"].as_str().ok_or("No operation name in response")?;
    let polling_job = mark_job_running(&running_job, 0.3, Some("Polling for video completion...".to_string()));
    emit_job_update(app, &state.database, &polling_job)?;

    let result = poll_video_operation(operation_name).await?;
    let video_uri = result["response"]["generatedVideos"][0]["video"]["uri"]
        .as_str()
        .ok_or("No video URI in completed operation")?;
    let download_job = mark_job_running(&polling_job, 0.8, Some("Downloading generated video...".to_string()));
    emit_job_update(app, &state.database, &download_job)?;

    let bytes = fetch_video_bytes(video_uri).await?;
    let gen_dir = state.cache_dir.join("generated");
    fs::create_dir_all(&gen_dir).map_err(|error| format!("Failed to create cache dir: {error}"))?;
    let output_path = gen_dir.join(format!("{}.mp4", Uuid::new_v4()));
    fs::write(&output_path, &bytes).map_err(|error| format!("Failed to write video: {error}"))?;

    let complete = mark_job_complete(
        &download_job,
        Some("Video generation complete".to_string()),
        Some(json!({ "videoPath": output_path.to_string_lossy().to_string() })),
    );
    emit_job_update(app, &state.database, &complete)?;

    Ok(AiVideoResponse {
        video_path: output_path.to_string_lossy().to_string(),
    })
}

pub async fn ai_generate_transition(
    app: &AppHandle,
    state: &AppState,
    last_frame_base64: String,
    start_frame_base64: Option<String>,
    description: Option<String>,
) -> Result<AiVideoResponse, String> {
    let job = create_job("ai.transition", Some("artifact"), "transition-gen", None, None);
    let running_job = mark_job_running(&job, 0.1, Some("Preparing transition...".to_string()));
    emit_job_update(app, &state.database, &running_job)?;

    let transition_desc = if let Some(description) = description.filter(|value| !value.trim().is_empty()) {
        description
    } else if let Some(ref start_frame) = start_frame_base64 {
        let clean = start_frame.split(";base64,").nth(1).unwrap_or(start_frame);
        let body = json!({
            "contents": [{
                "role": "user",
                "parts": [
                    { "text": "Describe this scene in one vivid, cinematic sentence. Focus on textures, lighting, and core subjects." },
                    { "inlineData": { "data": clean, "mimeType": "image/png" } }
                ]
            }]
        });
        let response = gemini_generate_content(gemini_reasoning_model(), body).await?;
        extract_text_from_response(&response)
    } else {
        "A cinematic evolution of the scene.".to_string()
    };

    let clean_last = last_frame_base64.split(";base64,").nth(1).unwrap_or(&last_frame_base64);
    let body = json!({
        "instances": [{
            "prompt": format!(
                "Cinematic transition morphing from the starting scene into: {transition_desc}. Smooth motion, dream-like evolve animation, high quality, 8k."
            ),
            "image": {
                "bytesBase64Encoded": clean_last,
                "mimeType": "image/png"
            }
        }],
        "parameters": {
            "sampleCount": 1,
            "aspectRatio": "16:9"
        }
    });

    let operation = gemini_generate_videos(body).await?;
    let operation_name = operation["name"].as_str().ok_or("No operation name in response")?;
    let generating_job = mark_job_running(&running_job, 0.4, Some("Generating transition video...".to_string()));
    emit_job_update(app, &state.database, &generating_job)?;

    let result = poll_video_operation(operation_name).await?;
    let video_uri = result["response"]["generatedVideos"][0]["video"]["uri"]
        .as_str()
        .ok_or("No video URI in transition result")?;
    let bytes = fetch_video_bytes(video_uri).await?;

    let gen_dir = state.cache_dir.join("generated");
    fs::create_dir_all(&gen_dir).map_err(|error| error.to_string())?;
    let output_path = gen_dir.join(format!("transition_{}.mp4", Uuid::new_v4()));
    fs::write(&output_path, &bytes).map_err(|error| error.to_string())?;

    let complete = mark_job_complete(
        &generating_job,
        Some("Transition complete".to_string()),
        Some(json!({ "videoPath": output_path.to_string_lossy().to_string() })),
    );
    emit_job_update(app, &state.database, &complete)?;

    Ok(AiVideoResponse {
        video_path: output_path.to_string_lossy().to_string(),
    })
}

pub async fn ai_edit_command(command: String, transcript: Value, timeline: Value, pauses: Value) -> Result<EditCommandResponse, String> {
    let system_prompt = r#"You are a video editing AI assistant. Interpret the user's natural language request and convert it into structured sequence operations.

The sequence can contain multiple source clips. Every transcript segment and pause range includes a sourceClipId. Every timeline clip includes its sequence index and the source clip/time window it uses.

PAUSE RANGES: Each pause range has { id, sourceClipId, startTime, endTime, duration }. These are machine-detected silences in the audio. Use them directly when the user asks to remove pauses, silence, or dead air.

TAKES: A "take" is a repeated attempt at the same content. Identify takes by looking for repeated or similar phrases in the transcript segments. "First take", "second take", etc. refers to these repetitions in order.

Available operation types:
- "remove_time_range": remove a time window from a specific source clip. Must include sourceClipId, startTime, endTime. Use for removing pauses (use pause range times), filler words, or unwanted segments.
- "keep_only_ranges": rebuild the sequence keeping only the specified source ranges. Must include a ranges array of {sourceClipId, startTime, endTime}. Use when the user wants to keep a specific take or section.
- "insert_image": generate a still image and insert it after a sequence time. Must include prompt, afterTime, duration.
- "reorder": move an existing sequence item by index. Must include fromIndex and toIndex.

Return ONLY valid JSON with this shape:
{
  "operations": [
    {"type": "remove_time_range", "sourceClipId": "string", "startTime": number, "endTime": number, "reason": "string"},
    {"type": "keep_only_ranges", "ranges": [{"sourceClipId": "string", "startTime": number, "endTime": number}], "reason": "string"},
    {"type": "insert_image", "afterTime": number, "prompt": "string", "duration": number, "reason": "string"},
    {"type": "reorder", "fromIndex": number, "toIndex": number, "reason": "string"}
  ],
  "explanation": "brief description of what will be done"
}

Rules:
- For "remove pauses" / "remove silence" / "tighten" / "snappy": emit one remove_time_range operation per pause range.
- For "keep the Nth take" / "use take N": use keep_only_ranges with the time window of that take.
- For "remove filler words" (um, uh, like, you know): emit remove_time_range for each filler word's time window from the transcript.
- Be conservative and preserve meaning unless the user explicitly asks for aggressive edits.
- Prefer the smallest set of operations that satisfies the request.
- Use reorder only when the user clearly wants sequence order changed.
- Always ground operations in sourceClipId + timestamps from the provided data.
- Do not return markdown fences or any extra prose."#;

    let pauses_json = serde_json::to_string_pretty(&pauses).unwrap_or_default();
    let user_message = format!(
        "{system_prompt}\n\nCurrent transcript segments:\n{}\n\nDetected pause ranges:\n{}\n\nCurrent timeline clips:\n{}\n\nUser command: \"{command}\"",
        serde_json::to_string_pretty(&transcript).unwrap_or_default(),
        pauses_json,
        serde_json::to_string_pretty(&timeline).unwrap_or_default(),
    );

    let body = json!({
        "contents": [{
            "role": "user",
            "parts": [{ "text": user_message }]
        }]
    });

    let response = gemini_generate_content(gemini_reasoning_model(), body).await?;
    let text = extract_text_from_response(&response);
    let parsed = clean_json_response(&text);

    if parsed.is_null() {
        return Err(format!("Failed to parse AI response as JSON: {text}"));
    }

    Ok(EditCommandResponse {
        operations: parsed["operations"].as_array().cloned().unwrap_or_default(),
        explanation: parsed["explanation"].as_str().unwrap_or("Edit applied").to_string(),
    })
}

pub async fn ai_generate_font(image_base64: String) -> Result<AiFontResponse, String> {
    let clean = image_base64.split(";base64,").nth(1).unwrap_or(&image_base64);
    let body = json!({
        "contents": [{
            "role": "user",
            "parts": [
                { "text": "Analyze this video frame and generate a highly thematic typography style perfectly suited to its visual vibe, aesthetic, texture, and content. You MUST select a valid Google Font name that strongly matches the physical feeling of the content. Return a suggested Google Font name, a complementary text color (hex code), a CSS text-shadow value, and an advanced CSS cssFilter to complete the effect. Provide the response strictly as a JSON object with the keys: fontFamily (exact Google Font name), color (hex code), textShadow (CSS text-shadow string), cssFilter (CSS filter string or none)." },
                { "inlineData": { "data": clean, "mimeType": "image/jpeg" } }
            ]
        }],
        "generationConfig": {
            "responseMimeType": "application/json"
        }
    });

    let response = gemini_generate_content(gemini_reasoning_model(), body).await?;
    let text = extract_text_from_response(&response);
    let parsed = clean_json_response(&text);

    Ok(AiFontResponse {
        font_family: parsed["fontFamily"].as_str().unwrap_or("Inter").to_string(),
        color: parsed["color"].as_str().unwrap_or("#FFFFFF").to_string(),
        text_shadow: parsed["textShadow"]
            .as_str()
            .unwrap_or("0px 0px 8px rgba(0,0,0,0.8)")
            .to_string(),
        css_filter: parsed["cssFilter"].as_str().unwrap_or("none").to_string(),
    })
}

pub async fn ai_generate_embeddings(texts: Vec<String>) -> Result<AiEmbeddingResponse, String> {
    let response = gemini_batch_embed(embedding_request_body(texts)).await?;
    let embeddings = response["embeddings"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|embedding| {
                    embedding["values"]
                        .as_array()
                        .map(|values| values.iter().filter_map(|value| value.as_f64()).collect())
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(AiEmbeddingResponse { embeddings })
}
