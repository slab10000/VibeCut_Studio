use std::{
    fs,
    path::{Path, PathBuf},
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

pub fn normalize_media_path(input: &str) -> anyhow::Result<PathBuf> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("media path is empty"));
    }

    let path = if trimmed.starts_with("file://") {
        let url = reqwest::Url::parse(trimmed).with_context(|| format!("invalid file URL: {trimmed}"))?;
        url.to_file_path()
            .map_err(|_| anyhow!("unable to convert file URL to a local path: {trimmed}"))?
    } else {
        PathBuf::from(trimmed)
    };

    let resolved = if path.exists() {
        path
    } else {
        std::fs::canonicalize(&path).unwrap_or(path)
    };

    if !resolved.exists() {
        return Err(anyhow!("media file was not found: {}", resolved.display()));
    }

    if !resolved.is_file() {
        return Err(anyhow!("media path is not a file: {}", resolved.display()));
    }

    Ok(resolved)
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

/// Extract a real audio waveform by decoding audio via FFmpeg to raw f32le PCM,
/// then computing RMS amplitude per time bucket. Returns normalized 0.0–1.0 values.
pub fn extract_waveform(path: &Path, points: usize) -> Vec<f64> {
    let output = Command::new("ffmpeg")
        .args([
            "-i",
            &path.to_string_lossy(),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "f32le",
            "-",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output();

    let raw = match output {
        Ok(out) if !out.stdout.is_empty() => out.stdout,
        _ => return vec![0.0; points],
    };

    // Interpret raw bytes as f32 PCM samples (little-endian)
    let samples: Vec<f32> = raw
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();

    if samples.is_empty() {
        return vec![0.0; points];
    }

    let bucket_size = (samples.len() as f64 / points as f64).ceil() as usize;
    let mut waveform: Vec<f64> = Vec::with_capacity(points);

    for i in 0..points {
        let start = i * bucket_size;
        let end = ((i + 1) * bucket_size).min(samples.len());
        if start >= samples.len() {
            waveform.push(0.0);
            continue;
        }

        let bucket = &samples[start..end];
        // RMS (root mean square) amplitude for this bucket
        let rms = (bucket.iter().map(|s| (*s as f64) * (*s as f64)).sum::<f64>() / bucket.len() as f64).sqrt();
        waveform.push(rms);
    }

    // Normalize to 0.0–1.0 by peak RMS
    let peak = waveform.iter().cloned().fold(0.0_f64, f64::max);
    if peak > 0.0 {
        for value in &mut waveform {
            *value /= peak;
        }
    }

    waveform
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
            "-update",
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
