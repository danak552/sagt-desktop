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
    /// KB-Whisper Large-resultat (moln). Lagras separat från de lokala segmenten så
    /// användaren kan växla mellan modellernas resultat för samma inspelning.
    pub cloud_transcript: Option<String>,
    /// Strukturerade molnsegment (Fas 1c) — JSON `[{start_time,end_time,text,speaker}]` med
    /// DU/MÖTET-turer från stereo-omtranskribering. Lagras separat från `cloud_transcript`
    /// (flat text = modellväxlarens fallback) så molnvyn kan rendera turer i stället för en
    /// textblob. serde(default) — `save_recording_to_db` skickar inte fältet vid första sparningen.
    #[serde(default)]
    pub cloud_segments: Option<String>,
    /// Talaridentifiering (Fas 1) — JSON `{ "map": {etikett→namn}, "participants": [...] }`.
    /// Icke-förstörande: segmenten lämnas orörda, UI:t applicerar namnen ovanpå Du/Mötet.
    /// serde(default) — `save_recording_to_db` skickar inte fältet vid första sparningen.
    #[serde(default)]
    pub speaker_map: Option<String>,
    /// Ljudfilen har gallrats (auto-gallring). DB-raden med segment/analys behålls,
    /// men moln-omtranskribering och synk kräver ljudet och inaktiveras i UI.
    /// serde(default) — äldre frontend-anrop (save_recording_to_db) skickar inte fältet.
    #[serde(default)]
    pub audio_deleted: bool,
    /// Härlett vid läsning (EXISTS mot segments) — persisteras aldrig. Driver
    /// "Transkribering & analys"-kolumnen i Inspelningar-vyn.
    #[serde(default)]
    pub has_segments: bool,
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

/// Diskanvändning för lokal lagring — visas i Inställningar → Lagring.
#[derive(Debug, Serialize)]
pub struct StorageUsage {
    pub recordings_bytes: u64,
    pub db_bytes: u64,
    pub file_count: u32,
}

/// Resultat av en auto-gallring (cleanup_audio). deleted_ids låter frontend
/// uppdatera in-memory-state (t.ex. öppnad inspelning i SplitView) utan DB-omfråga.
#[derive(Debug, Serialize, Clone)]
pub struct CleanupResult {
    pub deleted_count: u32,
    pub freed_bytes: u64,
    pub deleted_ids: Vec<i64>,
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

        // SQLite indexerar inte FK-kolumner automatiskt. Utan detta gör EXISTS-kollen
        // i get_all_recordings (och get_segments/DELETE-kaskaden) en full skanning av
        // segments per inspelningsrad — O(inspelningar × segment) vid stora bibliotek.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_segments_recording_id ON segments(recording_id)",
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

