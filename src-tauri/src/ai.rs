use tauri::{AppHandle, State};

use crate::{
    application::workflows,
    application::workflows::AiEmbeddingResponse,
    models::{AiFontResponse, AiImageResponse, AiStyleSuggestion, AiVideoResponse, EditCommandResponse},
    state::AppState,
};

#[tauri::command]
pub async fn ai_generate_image(
    prompt: String,
    reference_base64: Option<String>,
    reference_mime: Option<String>,
) -> Result<AiImageResponse, String> {
    workflows::ai_generate_image(prompt, reference_base64, reference_mime).await
}

#[tauri::command]
pub async fn ai_style_suggestions(
    text: String,
    reference_image: Option<String>,
) -> Result<Vec<AiStyleSuggestion>, String> {
    workflows::ai_style_suggestions(text, reference_image).await
}

#[tauri::command]
pub async fn ai_generate_video(
    app: AppHandle,
    state: State<'_, AppState>,
    prompt: String,
    image_base64: String,
    image_mime_type: String,
) -> Result<AiVideoResponse, String> {
    workflows::ai_generate_video(&app, &state, prompt, image_base64, image_mime_type).await
}

#[tauri::command]
pub async fn ai_generate_transition(
    app: AppHandle,
    state: State<'_, AppState>,
    last_frame_base64: String,
    start_frame_base64: Option<String>,
    description: Option<String>,
) -> Result<AiVideoResponse, String> {
    workflows::ai_generate_transition(&app, &state, last_frame_base64, start_frame_base64, description).await
}

#[tauri::command]
pub async fn ai_edit_command(
    command: String,
    transcript: serde_json::Value,
    timeline: serde_json::Value,
) -> Result<EditCommandResponse, String> {
    workflows::ai_edit_command(command, transcript, timeline).await
}

#[tauri::command]
pub async fn ai_generate_font(image_base64: String) -> Result<AiFontResponse, String> {
    workflows::ai_generate_font(image_base64).await
}

#[tauri::command]
pub async fn ai_generate_embeddings(texts: Vec<String>) -> Result<AiEmbeddingResponse, String> {
    workflows::ai_generate_embeddings(texts).await
}
