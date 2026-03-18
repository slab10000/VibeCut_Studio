use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWord {
    pub id: String,
    pub source_clip_id: String,
    pub segment_id: String,
    pub text: String,
    pub start_time: f64,
    pub end_time: f64,
    pub confidence: Option<f64>,
    pub aligned: bool,
    pub start_sample: Option<i64>,
    pub end_sample: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub source_clip_id: String,
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
    pub words: Vec<TranscriptWord>,
    pub alignment_source: Option<String>,
    pub word_edit_capable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseRange {
    pub id: String,
    pub source_clip_id: String,
    pub start_time: f64,
    pub end_time: f64,
    pub duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    pub source_path: String,
    pub fingerprint: String,
    pub file_name: String,
    pub duration: f64,
    pub duration_ms: i64,
    pub status: String,
    pub transcript_status: String,
    pub embedding_status: String,
    pub transcript_segments: Vec<TranscriptSegment>,
    pub pause_ranges: Vec<PauseRange>,
    pub embeddings_ready: bool,
    pub waveform: Vec<f64>,
    pub preview_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub waveform_path: Option<String>,
    pub proxy_path: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub has_audio: Option<bool>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceEffect {
    pub id: String,
    pub effect_type: String,
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceItem {
    pub id: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub source_clip_id: Option<String>,
    pub source_start_time: f64,
    pub source_end_time: f64,
    pub duration: f64,
    pub label: Option<String>,
    pub image_src: Option<String>,
    pub sequence_id: Option<String>,
    pub track: i64,
    pub timeline_start_ms: i64,
    pub duration_ms: i64,
    pub media_id: Option<String>,
    pub source_in_ms: i64,
    pub playback_rate: f64,
    pub enabled: bool,
    pub kind: String,
    pub effects: Vec<SequenceEffect>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub project_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub project_id: String,
    pub name: String,
    pub media_assets: Vec<MediaAsset>,
    pub sequence_items: Vec<SequenceItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub id: String,
    pub kind: String,
    pub target_kind: Option<String>,
    pub target_id: String,
    pub status: String,
    pub progress: f64,
    pub message: Option<String>,
    pub payload: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
    pub error_message: Option<String>,
    pub fingerprint: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityChangeEvent {
    pub entity_type: String,
    pub entity_id: Option<String>,
    pub operation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePatchRequest {
    pub kind: String,
    pub clips: Vec<SequenceItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCapabilities {
    pub ffmpeg_available: bool,
    pub ffprobe_available: bool,
    pub sidecar_available: bool,
    pub ai_configured: bool,
    pub hardware_encoding: Vec<String>,
    pub project_path: String,
    pub cache_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBootstrap {
    pub project: ProjectSnapshot,
    pub jobs: Vec<JobRecord>,
    pub capabilities: AppCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptResponse {
    pub asset: MediaAsset,
    pub jobs: Vec<JobRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub source_clip_id: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditCommandResponse {
    pub operations: Vec<serde_json::Value>,
    pub explanation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiImageResponse {
    pub image_base64: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStyleSuggestion {
    pub style: String,
    pub typography: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiVideoResponse {
    pub video_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFontResponse {
    pub font_family: String,
    pub color: String,
    pub text_shadow: String,
    pub css_filter: String,
}
