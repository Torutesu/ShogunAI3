//! Shared application data directory (`directories` crate).

use directories::ProjectDirs;
use std::fs;
use std::path::PathBuf;

const QUALIFIER: &str = "ai";
const ORG: &str = "Shogun";
const APP: &str = "ShogunAI3";

#[cfg(test)]
thread_local! {
    static TEST_APP_DATA_DIR: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// Point `app_data_dir()` at a throwaway directory for the current test thread.
#[cfg(test)]
pub fn set_test_app_data_dir(p: PathBuf) {
    TEST_APP_DATA_DIR.with(|c| *c.borrow_mut() = Some(p));
}

/// Clear the per-thread `app_data_dir()` override.
#[cfg(test)]
pub fn clear_test_app_data_dir() {
    TEST_APP_DATA_DIR.with(|c| *c.borrow_mut() = None);
}

pub fn app_data_dir() -> Result<PathBuf, String> {
    #[cfg(test)]
    {
        if let Some(p) = TEST_APP_DATA_DIR.with(|c| c.borrow().clone()) {
            fs::create_dir_all(&p).map_err(|e| e.to_string())?;
            return Ok(p);
        }
    }
    let dirs = ProjectDirs::from(QUALIFIER, ORG, APP)
        .ok_or_else(|| "could not resolve app data directory".to_string())?;
    let dir = dirs.data_dir().to_path_buf();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Sum byte length of every regular file directly under the app data directory (non-recursive).
pub fn app_data_total_bytes() -> Result<u64, String> {
    let dir = app_data_dir()?;
    let mut sum = 0u64;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() {
            sum += fs::metadata(&path).map_err(|e| e.to_string())?.len();
        }
    }
    Ok(sum)
}

/// Remove top-level files and the `packs/` directory (material packs & focus notes).
pub fn clear_app_data_files() -> Result<(), String> {
    let dir = app_data_dir()?;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        } else if path.is_dir() {
            if path.file_name().and_then(|n| n.to_str()) == Some("packs") {
                fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}
