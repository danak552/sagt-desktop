// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod audio;
mod database;

use database::{DatabaseManager, Recording, Segment};
use tauri::Manager;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

/// Holds the PID of the active whisper-cli child process.
/// Stored as a PID (u32) rather than Child to avoid Send/ownership issues
/// when stdout is taken and the thread is blocking on it.
pub struct TranscriptionProcess {
    pub pid: Mutex<Option<u32>>,
    /// Set to true when the user deliberately cancels — suppresses false "kraschade" error
    pub cancelled: AtomicBool,
}

// Removed AppState wrapper to allow easier access from audio.rs
// struct AppState {
//    db: Mutex<DatabaseManager>,
// }

#[tauri::command]
fn init_audio_engine(
    state: tauri::State<'_, audio::AudioMonitor>,
    app: tauri::AppHandle,
    device: Option<String>,
) -> Result<(), String> {
    state.start(app, device)
}

#[tauri::command]
fn get_audio_devices(
    state: tauri::State<'_, audio::AudioMonitor>,
) -> Vec<audio::AudioDevice> {
    state.get_input_devices()
}

#[tauri::command]
fn start_recording(
    state: tauri::State<'_, audio::AudioMonitor>,
) -> Result<(), String> {
    state.start_recording()
}

#[tauri::command]
fn stop_recording(
    state: tauri::State<'_, audio::AudioMonitor>,
) -> Result<(), String> {
    state.stop_recording()
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn stop_audio_listener(
    state: tauri::State<'_, audio::AudioMonitor>,
) {
    state.stop();
}

#[tauri::command]
fn update_audio_settings(
    state: tauri::State<'_, audio::AudioMonitor>,
    threshold: f32,
    silence_ms: u64,
    language: Option<String>,
) {
    state.update_settings(threshold, silence_ms, language.unwrap_or_else(|| "sv".to_string()));
}

#[tauri::command]
fn cancel_transcription(
    state: tauri::State<'_, TranscriptionProcess>,
) -> Result<(), String> {
    if let Ok(mut pid_lock) = state.pid.lock() {
        if let Some(pid) = pid_lock.take() {
            // Mark as intentionally cancelled BEFORE killing
            state.cancelled.store(true, Ordering::SeqCst);
            println!("[KillSwitch] Killing whisper-cli process PID={}", pid);
            #[cfg(target_os = "windows")]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(&["/F", "/PID", &pid.to_string()])
                    .output();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = std::process::Command::new("kill")
                    .args(&["-9", &pid.to_string()])
                    .output();
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn read_audio_file(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    let requested = std::fs::canonicalize(&path)
        .map_err(|e| format!("Ogiltig sökväg: {}", e))?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Kunde inte bestämma datakatalog: {}", e))?;
    // Canonicalize båda sidor — på Windows ger canonicalize \\?\ UNC-prefix
    // vilket gör att starts_with misslyckas mot icke-canonicaliserad app_data.
    let app_data = std::fs::canonicalize(&app_data)
        .map_err(|e| format!("Kunde inte normalisera datakatalog: {}", e))?;
    if !requested.starts_with(&app_data) {
        return Err("Åtkomst nekad: sökvägen ligger utanför appens datakatalog.".to_string());
    }
    std::fs::read(&requested).map_err(|e| e.to_string())
}

// Database Commands
#[tauri::command]
fn save_recording_to_db(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    recording: Recording,
    segments: Vec<Segment>,
) -> Result<Recording, String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.save_recording(recording, segments)
}

#[tauri::command]
fn get_recordings(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
) -> Result<Vec<Recording>, String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.get_all_recordings()
}

#[tauri::command]
fn get_recording_segments(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    recording_id: i64,
) -> Result<Vec<Segment>, String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.get_recording_segments(recording_id)
}

#[tauri::command]
fn update_recording_status(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    id: i64,
    status: String,
    cloud_job_id: Option<String>,
) -> Result<(), String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.update_recording_status(id, status, cloud_job_id)
}

#[tauri::command]
fn delete_recording_db(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    id: i64,
) -> Result<(), String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.delete_recording(id)
}

#[tauri::command]
fn save_analysis_to_db(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    id: i64,
    analysis: String,
    template: String,
) -> Result<(), String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.save_analysis(id, analysis, template)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Kill any zombie whisper-cli processes from previous runs
            #[cfg(target_os = "windows")]
            {
                use std::process::Command;
                let _ = Command::new("taskkill")
                    .args(&["/F", "/IM", "whisper-cli*"])
                    .output();
            }

            app.manage(audio::AudioMonitor::new());
            app.manage(TranscriptionProcess { 
                pid: Mutex::new(None),
                cancelled: AtomicBool::new(false),
            });
            
            // Initialize Database
            let db_manager = DatabaseManager::new(app.handle());
            // app.manage(AppState {
            //     db: Mutex::new(db_manager),
            // });
            // Manage Mutex<DatabaseManager> directly
            app.manage(Mutex::new(db_manager));

            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            greet, 
            init_audio_engine, 
            get_audio_devices,
            start_recording, 
            stop_recording, 
            stop_audio_listener, 
            update_audio_settings, 
            read_audio_file,
            cancel_transcription,
            save_recording_to_db,
            get_recordings,
            get_recording_segments,
            delete_recording_db,
            update_recording_status,
            save_analysis_to_db
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
