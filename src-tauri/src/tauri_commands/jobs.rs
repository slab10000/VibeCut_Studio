use serde_json::Value;
use tauri::{AppHandle, State};

use crate::{application::workflows, models::{JobRecord, SequenceItem}, state::AppState};

#[tauri::command]
pub fn transcript_enqueue(app: AppHandle, state: State<'_, AppState>, asset_id: String) -> Result<JobRecord, String> {
    workflows::enqueue_transcript(app, state.inner().clone(), asset_id)
}

#[tauri::command]
pub fn ai_enqueue_edit_command(
    app: AppHandle,
    state: State<'_, AppState>,
    command: String,
    transcript: Value,
    timeline: Value,
) -> Result<JobRecord, String> {
    workflows::enqueue_ai_edit(app, state.inner().clone(), command, transcript, timeline)
}

#[tauri::command]
pub fn export_enqueue(
    app: AppHandle,
    state: State<'_, AppState>,
    clips: Vec<SequenceItem>,
    output_path: String,
) -> Result<JobRecord, String> {
    workflows::enqueue_export(app, state.inner().clone(), clips, output_path)
}
