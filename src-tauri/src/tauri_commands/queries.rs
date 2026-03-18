use tauri::State;

use crate::{application::workflows, models::{AppCapabilities, JobRecord, MediaAsset, ProjectSummary, SequenceItem}, state::AppState};

#[tauri::command]
pub fn project_get(state: State<'_, AppState>) -> Result<ProjectSummary, String> {
    workflows::get_project(&state)
}

#[tauri::command]
pub fn library_list(state: State<'_, AppState>) -> Result<Vec<MediaAsset>, String> {
    workflows::list_library(&state)
}

#[tauri::command]
pub fn timeline_get(state: State<'_, AppState>) -> Result<Vec<SequenceItem>, String> {
    workflows::get_timeline(&state)
}

#[tauri::command]
pub fn transcript_get(state: State<'_, AppState>, asset_id: String) -> Result<MediaAsset, String> {
    workflows::get_transcript(&state, asset_id)
}

#[tauri::command]
pub fn jobs_list(state: State<'_, AppState>) -> Result<Vec<JobRecord>, String> {
    workflows::list_jobs(&state)
}

#[tauri::command]
pub async fn capabilities_get(state: State<'_, AppState>) -> Result<AppCapabilities, String> {
    workflows::get_capabilities(&state).await
}
