use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize)]
pub struct Recording {
    pub id: Option<i64>,
    pub filename: String,
    pub file_path: String,
    pub duration_sec: f64,
    pub created_at: String,
    pub sync_status: String, // 'local' or 'synced'
    pub cloud_job_id: Option<String>,
    pub analysis_json: Option<String>,
    pub ai_template_used: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Segment {
    pub id: Option<i64>,
    pub recording_id: Option<i64>,
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
    pub speaker: String,
}

pub struct DatabaseManager {
    db_path: PathBuf,
    recordings_dir: PathBuf,
}

impl DatabaseManager {
    pub fn new(app_handle: &AppHandle) -> Self {
        let app_data_dir = app_handle.path().app_data_dir().expect("Failed to get app data dir");
        
        if !app_data_dir.exists() {
            fs::create_dir_all(&app_data_dir).expect("Failed to create app data dir");
        }

        let recordings_dir = app_data_dir.join("recordings");
        if !recordings_dir.exists() {
             fs::create_dir_all(&recordings_dir).expect("Failed to create recordings dir");
        }

        let db_path = app_data_dir.join("whisper.db");
        
        let manager = Self { db_path, recordings_dir };
        manager.init_db().expect("Failed to init DB");
        manager
    }

    fn get_connection(&self) -> Result<Connection> {
        Connection::open(&self.db_path)
    }

    fn init_db(&self) -> Result<()> {
        let conn = self.get_connection()?;
        
        conn.execute(
            "CREATE TABLE IF NOT EXISTS recordings (
                id INTEGER PRIMARY KEY,
                filename TEXT NOT NULL,
                file_path TEXT NOT NULL,
                duration_sec REAL NOT NULL,
                created_at TEXT NOT NULL,
                sync_status TEXT DEFAULT 'local',
                cloud_job_id TEXT
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS segments (
                id INTEGER PRIMARY KEY,
                recording_id INTEGER NOT NULL,
                start_time REAL NOT NULL,
                end_time REAL NOT NULL,
                text TEXT NOT NULL,
                speaker TEXT NOT NULL,
                FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // Migration: Check if analysis_json column exists
        let analysis_col_exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('recordings') WHERE name='analysis_json'",
            [],
            |row| row.get(0),
        ).unwrap_or(0) > 0;

        if !analysis_col_exists {
            let _ = conn.execute("ALTER TABLE recordings ADD COLUMN analysis_json TEXT", []);
        }

        // Migration: Check if ai_template_used column exists
        let template_col_exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('recordings') WHERE name='ai_template_used'",
            [],
            |row| row.get(0),
        ).unwrap_or(0) > 0;

        if !template_col_exists {
            let _ = conn.execute("ALTER TABLE recordings ADD COLUMN ai_template_used TEXT", []);
        }

        Ok(())
    }

    pub fn save_recording(&self, mut recording: Recording, segments: Vec<Segment>) -> Result<Recording, String> {
        // 1. Move file to persistent storage
        let (new_path_str, filename_str) = {
            let temp_path = Path::new(&recording.file_path);
            if temp_path.exists() {
                let filename = temp_path.file_name().ok_or("Invalid filename")?;
                let new_path = self.recordings_dir.join(filename);
                
                fs::copy(temp_path, &new_path).map_err(|e| format!("Failed to copy file: {}", e))?;
                // Best-effort cleanup: delete temp WAV from %TEMP% after copying to persistent storage.
                // Failure is non-fatal — the recording is already saved.
                if let Err(e) = fs::remove_file(temp_path) {
                    eprintln!("Warning: could not delete temp file {:?}: {}", temp_path, e);
                }
                
                (new_path.to_string_lossy().to_string(), filename.to_string_lossy().to_string())
            } else {
                 return Err(format!("Source Audio File not found: {}", recording.file_path));
            }
        };

        recording.file_path = new_path_str;
        recording.filename = filename_str;

        let mut conn = self.get_connection().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        // 2. Insert Recording
        tx.execute(
            "INSERT INTO recordings (filename, file_path, duration_sec, created_at, sync_status, cloud_job_id, analysis_json, ai_template_used)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                recording.filename,
                recording.file_path,
                recording.duration_sec,
                recording.created_at,
                recording.sync_status,
                recording.cloud_job_id,
                recording.analysis_json,
                recording.ai_template_used
            ],
        ).map_err(|e| e.to_string())?;

