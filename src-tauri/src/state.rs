use std::path::PathBuf;

use crate::db::Database;

#[derive(Clone)]
pub struct AppState {
    pub database: Database,
    pub cache_dir: PathBuf,
}
