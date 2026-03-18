use tauri::{AppHandle, Emitter};

use crate::{
    db::Database,
    models::{EntityChangeEvent, JobRecord},
};

const JOBS_UPDATED_EVENT: &str = "jobs-updated";
const ENTITIES_CHANGED_EVENT: &str = "entities-changed";

pub fn emit_job_update(app: &AppHandle, database: &Database, job: &JobRecord) -> Result<(), String> {
    database.upsert_job(job).map_err(|error| error.to_string())?;
    app.emit(JOBS_UPDATED_EVENT, job.clone()).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn emit_entity_change(
    app: &AppHandle,
    entity_type: &str,
    entity_id: Option<String>,
    operation: &str,
) -> Result<(), String> {
    app.emit(
        ENTITIES_CHANGED_EVENT,
        EntityChangeEvent {
            entity_type: entity_type.to_string(),
            entity_id,
            operation: operation.to_string(),
        },
    )
    .map_err(|error| error.to_string())
}
