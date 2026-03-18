use tauri::{AppHandle, State};

use crate::{application::workflows, models::{MediaAsset, SequenceItem, TimelinePatchRequest}, state::AppState};

#[tauri::command]
pub fn library_import_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<MediaAsset>, String> {
    workflows::import_media_paths(&app, &state, paths)
}

#[tauri::command]
pub fn timeline_apply_patch(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: TimelinePatchRequest,
) -> Result<Vec<SequenceItem>, String> {
    workflows::apply_timeline_patch(&app, &state, patch)
}

#[tauri::command]
pub fn library_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    asset_id: String,
) -> Result<(), String> {
    workflows::remove_library_asset(&app, &state, asset_id)
}