        let recording_id = tx.last_insert_rowid();
        recording.id = Some(recording_id);

        // 3. Insert Segments
        let mut stmt = tx.prepare(
            "INSERT INTO segments (recording_id, start_time, end_time, text, speaker)
             VALUES (?1, ?2, ?3, ?4, ?5)"
        ).map_err(|e| e.to_string())?;

        for segment in segments {
            stmt.execute(params![
                recording_id,
                segment.start_time,
                segment.end_time,
                segment.text,
                segment.speaker
            ]).map_err(|e| e.to_string())?;
        }
        drop(stmt);

        tx.commit().map_err(|e| e.to_string())?;

        Ok(recording)
    }

    pub fn get_all_recordings(&self) -> Result<Vec<Recording>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT id, filename, file_path, duration_sec, created_at, sync_status, cloud_job_id, analysis_json, ai_template_used FROM recordings ORDER BY created_at DESC").map_err(|e| e.to_string())?;
        
        let recordings_iter = stmt.query_map([], |row| {
            Ok(Recording {
                id: Some(row.get(0)?),
                filename: row.get(1)?,
                file_path: row.get(2)?,
                duration_sec: row.get(3)?,
                created_at: row.get(4)?,
                sync_status: row.get(5)?,
                cloud_job_id: row.get(6)?,
                analysis_json: row.get(7)?,
                ai_template_used: row.get(8)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut recordings = Vec::new();
        for recording in recordings_iter {
            recordings.push(recording.map_err(|e| e.to_string())?);
        }
        Ok(recordings)
    }

    pub fn get_recording_segments(&self, recording_id: i64) -> Result<Vec<Segment>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT id, recording_id, start_time, end_time, text, speaker FROM segments WHERE recording_id = ?1 ORDER BY start_time ASC").map_err(|e| e.to_string())?;
        
        let segments_iter = stmt.query_map(params![recording_id], |row| {
            Ok(Segment {
                id: Some(row.get(0)?),
                recording_id: Some(row.get(1)?),
                start_time: row.get(2)?,
                end_time: row.get(3)?,
                text: row.get(4)?,
                speaker: row.get(5)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut segments = Vec::new();
        for segment in segments_iter {
            segments.push(segment.map_err(|e| e.to_string())?);
        }
        Ok(segments)
    }

    pub fn delete_recording(&self, id: i64) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        
        // Get file path first
        let path: String = conn.query_row(
            "SELECT file_path FROM recordings WHERE id = ?1",
            params![id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;

        // Delete from DB (Cascade deletes segments)
        conn.execute("DELETE FROM recordings WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;

        // Delete file
        let file_path = Path::new(&path);
        if file_path.exists() {
            fs::remove_file(file_path).map_err(|e| format!("Failed to delete file: {}", e))?;
        }

        Ok(())
    }

    pub fn update_recording_status(&self, id: i64, status: String, cloud_job_id: Option<String>) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        
        conn.execute(
            "UPDATE recordings SET sync_status = ?1, cloud_job_id = ?2 WHERE id = ?3",
            params![status, cloud_job_id, id]
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn save_analysis(&self, id: i64, analysis: String, template: String) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        
        conn.execute(
            "UPDATE recordings SET analysis_json = ?1, ai_template_used = ?2 WHERE id = ?3",
            params![analysis, template, id]
        ).map_err(|e| e.to_string())?;

        Ok(())
    }
}

