use serde_json::{json, Value};

const REASONING: &str = "gemini-3.1-pro-preview";
const EMBEDDING: &str = "gemini-embedding-2-preview";
const IMAGE_GEN: &str = "gemini-3.1-flash-image-preview";
const VIDEO_GEN: &str = "veo-3.1-fast-generate-preview";

const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

pub fn gemini_reasoning_model() -> &'static str {
    REASONING
}

pub fn gemini_image_model() -> &'static str {
    IMAGE_GEN
}

fn api_key() -> Result<String, String> {
    std::env::var("GEMINI_API_KEY")
        .map_err(|_| "GEMINI_API_KEY environment variable is not set".to_string())
        .and_then(|key| {
            if key.trim().is_empty() {
                Err("GEMINI_API_KEY is empty".to_string())
            } else {
                Ok(key)
            }
        })
}

pub async fn request_transcription(source_path: String, display_name: String, language: Option<String>) -> Result<Value, String> {
    let sidecar_url = std::env::var("LOCAL_ALIGNER_URL").unwrap_or_else(|_| "http://127.0.0.1:8765".to_string());
    let mut form = reqwest::multipart::Form::new()
        .text("source_path", source_path)
        .text("display_name", display_name);

    if let Some(language) = language.filter(|value| !value.trim().is_empty()) {
        form = form.text("language", language);
    }

    let response = reqwest::Client::new()
        .post(format!("{sidecar_url}/transcribe"))
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("Failed to reach the transcription sidecar: {error}"))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_else(|_| "unknown transcription error".to_string());
        return Err(body);
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Failed to parse transcription response: {error}"))
}

pub async fn gemini_generate_content(model: &str, body: Value) -> Result<Value, String> {
    let key = api_key()?;
    let url = format!("{GEMINI_BASE}/models/{model}:generateContent?key={key}");

    let response = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Gemini request failed: {error}"))?;

    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Gemini API error: {text}"));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Failed to parse Gemini response: {error}"))
}

pub async fn gemini_generate_videos(body: Value) -> Result<Value, String> {
    let key = api_key()?;
    let url = format!("{GEMINI_BASE}/models/{VIDEO_GEN}:predictLongRunning?key={key}");

    let response = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Veo request failed: {error}"))?;

    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Veo API error: {text}"));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Failed to parse Veo response: {error}"))
}

pub async fn poll_video_operation(op_name: &str) -> Result<Value, String> {
    let key = api_key()?;
    let url = format!("{GEMINI_BASE}/{op_name}?key={key}");
    let client = reqwest::Client::new();
    let start = std::time::Instant::now();
    let max_wait = std::time::Duration::from_secs(180);

    loop {
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|error| format!("Poll request failed: {error}"))?;

        let operation: Value = response
            .json()
            .await
            .map_err(|error| format!("Poll parse failed: {error}"))?;

        if operation["done"].as_bool().unwrap_or(false) {
            if let Some(error) = operation.get("error") {
                return Err(format!("Video generation failed: {error}"));
            }
            return Ok(operation);
        }

        if start.elapsed() > max_wait {
            return Err("Video generation timed out (180s)".to_string());
        }

        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

pub async fn fetch_video_bytes(uri: &str) -> Result<Vec<u8>, String> {
    let key = api_key()?;
    let separator = if uri.contains('?') { "&" } else { "?" };
    let url = format!("{uri}{separator}key={key}");

    let response = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch video: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Video fetch failed: {}", response.status()));
    }

    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("Failed to read video bytes: {error}"))
}

pub fn extract_text_from_response(response: &Value) -> String {
    response["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string()
}

pub fn clean_json_response(text: &str) -> Value {
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    serde_json::from_str(cleaned).unwrap_or(Value::Null)
}

pub fn embedding_request_body(texts: Vec<String>) -> Value {
    let requests: Vec<Value> = texts
        .iter()
        .map(|text| {
            json!({
                "model": format!("models/{EMBEDDING}"),
                "content": { "parts": [{ "text": text }] }
            })
        })
        .collect();

    json!({ "requests": requests })
}

pub async fn gemini_batch_embed(body: Value) -> Result<Value, String> {
    let key = api_key()?;
    let url = format!("{GEMINI_BASE}/models/{EMBEDDING}:batchEmbedContents?key={key}");

    let response = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Embedding request failed: {error}"))?;

    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Embedding API error: {text}"));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())
}
