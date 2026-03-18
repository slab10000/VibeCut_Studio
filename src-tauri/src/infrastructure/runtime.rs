use std::{
    fs,
    path::Path,
    process::Command,
    time::UNIX_EPOCH,
};

use anyhow::{anyhow, Context};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn command_available(command: &str, args: &[&str]) -> bool {
    Command::new(command).args(args).output().is_ok()
}

pub async fn sidecar_available() -> bool {
    reqwest::Client::new()
        .get(std::env::var("LOCAL_ALIGNER_URL").unwrap_or_else(|_| "http://127.0.0.1:8765".to_string()) + "/health")
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

pub fn detect_hardware_encoding() -> Vec<String> {
    let Ok(output) = Command::new("ffmpeg").args(["-hide_banner", "-encoders"]).output() else {
        return Vec::new();
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut encoders = Vec::new();
    for encoder in ["h264_videotoolbox", "hevc_videotoolbox", "h264_nvenc", "hevc_nvenc", "h264_qsv", "hevc_qsv"] {
        if stdout.contains(encoder) {
            encoders.push(encoder.to_string());
        }
    }

    encoders
}

pub fn now_fingerprint(path: &Path) -> anyhow::Result<String> {
    let metadata = fs::metadata(path)?;
    let modified = metadata.modified()?.duration_since(UNIX_EPOCH)?.as_secs();
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_string().as_bytes());
    hasher.update(modified.to_string().as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn placeholder_waveform(seed: &str, points: usize) -> Vec<f64> {
    let mut hash: i64 = 0;
    for character in seed.bytes() {
        hash = (hash * 31 + character as i64) % 9973;
    }

    (0..points)
        .map(|index| {
            let value =
                (((hash + index as i64 * 13) as f64) / 11.0).sin() * 0.18 + (((hash + index as i64 * 7) as f64) / 17.0).cos() * 0.12;
            (0.28 + value.abs()).clamp(0.18, 0.78)
        })
        .collect()
}

pub fn ffprobe_json(path: &Path) -> anyhow::Result<Value> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,codec_name,width,height",
            "-print_format",
            "json",
            &path.to_string_lossy(),
        ])
        .output()
        .with_context(|| format!("failed to probe {}", path.display()))?;

    if !output.status.success() {
        return Err(anyhow!("ffprobe failed for {}", path.display()));
    }

    serde_json::from_slice(&output.stdout).context("invalid ffprobe json")
}

pub fn generate_thumbnail(cache_dir: &Path, path: &Path, asset_id: &str) -> Option<String> {
    if !command_available("ffmpeg", &["-version"]) {
        return None;
    }

    let thumbnails_dir = cache_dir.join("thumbnails");
    if fs::create_dir_all(&thumbnails_dir).is_err() {
        return None;
    }

    let output_path = thumbnails_dir.join(format!("{asset_id}.jpg"));
    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-i",
            &path.to_string_lossy(),
            "-vf",
            "thumbnail,scale=480:-2",
            "-frames:v",
            "1",
            &output_path.to_string_lossy(),
        ])
        .status()
        .ok()?;

    if status.success() {
        Some(output_path.to_string_lossy().to_string())
    } else {
        None
    }
}

pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;

    base64::engine::general_purpose::STANDARD
        .decode(input)
        .map_err(|error| format!("base64 decode error: {error}"))
}
