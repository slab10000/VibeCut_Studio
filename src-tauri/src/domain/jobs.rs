use serde_json::Value;
use uuid::Uuid;

use crate::models::JobRecord;

pub const JOB_STATUS_QUEUED: &str = "queued";
pub const JOB_STATUS_RUNNING: &str = "running";
pub const JOB_STATUS_COMPLETE: &str = "complete";
pub const JOB_STATUS_ERROR: &str = "error";

pub fn now_timestamp_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub fn create_job(
    kind: &str,
    target_kind: Option<&str>,
    target_id: &str,
    payload: Option<Value>,
    fingerprint: Option<String>,
) -> JobRecord {
    let timestamp = now_timestamp_ms();

    JobRecord {
        id: Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        target_kind: target_kind.map(ToOwned::to_owned),
        target_id: target_id.to_string(),
        status: JOB_STATUS_QUEUED.to_string(),
        progress: 0.0,
        message: None,
        payload,
        result: None,
        error_message: None,
        fingerprint,
        created_at: timestamp,
        updated_at: timestamp,
    }
}

pub fn mark_job_running(job: &JobRecord, progress: f64, message: Option<String>) -> JobRecord {
    JobRecord {
        status: JOB_STATUS_RUNNING.to_string(),
        progress,
        message,
        updated_at: now_timestamp_ms(),
        ..job.clone()
    }
}

pub fn mark_job_complete(job: &JobRecord, message: Option<String>, result: Option<Value>) -> JobRecord {
    JobRecord {
        status: JOB_STATUS_COMPLETE.to_string(),
        progress: 1.0,
        message,
        result,
        error_message: None,
        updated_at: now_timestamp_ms(),
        ..job.clone()
    }
}

pub fn mark_job_error(job: &JobRecord, message: String) -> JobRecord {
    JobRecord {
        status: JOB_STATUS_ERROR.to_string(),
        progress: 1.0,
        message: Some(message.clone()),
        error_message: Some(message),
        updated_at: now_timestamp_ms(),
        ..job.clone()
    }
}
