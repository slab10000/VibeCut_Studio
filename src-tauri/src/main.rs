mod ai;
mod application;
mod commands;
mod db;
mod domain;
mod infrastructure;
mod models;
mod state;
mod tauri_commands;

use state::AppState;
use tauri::Manager;

fn main() {
    let _ = dotenvy::dotenv();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let cache_dir = app_data_dir.join("cache");
            if cache_dir.exists() {
                std::fs::remove_dir_all(&cache_dir)?;
            }
            std::fs::create_dir_all(&cache_dir)?;

            let database = db::Database::new(app_data_dir.join("project.sqlite"));
            database.initialize()?;
            database.reset_session_state()?;

            app.manage(AppState {
                database,
                cache_dir,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::project_bootstrap,
            commands::project_get_snapshot,
            commands::project_set_sequence,
            commands::media_import_paths,
            commands::transcript_run,
            commands::search_query,
            commands::app_capabilities,
            commands::ai_status,
            commands::export_timeline,
            commands::merge_videos,
            tauri_commands::queries::project_get,
            tauri_commands::queries::library_list,
            tauri_commands::queries::timeline_get,
            tauri_commands::queries::transcript_get,
            tauri_commands::queries::jobs_list,
            tauri_commands::queries::capabilities_get,
            tauri_commands::mutations::library_import_paths,
            tauri_commands::mutations::library_remove,
            tauri_commands::mutations::timeline_apply_patch,
            tauri_commands::mutations::transcript_update_word_timing,
            tauri_commands::jobs::transcript_enqueue,
            tauri_commands::jobs::ai_enqueue_edit_command,
            tauri_commands::jobs::export_enqueue,
            ai::ai_generate_image,
            ai::ai_style_suggestions,
            ai::ai_generate_video,
            ai::ai_generate_transition,
            ai::ai_edit_command,
            ai::ai_generate_font,
            ai::ai_generate_embeddings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running VibeCut desktop");
}