        // Migration: cloud_transcript — molnresultat per inspelning (växla lokal/moln-modell)
        let cloud_transcript_col_exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('recordings') WHERE name='cloud_transcript'",
            [],
            |row| row.get(0),
        ).unwrap_or(0) > 0;

        if !cloud_transcript_col_exists {
            let _ = conn.execute("ALTER TABLE recordings ADD COLUMN cloud_transcript TEXT", []);
        }

        // Migration: audio_deleted — ljudfil gallrad men transkript/analys behållna
        let audio_deleted_col_exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('recordings') WHERE name='audio_deleted'",
            [],
            |row| row.get(0),
        ).unwrap_or(0) > 0;

        if !audio_deleted_col_exists {
            let _ = conn.execute("ALTER TABLE recordings ADD COLUMN audio_deleted INTEGER NOT NULL DEFAULT 0", []);
        }

        // Migration: speaker_map — talaridentifiering (tilltalsnamn ovanpå Du/Mötet, Fas 1)
        let speaker_map_col_exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('recordings') WHERE name='speaker_map'",
            [],
            |row| row.get(0),
        ).unwrap_or(0) > 0;

        if !speaker_map_col_exists {
            let _ = conn.execute("ALTER TABLE recordings ADD COLUMN speaker_map TEXT", []);
        }

        // Migration: cloud_segments — strukturerade molnsegment (DU/MÖTET-turer, Fas 1c)
        let cloud_segments_col_exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('recordings') WHERE name='cloud_segments'",
            [],
            |row| row.get(0),
        ).unwrap_or(0) > 0;

        if !cloud_segments_col_exists {
            let _ = conn.execute("ALTER TABLE recordings ADD COLUMN cloud_segments TEXT", []);
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
            "INSERT INTO recordings (filename, file_path, duration_sec, created_at, sync_status, cloud_job_id, analysis_json, ai_template_used, cloud_transcript, audio_deleted, speaker_map, cloud_segments)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                recording.filename,
                recording.file_path,
                recording.duration_sec,
                recording.created_at,
                recording.sync_status,
                recording.cloud_job_id,
                recording.analysis_json,
                recording.ai_template_used,
                recording.cloud_transcript,
                recording.audio_deleted,
                recording.speaker_map,
                recording.cloud_segments
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
        let mut stmt = conn.prepare("SELECT id, filename, file_path, duration_sec, created_at, sync_status, cloud_job_id, analysis_json, ai_template_used, cloud_transcript, audio_deleted, speaker_map, cloud_segments, EXISTS(SELECT 1 FROM segments WHERE segments.recording_id = recordings.id) FROM recordings ORDER BY created_at DESC").map_err(|e| e.to_string())?;

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
                cloud_transcript: row.get(9)?,
                audio_deleted: row.get(10)?,
                speaker_map: row.get(11)?,
                cloud_segments: row.get(12)?,
                has_segments: row.get(13)?,
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

    /// Ersätt segmenten för en inspelning (idempotent). Används för PRO-molnströmning där
    /// segmenten kommer succesivt och måste persisteras post-stop så historik/återöppning
    /// visar samma Du/Mötet-vy som live (annars sparas inspelningen utan segment).
    pub fn update_recording_segments(&self, recording_id: i64, segments: Vec<Segment>) -> Result<(), String> {
        let mut conn = self.get_connection().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM segments WHERE recording_id = ?1", params![recording_id])
            .map_err(|e| e.to_string())?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO segments (recording_id, start_time, end_time, text, speaker)
                 VALUES (?1, ?2, ?3, ?4, ?5)"
            ).map_err(|e| e.to_string())?;
            for segment in &segments {
                stmt.execute(params![
                    recording_id,
                    segment.start_time,
                    segment.end_time,
                    segment.text,
                    segment.speaker
                ]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
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

    /// Persistera molnresultatet (KB-Whisper Large) för en inspelning. De lokala
    /// segmenten lämnas orörda — vyn växlar mellan modellresultaten i frontend.
    pub fn save_cloud_transcript(&self, id: i64, transcript: String) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;

        conn.execute(
            "UPDATE recordings SET cloud_transcript = ?1 WHERE id = ?2",
            params![transcript, id]
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Persistera strukturerade molnsegment (DU/MÖTET-turer från stereo-omtranskribering)
    /// som JSON. Lokala segment + `cloud_transcript` lämnas orörda — molnvyn renderar
    /// dessa turer i stället för den flata textblobben (Fas 1c).
    pub fn save_cloud_segments(&self, id: i64, cloud_segments: String) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;

        conn.execute(
            "UPDATE recordings SET cloud_segments = ?1 WHERE id = ?2",
            params![cloud_segments, id]
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Persistera talaridentifieringen (JSON: namnmappning + deltagarlista) för en
    /// inspelning. Segmenten lämnas orörda — namnen appliceras ovanpå i frontend.
    pub fn save_speaker_map(&self, id: i64, speaker_map: String) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;

        conn.execute(
            "UPDATE recordings SET speaker_map = ?1 WHERE id = ?2",
            params![speaker_map, id]
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Sökvägen till inspelningskatalogen, för "Öppna mapp" i gränssnittet. Att bara visa
    /// antal byte utan att kunna nå filerna gör det lokala löftet abstrakt — användaren
    /// ska kunna se sina egna inspelningar i Utforskaren.
    pub fn recordings_dir(&self) -> &PathBuf {
        &self.recordings_dir
    }

    /// Summera diskanvändningen: alla filer i recordings-katalogen + databasen
    /// (inkl. ev. -wal/-shm-sidofiler). Endast lokal filsystemåtkomst — offline-säkert.
    pub fn get_storage_usage(&self) -> Result<StorageUsage, String> {
        let mut recordings_bytes: u64 = 0;
        let mut file_count: u32 = 0;

        let entries = fs::read_dir(&self.recordings_dir)
            .map_err(|e| format!("Kunde inte läsa inspelningskatalogen: {}", e))?;
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    recordings_bytes += meta.len();
                    file_count += 1;
                }
            }
        }

        let mut db_bytes: u64 = 0;
        for suffix in ["", "-wal", "-shm"] {
            let mut os_path = self.db_path.clone().into_os_string();
            os_path.push(suffix);
            if let Ok(meta) = fs::metadata(PathBuf::from(os_path)) {
                db_bytes += meta.len();
            }
        }

        Ok(StorageUsage { recordings_bytes, db_bytes, file_count })
    }

    /// Auto-gallring av ljudfiler. Raderar äldsta först, men behåller DB-raden med
    /// segment/transkript/analys och markerar `audio_deleted = 1`.
    ///
    /// Säkerhet:
    /// - Endast filer vars canonicaliserade sökväg ligger i recordings-katalogen raderas
    ///   (samma mönster som read_audio_file i lib.rs). Aktiv sessions WAV ligger i %TEMP%
    ///   tills den sparas och kan därför aldrig träffas.
    /// - `max_age_days` jämför filens mtime (created_at är TEXT — undviker datumparsning).
    /// - `max_total_bytes` raderar äldst-först tills totalen ryms inom kvoten.
    pub fn cleanup_audio(&self, max_age_days: Option<u32>, max_total_bytes: Option<u64>) -> Result<CleanupResult, String> {
        let recordings_dir = fs::canonicalize(&self.recordings_dir)
            .map_err(|e| format!("Kunde inte normalisera inspelningskatalogen: {}", e))?;

        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, file_path FROM recordings WHERE audio_deleted = 0 ORDER BY created_at ASC")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(i64, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);

        // Kandidater äldst-först: (id, canonicaliserad sökväg, bytes, mtime).
        // Rader vars fil redan saknas reconcilieras direkt till audio_deleted = 1.
        let mut deleted_count: u32 = 0;
        let mut freed_bytes: u64 = 0;
        let mut deleted_ids: Vec<i64> = Vec::new();
        let mut candidates: Vec<(i64, PathBuf, u64, std::time::SystemTime)> = Vec::new();

        for (id, path_str) in rows {
            let Ok(path) = fs::canonicalize(&path_str) else {
                // Filen finns inte längre (eller är oåtkomlig) — markera som gallrad.
                // Räknas inte i deleted_count/freed_bytes (inget frigjordes), men tas med
                // i deleted_ids så UI-badges uppdateras.
                if conn.execute("UPDATE recordings SET audio_deleted = 1 WHERE id = ?1", params![id]).is_ok() {
                    deleted_ids.push(id);
                }
                continue;
            };
            if !path.starts_with(&recordings_dir) {
                continue; // rör aldrig filer utanför recordings-katalogen
            }
            let Ok(meta) = fs::metadata(&path) else { continue };
            let mtime = meta.modified().unwrap_or(std::time::SystemTime::now());
            candidates.push((id, path, meta.len(), mtime));
        }

        let mut total_bytes: u64 = candidates.iter().map(|(_, _, size, _)| size).sum();

        let age_cutoff = max_age_days.map(|days| {
            std::time::SystemTime::now() - std::time::Duration::from_secs(days as u64 * 86_400)
        });

        for (id, path, size, mtime) in candidates {
            let too_old = age_cutoff.map_or(false, |cutoff| mtime < cutoff);
            let over_quota = max_total_bytes.map_or(false, |quota| total_bytes > quota);
            if !too_old && !over_quota {
                if age_cutoff.is_none() {
                    break; // ren kvotgallring: resten är nyare och totalen ryms redan
                }
                continue;
            }

            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    eprintln!("Warning: kunde inte radera {:?}: {}", path, e);
                    continue; // raden behåller audio_deleted = 0 → nytt försök nästa gallring
                }
            }

            conn.execute("UPDATE recordings SET audio_deleted = 1 WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            deleted_count += 1;
            freed_bytes += size;
            deleted_ids.push(id);
            total_bytes = total_bytes.saturating_sub(size);
        }

        Ok(CleanupResult { deleted_count, freed_bytes, deleted_ids })
    }
}

