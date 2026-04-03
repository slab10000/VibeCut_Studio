use tauri::{AppHandle, State};

use crate::{
    application::workflows,
    models::{AppCapabilities, DesktopBootstrap, MediaAsset, SearchHit, SequenceItem, TranscriptResponse},
    state::AppState,
};

#[tauri::command]
pub async fn project_bootstrap(app: AppHandle, state: State<'_, AppState>) -> Result<DesktopBootstrap, String> {
    workflows::project_bootstrap(&app, &state).await
}

#[tauri::command]
pub fn project_get_snapshot(state: State<'_, AppState>) -> Result<crate::models::ProjectSnapshot, String> {
    workflows::get_snapshot(&state)
}

#[tauri::command]
pub fn project_set_sequence(state: State<'_, AppState>, sequence_items: Vec<SequenceItem>) -> Result<(), String> {
    let project = state.database.load_project_summary().map_err(|error| error.to_string())?;
    state
        .database
        .replace_sequence_items(&project.project_id, &sequence_items)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn media_import_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<MediaAsset>, String> {
    workflows::import_media_paths(&app, &state, paths)
}

#[tauri::command]
pub async fn transcript_run(
    app: AppHandle,
    state: State<'_, AppState>,
    asset_id: String,
    language: Option<String>,
    discard_manual_corrections: Option<bool>,
) -> Result<TranscriptResponse, String> {
    workflows::transcript_run_direct(
        &app,
        &state,
        asset_id,
        language,
        discard_manual_corrections.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub fn search_query(state: State<'_, AppState>, query: String) -> Result<Vec<SearchHit>, String> {
    workflows::search_query(&state, query)
}

#[tauri::command]
pub async fn app_capabilities(state: State<'_, AppState>) -> Result<AppCapabilities, String> {
    workflows::get_capabilities(&state).await
}

#[tauri::command]
pub fn ai_status() -> Result<serde_json::Value, String> {
    Ok(workflows::ai_status())
}

#[tauri::command]
pub async fn export_timeline(
    app: AppHandle,
    state: State<'_, AppState>,
    clips: Vec<SequenceItem>,
    output_path: String,
) -> Result<String, String> {
    workflows::export_timeline_direct(&app, &state, clips, output_path).await
}

#[tauri::command]
pub async fn merge_videos(
    app: AppHandle,
    state: State<'_, AppState>,
    input_paths: Vec<String>,
    output_path: String,
) -> Result<String, String> {
    workflows::merge_videos(&app, &state, input_paths, output_path)
}
