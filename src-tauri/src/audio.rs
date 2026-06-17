use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{unbounded, Receiver, Sender};
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};
use crate::database::{DatabaseManager, Recording, Segment};

// Max 2 concurrent whisper-cli processes to avoid CPU starvation.
// More than 2 causes all instances to run ~4x slower, making live transcription impossible.
static TRANSCRIPTION_SEMAPHORE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();

fn transcription_semaphore() -> &'static Arc<tokio::sync::Semaphore> {
    TRANSCRIPTION_SEMAPHORE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
}

// Monotonisk sessionsgeneration. Bumpas vid varje inspelningsstart OCH vid avbryt.
// En transkriberingsuppgift fångar generationen när dess segment dispatchas; om generationen
// hunnit ändras (ny inspelning startad, eller användaren tryckt Avbryt) avbryter uppgiften
// innan den spawnar whisper-cli och slänger ev. resultat — så en föregående sessions köade/
// sena transkriberingar aldrig läcker in i den aktuella vyn.
static SESSION_GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn bump_session_generation() -> u64 {
    SESSION_GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

fn current_session_generation() -> u64 {
    SESSION_GENERATION.load(Ordering::SeqCst)
}

// Sessionsrelativ tid (sekunder) för ett segment som börjar vid `speech_start_ms`, mätt mot
// den delade `session.start_time`. Båda kanalerna (mic/sys) använder samma origo + samma
// väggklocka → segmenten sorteras i rätt ordning i vyn oavsett kanal.
fn session_offset(session_state: &Arc<Mutex<SessionState>>, speech_start_ms: u128) -> f64 {
    let origin = session_state
        .lock()
        .unwrap()
        .start_time
        .unwrap_or(speech_start_ms);
    speech_start_ms.saturating_sub(origin) as f64 / 1000.0
}

const SAMPLE_RATE: u32 = 16000;
const VAD_THRESHOLD: f32 = 0.008;
// 0.8s silence triggers a cut (was 1.2s) — snappier segmentation for live feel
const SILENCE_DURATION_MS: u128 = 800;
const MIN_RECORDING_DURATION_MS: u128 = 1000;
// 3.0s minimum keeps short sounds from becoming separate segments
const MIN_SEGMENT_DURATION_MS: u128 = 3000;
// 8s max chunk (was 15s) — shorter chunks → faster transcription → live text sooner
const MAX_SEGMENT_DURATION_MS: u128 = 8000;
// Molnchunks får vara längre: KB-Whisper är tränad på 30 s-fönster, så mer kontext per chunk
// ger märkbart bättre kvalitet. Lokal small behåller 8 s (CPU-latens med semaphore(2));
// molnet (Berget) transkriberar en 15 s-chunk på ~1–2 s så live-känslan består.
const CLOUD_MAX_SEGMENT_DURATION_MS: u128 = 15000;
// Pre-roll buffer size: 2.0 seconds * SAMPLE_RATE
const PRE_ROLL_SAMPLES: usize = (2.0 * SAMPLE_RATE as f32) as usize;
// Lead-in vid MAX-segmentklipp: behåll de sista ~1.5 s som akustisk uppvärmning för nästa
// chunk så whisper inte tappar de första orden när sammanhängande tal tvångsklipps mitt i.
const CHUNK_LEAD_IN_SAMPLES: usize = (1.5 * SAMPLE_RATE as f32) as usize;

#[derive(Clone, Serialize, Debug)]
pub struct AudioSettings {
    pub vad_threshold: f32,
    pub silence_duration_ms: u64,
    pub language: String,
    /// PRO online: skicka VAD-segment till molnet (kb-whisper-large) istället för
    /// lokal whisper-cli. När true körs ALDRIG lokal small (offline-fallback sätter
    /// detta till false från JS).
    pub cloud_streaming: bool,
    /// Sammanhängande-läge (1×): mixa kanalerna och transkribera EN ström i molnet
    /// (talare "MOLN"). När false (Strukturerat) streamas varje kanal separat (DU/MÖTET, ~2×).
    pub merge_channels: bool,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            vad_threshold: VAD_THRESHOLD,
            silence_duration_ms: SILENCE_DURATION_MS as u64,
            language: "sv".to_string(),
            cloud_streaming: false,
            merge_channels: false,
        }
    }
}

#[derive(Clone, Serialize)]
struct AudioPayload {
    mic: f32,
    system: f32,
}

#[derive(Clone, Serialize)]
struct TranscriptionChunk {
    text: String,
    source: String,
    start: f64,
    end: f64,
}

// Live cloud-streaming: a finished VAD segment shipped to JS as raw WAV bytes.
// JS POSTs it to /transcribe-chunk and feeds the result into the transcription store.
#[derive(Clone, Serialize)]
struct CloudChunk {
    audio: Vec<u8>,   // complete in-memory WAV (16kHz mono i16)
    speaker: String,  // "DU" | "MÖTET" (structured) or "MOLN" (merged)
    start: f64,       // seconds offset within the recording
    duration: f64,    // segmentets längd i sekunder → JS sätter end_time = start + duration
}

enum AudioInput {
    Mic(f32),
    System(f32),
}

// Data for Session Recorder (Full Mix)
struct SessionChunk {
    source: String, // "mic" or "sys"
    data: Vec<f32>,
}

// Shared state for the current recording session
struct SessionState {
    segments: Vec<Segment>,
    wav_path: Option<String>,
    start_time: Option<u128>, // SystemTime as millis
    pending_transcriptions: usize,
    duration_sec: f64,
}

pub struct AudioMonitor {
    is_running: Arc<Mutex<bool>>,
    is_recording: Arc<Mutex<bool>>,
    pub settings: Arc<Mutex<AudioSettings>>,
    session_state: Arc<Mutex<SessionState>>,
    /// Önskad mic-enhet (None = systemets default). Sätts av init_audio_engine och
    /// plockas upp av huvudloopens 2 s-poll — enhetsbyte kräver ingen motoromstart.
    desired_mic: Arc<Mutex<Option<String>>>,
}

#[derive(Serialize)]
pub struct AudioDevice {
    pub name: String,
    pub is_default: bool,
}

impl AudioMonitor {
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(Mutex::new(false)),
            is_recording: Arc::new(Mutex::new(false)),
            settings: Arc::new(Mutex::new(AudioSettings::default())),
            session_state: Arc::new(Mutex::new(SessionState {
                segments: Vec::new(),
                wav_path: None,
                start_time: None,
                pending_transcriptions: 0,
                duration_sec: 0.0,
            })),
            desired_mic: Arc::new(Mutex::new(None)),
        }
    }

    pub fn update_settings(&self, threshold: f32, silence_ms: u64, language: String) {
        let mut s = self.settings.lock().unwrap();
        s.vad_threshold = threshold;
        s.silence_duration_ms = silence_ms;
        s.language = language;
        println!("DEBUG: Updated Audio Settings: {:?}", s);
    }

    /// JS avgör (isPro + online + recordingMode + diariseringsläge) och sätter detta
    /// före start_recording. cloud_streaming=true → VAD-segment går till molnet, ingen
    /// lokal whisper-cli. merge_channels=true → Sammanhängande/1× (mixad MOLN-ström).
    pub fn set_cloud_mode(&self, cloud_streaming: bool, merge_channels: bool) {
        let mut s = self.settings.lock().unwrap();
        s.cloud_streaming = cloud_streaming;
        s.merge_channels = merge_channels;
        println!("DEBUG: Cloud mode set: streaming={}, merge={}", cloud_streaming, merge_channels);
    }

    pub fn get_input_devices(&self) -> Vec<AudioDevice> {
        let host = cpal::default_host();
        let default_in = host.default_input_device().and_then(|d| d.name().ok());
        
        let mut devices = Vec::new();
        if let Ok(in_devices) = host.input_devices() {
            for device in in_devices {
                if let Ok(name) = device.name() {
                    let is_default = default_in.as_ref() == Some(&name);
                    devices.push(AudioDevice { name, is_default });
                }
            }
        }
        devices
    }

    pub fn start(&self, app: AppHandle, input_device_name: Option<String>) -> Result<(), String> {
        println!("DEBUG: Entered init_audio_engine with device: {:?}", input_device_name);
        // Spara önskad enhet FÖRE running-checken: när motorn redan kör är detta hela
        // jobbet — huvudloopens 2 s-poll binder om mic-strömmen mot den nya enheten.
        // (Tidigare var enhetsbyte vid körande motor en tyst no-op.)
        *self.desired_mic.lock().unwrap() = input_device_name;
        let mut running = self.is_running.lock().unwrap();
        if *running {
            println!("DEBUG: Audio engine already running — mic rebind via main loop poll");
            return Ok(());
        }
        *running = true;
        let is_running = self.is_running.clone();
        let is_recording = self.is_recording.clone(); // Clone for threads
        let settings = self.settings.clone();
        let session_state = self.session_state.clone();
        let desired_mic = self.desired_mic.clone();

        thread::spawn(move || {
            let host = cpal::default_host();

            // Fail-loud helper: emit an `audio-error` event the UI can surface as a toast,
            // RESET is_running so a later init_audio_engine retry actually restarts the engine
            // (previously a panic here left is_running stuck `true` → engine silently dead),
            // then exit the thread cleanly.
            macro_rules! fail {
                ($msg:expr) => {{
                    let msg = $msg;
                    eprintln!("AUDIO ERROR: {}", msg);
                    let _ = app.emit("audio-error", msg);
                    *is_running.lock().unwrap() = false;
                    return
                }};
            }

            // Channel for aggregating VAD levels
            let (level_tx, level_rx) = unbounded::<AudioInput>();
            
            // Channel for Session Recording (Full Mix)
            let (session_tx, session_rx) = unbounded::<SessionChunk>();

            // Start Session Recorder Thread
            let app_handle_recorder = app.clone();
            let is_running_recorder = is_running.clone();
            let is_recording_recorder = is_recording.clone();
            let session_state_recorder = session_state.clone();
            let settings_recorder = settings.clone();

            thread::spawn(move || {
                start_session_recorder(session_rx, app_handle_recorder, is_running_recorder, is_recording_recorder, session_state_recorder, settings_recorder);
            });

            // --- Microphone Capture ---
            // Fail-loud vid motorstart: ingen mic alls → audio-error + motorn dör (en
            // senare init_audio_engine försöker igen). Därefter sköts enhetsbyten,
            // WASAPI-invalidering och självläkning av mic-rebind i huvudloopen nedan.
            let initial_mic = desired_mic.lock().unwrap().clone();
            let mut mic_capture = match build_mic_capture(
                &host, &app, &level_tx, &session_tx, &settings, &is_recording, &session_state,
                initial_mic,
            ) {
                Ok(c) => Some(c),
                Err(e) => fail!(e),
            };

            // --- System Loopback Capture ---
            // Loopbacken binds mot den AKTUELLA default-utgången och binds om i huvud-
            // loopen nedan när Windows byter utgång (hörlurar i/ur) eller när WASAPI
            // invaliderar endpointen — annars fortsätter fångsten mot en död enhet och
            // MÖTET-kanalen blir tyst trots att mic fungerar.
            let mut sys_capture = build_sys_capture(
                &host, &app, &level_tx, &session_tx, &settings, &is_recording, &session_state,
            );

             // --- Main Loop: Aggregating Levels & Keeping Alive ---
             let mut current_mic = 0.0;
             let mut current_sys = 0.0;
             let app_handle_main = app.clone();
             let mut last_log = Instant::now();

             let mut last_emit = Instant::now();

             // Enhetspolling var 2 s: rebind av loopbacken vid default-utgångsbyte.
             let mut last_device_poll = Instant::now();
             // Guardrail: engångsvarning per inspelning när molninspelning pågår men
             // inget systemljud fångas — annars upptäcks tyst MÖTET-kanal först efteråt.
             let mut last_sys_audible = Instant::now();
             // Some(start) medan en inspelning pågår — None däremellan (edge-detektering).
             let mut recording_since: Option<Instant> = None;
             let mut audio_warning_sent = false;
             // Engångstoast per mic-felepisod (nollställs vid lyckad rebind) —
             // fail-loud utan att spamma en toast var 2 s medan enheten saknas.
             let mut mic_error_emitted = false;

             loop {
                if !*is_running.lock().unwrap() {
                    break;
                }

                // Use a shorter timeout to stay responsive but drain messages
                match level_rx.recv_timeout(Duration::from_millis(20)) {
                    Ok(input) => {
                        match input {
                            AudioInput::Mic(v) => current_mic = v,
                            AudioInput::System(v) => {
                                current_sys = v;
                                // Loopback är digital: äkta tystnad är exakt 0.0. Högre
                                // tröskel skulle ge falsk varning vid tyst-men-närvarande
                                // ljud (lågt uppspelningsvolym).
                                if v > 0.0 {
                                    last_sys_audible = Instant::now();
                                }
                            },
                        }
                    },
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                        // Continue to check emission time
                    },
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                }

                // Throttle emissions to max 20Hz (every 50ms)
                if last_emit.elapsed() >= Duration::from_millis(50) {
                     let _ = app_handle_main.emit("audio-amplitude", AudioPayload {
                        mic: current_mic,
                        system: current_sys,
                    });
                    last_emit = Instant::now();
                }

                if last_log.elapsed() > Duration::from_secs(1) {
                    println!("DEBUG: RMS Levels - Mic: {:.4}, Sys: {:.4}", current_mic, current_sys);
                    last_log = Instant::now();
                }

                if last_device_poll.elapsed() >= Duration::from_secs(2) {
                    last_device_poll = Instant::now();

                    // --- Mic-rebind: enhetsbyte i Inställningar (desired ändrad), WASAPI-
                    // invalidering (failed-flaggan), default-mic-byte när "Standardenhet"
                    // är vald, eller självläkning när vald/någon mic dyker upp igen.
                    // Samma mönster som loopback-rebinden nedan, men fail-loud: misslyckad
                    // rebind → audio-error-toast; motorn lever vidare och försöker var 2 s.
                    let desired = desired_mic.lock().unwrap().clone();
                    let mic_needs_rebind = match &mic_capture {
                        Some(cap) => {
                            cap.failed.load(Ordering::SeqCst)
                                || cap.requested != desired
                                || match &desired {
                                    None => host.default_input_device()
                                        .and_then(|d| d.name().ok())
                                        .as_deref() != Some(cap.device_name.as_str()),
                                    // Vald enhet saknades vid bindningen (fallback till
                                    // default) — bind om så fort den finns igen.
                                    Some(name) => cap.device_name != *name
                                        && input_device_exists(&host, name),
                                }
                        }
                        None => true,
                    };
                    if mic_needs_rebind {
                        if let Some(cap) = mic_capture.take() {
                            println!(
                                "DEBUG: Rebinding mic (failed={}, old={:?}, desired={:?})",
                                cap.failed.load(Ordering::SeqCst), cap.device_name, desired
                            );
                            // Droppa gamla strömmen FÖRST — aldrig två aktiva mic-strömmar.
                            // Nedkopplad sample-kanal avslutar gamla processor-tråden, som
                            // force-flushar sitt pågående VAD-segment.
                            drop(cap);
                        }
                        current_mic = 0.0;
                        match build_mic_capture(
                            &host, &app, &level_tx, &session_tx, &settings, &is_recording, &session_state,
                            desired,
                        ) {
                            Ok(cap) => {
                                println!("DEBUG: Mic rebound to {:?}", cap.device_name);
                                mic_capture = Some(cap);
                                mic_error_emitted = false;
                            }
                            Err(e) => {
                                eprintln!("AUDIO ERROR: mic rebind failed: {}", e);
                                if !mic_error_emitted {
                                    mic_error_emitted = true;
                                    let _ = app.emit("audio-error", format!("Mikrofonfel: {}", e));
                                }
                            }
                        }
                    }

                    // Rebind när: strömmen felat (WASAPI invaliderar endpointen vid
                    // same-name-replug), default-utgångens namn ändrats, eller när vi
                    // saknar loopback men en utgång nu finns (gratis självläkning).
                    let default_out_name = host.default_output_device().and_then(|d| d.name().ok());
                    let needs_rebind = match &sys_capture {
                        Some(cap) => cap.failed.load(Ordering::SeqCst)
                            || default_out_name.as_deref() != Some(cap.device_name.as_str()),
                        None => default_out_name.is_some(),
                    };
                    if needs_rebind {
                        if let Some(cap) = sys_capture.take() {
                            println!(
                                "DEBUG: Rebinding system loopback (failed={}, old={:?}, new default={:?})",
                                cap.failed.load(Ordering::SeqCst), cap.device_name, default_out_name
                            );
                            // Droppa gamla strömmen FÖRST — aldrig två aktiva loopbacks.
                            // Nedkopplad sample-kanal avslutar gamla processor-tråden,
                            // som force-flushar sitt pågående VAD-segment.
                            drop(cap);
                        }
                        current_sys = 0.0;
                        sys_capture = build_sys_capture(
                            &host, &app, &level_tx, &session_tx, &settings, &is_recording, &session_state,
                        );
                        if sys_capture.is_some() {
                            // Ny enhet får en fräsch tystnadsfrist innan guardrail-varningen.
                            last_sys_audible = Instant::now();
                        }
                    }

                    // Guardrail "audio-warning": inspelning aktiv ≥ 10 s i molnläge utan
                    // loopback eller utan hörbart systemljud på ≥ 10 s → varna en gång.
                    if *is_recording.lock().unwrap() {
                        if recording_since.is_none() {
                            recording_since = Some(Instant::now());
                            last_sys_audible = Instant::now();
                            audio_warning_sent = false;
                        }
                    } else {
                        recording_since = None;
                    }

                    if let Some(started) = recording_since {
                        if !audio_warning_sent
                            && started.elapsed() >= Duration::from_secs(10)
                            && settings.lock().unwrap().cloud_streaming
                            && (sys_capture.is_none() || last_sys_audible.elapsed() >= Duration::from_secs(10))
                        {
                            audio_warning_sent = true;
                            let _ = app_handle_main.emit(
                                "audio-warning",
                                "Systemljud fångas inte — kontrollera ljudutgången",
                            );
                        }
                    }
                }
             }
             println!("DEBUG: Audio listener loop exited");
        });

        Ok(())
    }

    pub fn start_recording(&self) -> Result<(), String> {
        let mut rec = self.is_recording.lock().unwrap();
        *rec = true;
        println!("DEBUG: Recording START signal sent");
        // Reset session state
        let mut session = self.session_state.lock().unwrap();
        session.segments.clear();
        session.wav_path = None;
        session.start_time = Some(SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
        session.pending_transcriptions = 0;
        session.duration_sec = 0.0;
        
        Ok(())
    }

    pub fn stop_recording(&self) -> Result<(), String> {
        let mut rec = self.is_recording.lock().unwrap();
        *rec = false;
        println!("DEBUG: Recording STOP signal sent");
        Ok(())
    }

    pub fn stop(&self) {
        let mut running = self.is_running.lock().unwrap();
        *running = false;
        println!("DEBUG: Stop signal sent");
    }
}

// Keep the stream alive by binding it to a variable, instead of forgetting it
// This ensures it drops when the thread exits (which happens when loop breaks)
// StreamGuard removed (unused)

// Unsafe impl for StreamGuard removed (unused) 
// Wait, we can't move StreamGuard into the thread if it's not Send.
// But the stream is created inside the thread. So we just need to keep it in a variable.
// No need for Send wrapper if distinct variable.



/// Aktiv mic-fångst mot en specifik (eller default-) ingångsenhet. Samma drop-semantik
/// som SysCapture: droppad ström kopplar ner sample-kanalen, processor-tråden avslutas
/// och force-flushar pågående VAD-segment.
struct MicCapture {
    /// Håller cpal-strömmen vid liv; drop = stoppa fångsten.
    _stream: cpal::Stream,
    /// Faktiskt bundet enhetsnamn — jämförs mot aktuell default-ingång var 2 s
    /// när ingen specifik enhet är vald.
    device_name: String,
    /// Enhetsnamnet som begärdes vid bindningen (None = default). Skiljer sig från
    /// device_name vid fallback — jämförs mot desired_mic så att en fallback inte
    /// triggar rebind varje poll.
    requested: Option<String>,
    /// Sätts av cpal:s error-callback när endpointen invalideras → trigga rebind.
    failed: Arc<AtomicBool>,
}

/// Bygger mic-fångsten mot begärd enhet (fallback: default-ingång) och spawnar dess
/// processor-tråd. Till skillnad från best-effort-build_sys_capture är felvägen Result:
/// anroparen avgör om felet är fatalt (motorstart → fail!) eller toast + retry var 2 s
/// (rebind i huvudloopen) — mic-vägen är alltid fail-loud, aldrig tyst.
fn build_mic_capture(
    host: &cpal::Host,
    app: &AppHandle,
    level_tx: &Sender<AudioInput>,
    session_tx: &Sender<SessionChunk>,
    settings: &Arc<Mutex<AudioSettings>>,
    is_recording: &Arc<Mutex<bool>>,
    session_state: &Arc<Mutex<SessionState>>,
    requested: Option<String>,
) -> Result<MicCapture, String> {
    let mic_device_opt = if let Some(ref name) = requested {
        find_input_device(host, name).or_else(|| {
            println!("DEBUG: Requested device not found, falling back to default");
            host.default_input_device()
        })
    } else {
        host.default_input_device()
    };
    let mic_device = match mic_device_opt {
        Some(d) => d,
        None => return Err("Ingen mikrofon hittades. Anslut en mikrofon och försök igen.".to_string()),
    };
    let device_name = mic_device.name().unwrap_or_default();
    println!("DEBUG: Selected input device: {:?}", device_name);

    let mic_config = mic_device.default_input_config()
        .map_err(|e| format!("Kunde inte läsa mikrofonens konfiguration: {}", e))?;

    let (mic_sample_tx, mic_sample_rx) = unbounded::<f32>();
    let mic_sample_rate = mic_config.sample_rate().0;
    let failed = Arc::new(AtomicBool::new(false));

    // Felflaggan ger mic:en samma same-name-replug-läkning som loopbacken: WASAPI
    // invaliderar endpointen → error-callback → rebind i huvudloopen.
    let mic_stream_res = match mic_config.sample_format() {
        cpal::SampleFormat::F32 => run_stream::<f32>(&mic_device, &mic_config.clone().into(), mic_sample_tx, Some(failed.clone())),
        cpal::SampleFormat::I16 => run_stream::<i16>(&mic_device, &mic_config.clone().into(), mic_sample_tx, Some(failed.clone())),
        cpal::SampleFormat::U16 => run_stream::<u16>(&mic_device, &mic_config.clone().into(), mic_sample_tx, Some(failed.clone())),
        fmt => return Err(format!("Ljudformatet stöds inte: {:?}", fmt)),
    };
    let stream = mic_stream_res.map_err(|e| format!("Kunde inte skapa mikrofonström: {}", e))?;
    stream.play().map_err(|e| format!("Kunde inte starta mikrofonström: {}", e))?;
    println!("DEBUG: Mic stream started on {:?}", device_name);

    // Processor-tråden får nya enhetens samplerate → korrekt resample-ratio.
    // Kloner av samma session_tx/level_tx → DU-segment och SessionChunks
    // fortsätter in i pågående session efter en rebind.
    let app_handle_mic = app.clone();
    let settings_mic = settings.clone();
    let is_recording_mic = is_recording.clone();
    let session_state_mic = session_state.clone();
    let mic_level_tx = level_tx.clone();
    let mic_session_tx = session_tx.clone();

    thread::spawn(move || {
        process_audio_stream(
            mic_sample_rx,
            mic_sample_rate,
            "DU",
            app_handle_mic,
            Some((mic_level_tx, true)),
            settings_mic,
            Some(("mic".to_string(), mic_session_tx)),
            is_recording_mic,
            session_state_mic,
        );
    });

    Ok(MicCapture { _stream: stream, device_name, requested, failed })
}

/// Hittar ingångsenheten med exakt detta namn, om den finns just nu.
fn find_input_device(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    host.input_devices().ok()?
        .find(|d| d.name().map(|n| n == name).unwrap_or(false))
}

/// Finns en ingångsenhet med exakt detta namn just nu? (För självläkning: vald enhet
/// som saknades vid bindningen binds om så fort den dyker upp igen.)
fn input_device_exists(host: &cpal::Host, name: &str) -> bool {
    find_input_device(host, name).is_some()
}

/// Aktiv WASAPI-loopback mot en specifik utgångsenhet. När strömmen droppas kopplas
/// sample-kanalen ner, processor-tråden avslutar sin `for sample in rx`-loop och
/// force-flushar pågående VAD-segment — gamla trådar städar alltså sig själva.
struct SysCapture {
    /// Håller cpal-strömmen vid liv; drop = stoppa fångsten.
    _stream: cpal::Stream,
    /// Enhetsnamnet vid bindning — jämförs mot aktuell default-utgång var 2 s.
    device_name: String,
    /// Sätts av cpal:s error-callback när endpointen invalideras → trigga rebind.
    failed: Arc<AtomicBool>,
}

/// Bygger systemljudfångsten (WASAPI-loopback) mot AKTUELL default-utgång och spawnar
/// dess processor-tråd. Best-effort: alla felvägar → None (mic-vägen dör aldrig av
/// saknat systemljud). Anropas vid motorstart och vid varje rebind i huvudloopen.
fn build_sys_capture(
    host: &cpal::Host,
    app: &AppHandle,
    level_tx: &Sender<AudioInput>,
    session_tx: &Sender<SessionChunk>,
    settings: &Arc<Mutex<AudioSettings>>,
    is_recording: &Arc<Mutex<bool>>,
    session_state: &Arc<Mutex<SessionState>>,
) -> Option<SysCapture> {
    let sys_device = match host.default_output_device() {
        Some(d) => d,
        None => {
            eprintln!("DEBUG: No output device found");
            return None;
        }
    };
    let device_name = sys_device.name().unwrap_or_default();
    println!("DEBUG: Default output device: {:?}", device_name);

    let sys_config = match sys_device.default_output_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("DEBUG: Failed to read output config: {}", e);
            return None;
        }
    };

    let (sys_sample_tx, sys_sample_rx) = unbounded::<f32>();
    let sys_sample_rate = sys_config.sample_rate().0;
    let sys_stream_config: cpal::StreamConfig = sys_config.clone().into();
    let failed = Arc::new(AtomicBool::new(false));

    // Loopback levereras interleavat (oftast stereo). run_stream medel-
    // värdesbildar kanalerna per frame till mono — precis som mic-vägen.
    // Att skicka råa interleavade samples som mono gav MÖTET-ljud i halv
    // hastighet (en oktav ner) i både live-transkriberingen och sessions-
    // WAV:en, vilket förstörde kvaliteten för lokal OCH moln-transkribering.
    let sys_stream_res = match sys_config.sample_format() {
        cpal::SampleFormat::F32 => run_stream::<f32>(&sys_device, &sys_stream_config, sys_sample_tx, Some(failed.clone())),
        cpal::SampleFormat::I16 => run_stream::<i16>(&sys_device, &sys_stream_config, sys_sample_tx, Some(failed.clone())),
        cpal::SampleFormat::U16 => run_stream::<u16>(&sys_device, &sys_stream_config, sys_sample_tx, Some(failed.clone())),
        fmt => {
            eprintln!("DEBUG: Ljudformatet stöds inte för systemljud: {:?}", fmt);
            return None;
        }
    };

    let stream = match sys_stream_res {
        Ok(s) => s,
        Err(e) => {
            eprintln!("DEBUG: Failed to build system stream: {}", e);
            return None;
        }
    };
    if let Err(e) = stream.play() {
        // System loopback is best-effort: log and continue with mic only,
        // never kill the engine over missing system audio.
        eprintln!("DEBUG: Failed to start system stream (continuing mic-only): {}", e);
        return None;
    }
    println!("DEBUG: System stream started on {:?}", device_name);

    // Processor-tråden får nya enhetens samplerate → korrekt resample-ratio.
    // Kloner av samma session_tx/level_tx → MÖTET-segment och SessionChunks
    // fortsätter in i pågående session efter en rebind.
    let app_handle_sys = app.clone();
    let settings_sys = settings.clone();
    let is_recording_sys = is_recording.clone();
    let session_state_sys = session_state.clone();
    let sys_level_tx = level_tx.clone();
    let sys_session_tx = session_tx.clone();

    thread::spawn(move || {
        process_audio_stream(
            sys_sample_rx,
            sys_sample_rate,
            "MÖTET",
            app_handle_sys,
            Some((sys_level_tx, false)),
            settings_sys,
            Some(("sys".to_string(), sys_session_tx)),
            is_recording_sys,
            session_state_sys,
        );
    });

    Some(SysCapture { _stream: stream, device_name, failed })
}

fn run_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    tx: Sender<f32>,
    error_flag: Option<Arc<AtomicBool>>,
) -> Result<cpal::Stream, String>
where
    T: cpal::Sample + cpal::SizedSample + 'static + num_traits::cast::ToPrimitive,
{
    let tx = tx.clone();
    let channels = config.channels as usize;
    device.build_input_stream(
        config,
        move |data: &[T], _: &_| {
            for frame in data.chunks(channels) {
                let mut sum = 0.0;
                for sample in frame {
                    let val = (*sample).to_f32().unwrap_or(0.0);
                    if !val.is_nan() && !val.is_infinite() {
                        sum += val;
                    }
                }
                let avg = sum / channels as f32;
                let _ = tx.send(if avg.is_nan() { 0.0 } else { avg });
            }
        },
        move |err| {
            eprintln!("Stream error: {}", err);
            // Sys-loopbacken pollar flaggan var 2 s och binder om strömmen. Fångar
            // same-name-replug där WASAPI invaliderar endpointen utan att default-
            // utgångens namn ändras.
            if let Some(ref flag) = error_flag {
                flag.store(true, Ordering::SeqCst);
            }
        },
        None,
    ).map_err(|e| e.to_string())
}

fn process_audio_stream(
    rx: Receiver<f32>, 
    input_rate: u32, 
    source_label: &str, 
    app: AppHandle,
    level_info: Option<(Sender<AudioInput>, bool)>,
    settings: Arc<Mutex<AudioSettings>>,
    session_sender: Option<(String, Sender<SessionChunk>)>,
    is_recording: Arc<Mutex<bool>>,
    session_state: Arc<Mutex<SessionState>>,
) {
    println!("DEBUG: Starting processor for {}", source_label);
    
    let ratio = SAMPLE_RATE as f64 / input_rate as f64;
    let target_chunk = 800; // 800 samples @ 16kHz = 50ms = 20Hz updates
    let input_chunk_size = (target_chunk as f64 / ratio).ceil() as usize;

    // Use a VecDeque for continuous rolling buffer (Pre-roll)
    let mut pre_roll_buffer: VecDeque<f32> = VecDeque::with_capacity(PRE_ROLL_SAMPLES);
    
    let mut speech_buffer: Vec<f32> = Vec::new();
    let mut is_speaking = false;
    let mut silence_start = Instant::now();
    let mut count = 0;
    // input_buffer needs to be a ring buffer to handle variable chunk sizes from cpal safely
    let mut input_buffer: VecDeque<f32> = VecDeque::with_capacity(input_chunk_size * 2); 
    
    // Talstart-tidsstämpel relativ till inspelningsstart (delad sessionsklocka, ms sedan epoch).
    // Båda kanalerna (mic/sys) jämförs mot samma session.start_time → korrekt ordning i vyn.
    let mut speech_start_ms: u128 = 0;

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 128,
        window: WindowFunction::BlackmanHarris2,
    };

    // Ingen panik vid exotiska enhetsformat: tråden avslutas rent och rebind-loopen
    // försöker igen (sys), respektive fail-loud-vägen tar mic-fel vid motorstart.
    let mut resampler = match SincFixedIn::<f32>::new(
        ratio,
        2.0, // max deviation
        params,
        input_chunk_size,
        1
    ) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("ERROR: Failed to init resampler for {} (input rate {}): {}", source_label, input_rate, e);
            return;
        }
    };

    let mut rubato_input = vec![vec![0.0; input_chunk_size]; 1];

    for sample in rx {
        input_buffer.push_back(sample);
        
        // Only process when we have enough data for a full chunk
        if input_buffer.len() >= input_chunk_size {
             
             // Copy exactly input_chunk_size samples to rubato_input
             for i in 0..input_chunk_size {
                 rubato_input[0][i] = input_buffer[i];
             }
             
             // Remove processed samples from input_buffer (Ring buffer behavior)
             // This preserves any "extra" samples (e.g. 2401st sample) for next iteration
             input_buffer.drain(0..input_chunk_size);
             
             count += 1;

             // Calculate Input RMS for debugging (Check if source is silent)
             if cfg!(debug_assertions) && count % 100 == 0 { // Log occasionally
                 let mut in_sq = 0.0;
                 for x in &rubato_input[0] { in_sq += x * x; }
                 let in_rms = (in_sq / input_chunk_size as f32).sqrt();
                 if in_rms < 0.001 {
                      println!("DEBUG: Input Silence Detected on {} (RMS: {:.6})", source_label, in_rms);
                 }
             }

             let resampled_output_res = resampler.process(&rubato_input, None);
             
             if let Ok(output) = resampled_output_res {
                 let output_data = &output[0];

                 let mut sum_squares = 0.0;
                 for &x in output_data {
                     sum_squares += x * x;
                 }
                 let chunk_rms = (sum_squares / output_data.len() as f32).sqrt();
                 
                 // Send level update
                 if let Some((ref tx, is_mic)) = level_info {
                     let input = if is_mic { AudioInput::Mic(chunk_rms) } else { AudioInput::System(chunk_rms) };
                     let _ = tx.send(input);
                 }

                 // Send to Session Recorder ONLY if recording
                 if *is_recording.lock().unwrap() {
                     if let Some((ref tag, ref tx)) = session_sender {
                         let chunk_copy = output_data.to_vec();
                         let _ = tx.send(SessionChunk {
                             source: tag.clone(),
                             data: chunk_copy,
                         });
                     }
                 }

                 // Read current settings (needed in both recording and flush paths)
                 let (threshold, silence_duration, whisper_lang, cloud_streaming, merge_channels) = {
                    let s = settings.lock().unwrap();
                    (s.vad_threshold, s.silence_duration_ms as u128, s.language.clone(), s.cloud_streaming, s.merge_channels)
                 };

                 // Gate VAD logic behind is_recording
                 if !*is_recording.lock().unwrap() {
                     // If not recording, prevent state buildup and clear buffers
                     if !speech_buffer.is_empty() {
                         // Flush whatever is in the buffer if we just stopped recording
                         let duration_ms = (speech_buffer.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
                         if duration_ms > 100 { // Only flush if meaningful data (>0.1s)
                            println!("DEBUG: Recording stopped, flushing pending speech buffer on {} ({}ms)", source_label, duration_ms);
                            let start_offset = session_offset(&session_state, speech_start_ms);
                            dispatch_segment(&speech_buffer, source_label, &app, session_state.clone(), start_offset, whisper_lang.clone(), cloud_streaming, merge_channels);
                         } else {
                            println!("DEBUG: Recording stopped, dropping short buffer on {} ({}ms)", source_label, duration_ms);
                         }
                         
                         is_speaking = false;
                         speech_buffer.clear();
                     }
                     // Reset time tracking relative to recording start in session recorder? 
                     // No, process_audio_stream runs continuously. 
                     // The session recorder tracks the actual file time.
                     // But for transcription timestamps to align with the file, we need to sync with "Recording Start".
                     // However, we are tracking total_16k_samples since APP START here.
                     // The Session Recorder starts writing at strict 16k.
                     // Ideally we should reset `total_16k_samples` when recording starts?
                     // BUT, pre-roll buffer exists!
                     // If we reset, we might mess up pre-roll timestamp.
                     // Simple solution: When `is_recording` becomes true, we capture `recording_start_sample = total_16k_samples`.
                     // Then always subtract it.
                     // We need to detect edge up of is_recording.
                     // But we are in a tight loop.
                     // Let's just pass `start_offset` relative to THIS STREAM. 
                     // AND we need to know when recording started to align?
                     // Let's assume the user presses record -> that is T=0 for the file.
                     // We need to substract `recording_start_global_sample`.
                     // This is getting complicated to sync perfectly.
                     // MVP: Use `speech_start_sample` which is relative to process start.
                     // Effectively, the timestamp will be "Time since app start".
                     // Ideally we want "Time since recording start".
                     // The `SessionState` has `start_time` (SystemTime).
                     // We can't use that easily with sample counts.
                     // Let's just leave it as relative to stream start for now, or just 0-based per segment?
                     // NO, DB expects `start_time` relative to recording.
                     // Let's add `recording_start_sample_offset: Option<u64>` to track when record started.
                     continue; 
                 }
                 
                 // We are recording. Check if we just started.
                 // Ideally we'd detect the transition false->true. 
                 // But we can just rely on `start_session_recorder` which aligns the WAV.
                 // For now, let's pass `speech_start_sample` and we can maybe adjust it later if we want perfect sync.
                 // Actually, if we just use `start = 0` for the first segment?
                 // Let's pass `speech_start_sample` simply.

                 // Maintain Pre-roll Buffer
                 // We add the new chunk to pre-roll
                 for &s in output_data {
                     if pre_roll_buffer.len() >= PRE_ROLL_SAMPLES {
                         pre_roll_buffer.pop_front();
                     }
                     pre_roll_buffer.push_back(s);
                 }
                 
                 if is_speaking {
                     // During speech, we also append to speech_buffer
                     speech_buffer.extend_from_slice(output_data);
                     
                     // Hysteresis: Use lower threshold to sustain speech
                     if chunk_rms > threshold {
                         silence_start = Instant::now(); // Reset silence timer
                     } else {
                         if silence_start.elapsed().as_millis() > silence_duration {
                            // End of speech candidate
                            let duration_ms = (speech_buffer.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
                            
                            // Only cut if we have enough audio for a sentence (3s), OR if we are silent for a VERY long time?
                            // No, user wants: "Om tystnad uppstår innan 3 sekunder har gått, fortsätt vänta på mer tal."
                            if duration_ms < MIN_SEGMENT_DURATION_MS {
                                println!("DEBUG: Silence detected but segment too short ({}ms < {}ms). Waiting...", duration_ms, MIN_SEGMENT_DURATION_MS);
                                // We do NOT reset silence_start here because we want to track true silence duration?
                                // Actually if we don't reset silence_start, we will re-enter this block immediately next chunk.
                                // We should probably reset silence_start to allow another chance?
                                // OR: We just don't cut. But if silence continues forever?
                                // If silence continues, we will keep hitting this block.
                                // We need to differentiate "silence timeout" from "final cut".
                                // If we don't cut, we just keep adding silence to speech_buffer?
                                // Yes, that is effectively "waiting for more speech".
                                // But if user stops talking completely after 1s? Then we wait forever?
                                // No, MAX_SEGMENT_DURATION_MS will eventually trigger flush at 15s.
                                // This seems to be what is requested: "wait for more speech".
                            } else {
                                // Duration > 3s AND Silence > 1.2s -> END
                                println!("DEBUG: Speech ENDED on {} (Total Duration: {}ms, Samples: {})", source_label, duration_ms, speech_buffer.len());
                                is_speaking = false;
                                
                                // Check minimum recording duration (sanity check, keeping 1s limit)
                                if duration_ms > MIN_RECORDING_DURATION_MS {
                                    let start_offset = session_offset(&session_state, speech_start_ms);
                                    dispatch_segment(&speech_buffer, source_label, &app, session_state.clone(), start_offset, whisper_lang.clone(), cloud_streaming, merge_channels);
                                } else {
                                    println!("DEBUG: Ignoring short speech segment (< {}ms) on {}", MIN_RECORDING_DURATION_MS, source_label);
                                }
                                speech_buffer.clear();
                            }
                         }
                     }
                     
                     // Safety check: Max segment length
                     if is_speaking {
                         let current_dur = (speech_buffer.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
                         // Moln tål längre chunks (bättre kvalitet); lokal small behöver korta (latens).
                         let max_dur = if cloud_streaming { CLOUD_MAX_SEGMENT_DURATION_MS } else { MAX_SEGMENT_DURATION_MS };
                         if current_dur > max_dur {
                             println!("DEBUG: Max segment length reached ({}ms) on {}. Forcing flush.", current_dur, source_label);
                             let start_offset = session_offset(&session_state, speech_start_ms);
                             dispatch_segment(&speech_buffer, source_label, &app, session_state.clone(), start_offset, whisper_lang.clone(), cloud_streaming, merge_channels);
                             // Behåll en kort lead-in (slutet av segmentet) så whisper inte tappar
                             // de första orden i nästa chunk vid abrupt klippstart.
                             let lead = speech_buffer.len().saturating_sub(CHUNK_LEAD_IN_SAMPLES);
                             let tail: Vec<f32> = speech_buffer[lead..].to_vec();
                             speech_buffer.clear();
                             speech_buffer.extend_from_slice(&tail);
                             // Reset silence timer to keep recording if still talking, but treated as new chunk
                             silence_start = Instant::now();
                             // Nästa chunk börjar vid lead-in:ens start (delad väggklocka).
                             let lead_ms = (tail.len() as f64 / SAMPLE_RATE as f64 * 1000.0) as u128;
                             speech_start_ms = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().saturating_sub(lead_ms);
                         }
                     }
                 } else {
                     // Not currently speaking
                     if chunk_rms > threshold {
                         // Speech START
                         is_speaking = true;
                         println!("DEBUG: Speech TRIGGERED on {} at RMS: {:.4}", source_label, chunk_rms);
                         silence_start = Instant::now();
                         
                         // Start new speech buffer with Pre-roll content
                         speech_buffer.clear();
                         speech_buffer.extend(pre_roll_buffer.iter());
                         // And add current chunk (already in pre-roll, but double adding logic? No, output_data is latest)
                         // Wait, we added output_data to pre_roll_buffer above.
                         // So speech_buffer now contains pre-roll + current chunk.
                         // Correct.
                         
                         // Talstart = nu minus pre-roll-längden, mätt mot delad väggklocka.
                         let pre_roll_ms = (pre_roll_buffer.len() as f64 / SAMPLE_RATE as f64 * 1000.0) as u128;
                         let now_ms = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
                         speech_start_ms = now_ms.saturating_sub(pre_roll_ms);
                     }
                 }
             }

        }
    }
    
    // Force flush on stream exit (Stop button or disconnect)
    if !speech_buffer.is_empty() {
        let duration_ms = (speech_buffer.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
        if duration_ms > 500 { // Minimal sanity check for force flush
            println!("DEBUG: Force flushing speech buffer on {} (Duration: {}ms)", source_label, duration_ms);
            let start_offset = session_offset(&session_state, speech_start_ms);
            let (whisper_lang, cloud_streaming, merge_channels) = {
                let s = settings.lock().unwrap();
                (s.language.clone(), s.cloud_streaming, s.merge_channels)
            };
            dispatch_segment(&speech_buffer, source_label, &app, session_state.clone(), start_offset, whisper_lang, cloud_streaming, merge_channels);
        }
    }
}

/// Routes a finished VAD speech segment to the right transcriber:
/// - cloud_streaming + merge_channels → no-op here (the session recorder emits the mixed
///   "MOLN" stream so we don't pay 2× by also streaming each channel).
/// - cloud_streaming → ship the segment to the cloud (kb-whisper-large), tagged DU/MÖTET.
/// - otherwise → local whisper-cli (FREE tier / offline fallback), unchanged behaviour.
fn dispatch_segment(
    data: &[f32],
    source: &str,
    app: &AppHandle,
    session_state: Arc<Mutex<SessionState>>,
    start_offset: f64,
    language: String,
    cloud_streaming: bool,
    merge_channels: bool,
) {
    if cloud_streaming {
        if merge_channels {
            return; // mixed path handled in start_session_recorder
        }
        emit_cloud_chunk(data, source, app, start_offset);
    } else {
        transcribe(data, source, app, session_state, start_offset, language);
    }
}

/// Encodes a speech segment to an in-memory 16kHz mono WAV and emits it to JS as
/// `cloud-chunk-ready`. JS POSTs it to /transcribe-chunk and feeds the text into the
/// transcription store. No temp files — keeps the security surface and cleanup trivial.
fn emit_cloud_chunk(data: &[f32], source: &str, app: &AppHandle, start_offset: f64) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut writer = match hound::WavWriter::new(&mut cursor, spec) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("ERROR: cloud chunk wav writer: {}", e);
                return;
            }
        };
        let amplitude = i16::MAX as f32;
        for &s in data {
            let v = if s.is_nan() || s.is_infinite() { 0.0 } else { s };
            let _ = writer.write_sample((v * amplitude) as i16);
        }
        if let Err(e) = writer.finalize() {
            eprintln!("ERROR: finalize cloud chunk: {}", e);
            return;
        }
    }

    let bytes = cursor.into_inner();
    let duration = data.len() as f64 / SAMPLE_RATE as f64;
    println!("DEBUG: Emitting cloud chunk ({}) — {} bytes, start={:.2}s dur={:.2}s", source, bytes.len(), start_offset, duration);
    let _ = app.emit("cloud-chunk-ready", CloudChunk {
        audio: bytes,
        speaker: source.to_string(),
        start: start_offset,
        duration,
    });
}

fn transcribe(
    data: &[f32],
    source: &str,
    app: &AppHandle,
    session_state: Arc<Mutex<SessionState>>,
    start_offset: f64,
    language: String,
) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let temp_dir = std::env::temp_dir();
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros();
    let filename = temp_dir.join(format!("whisper_{}_{}.wav", source, timestamp));
    
    // Increment pending BEFORE spawning
    {
        let mut state = session_state.lock().unwrap();
        state.pending_transcriptions += 1;
    }

    let mut writer = match hound::WavWriter::create(&filename, spec) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("ERROR: Failed to create wav writer: {}", e);
            let mut state = session_state.lock().unwrap();
            state.pending_transcriptions -= 1;
            return;
        }
    };

    let amplitude = i16::MAX as f32;
    for &sample in data {
        let _ = writer.write_sample((sample * amplitude) as i16);
    }
    match writer.finalize() {
        Ok(_) => {},
        Err(e) => {
            eprintln!("ERROR: Failed to finalize wav: {}", e);
            let mut state = session_state.lock().unwrap();
            state.pending_transcriptions -= 1;
            return;
        }
    }

    let file_path = filename.to_string_lossy().to_string();
    let handle = app.clone();
    let source_clone = source.to_string();
    let session_state_clone = session_state.clone();
    let duration_sec = data.len() as f64 / SAMPLE_RATE as f64;
    // Vilken session detta segment tillhör — om generationen ändras (ny inspelning/avbryt)
    // innan vi kört klart slängs resultatet i stället för att läcka in i nästa session.
    let my_gen = current_session_generation();

    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::ShellExt;
        
        let path_buf = std::path::PathBuf::from(&file_path);
        let path_str = path_buf.to_string_lossy().to_string();
         let clean_filename = if path_str.starts_with("\\\\?\\") {
            path_str[4..].to_string()
        } else {
            path_str.to_string()
        };

        // 1. Resolve Root Path dynamically from current executable
        let current_exe = match std::env::current_exe() {
             Ok(exe) => exe,
             Err(e) => {
                 let err_msg = format!("Kunde inte hitta exe-sökväg: {}", e);
                 eprintln!("ERROR: {}", err_msg);
                 let _ = handle.emit("transcription-error", err_msg);
                 let mut state = session_state_clone.lock().unwrap();
                 state.pending_transcriptions -= 1;
                 drop(state);
                 try_save_session(&handle, &session_state_clone);
                 return;
             }
         };

         let app_dir = match current_exe.parent() {
              Some(dir) => dir,
              None => {
                  let err_msg = "Kunde inte hitta appens modermapp.".to_string();
                  eprintln!("ERROR: {}", err_msg);
                  let _ = handle.emit("transcription-error", err_msg);
                  let mut state = session_state_clone.lock().unwrap();
                  state.pending_transcriptions -= 1;
                  drop(state);
                  try_save_session(&handle, &session_state_clone);
                  return;
              }
         };

        // 2. Resolve model path
        let path_root = app_dir.join("models").join("ggml-kb-whisper-small.bin");
        let path_resources = app_dir.join("resources").join("models").join("ggml-kb-whisper-small.bin");

        let mut model_path_buf = if path_root.exists() {
            path_root.clone()
        } else if path_resources.exists() {
            path_resources.clone()
        } else {
            path_root.clone()
        };
        
        // Development fallback — excluded from release builds entirely
        #[cfg(debug_assertions)]
        if !model_path_buf.exists() {
             let fallback = std::path::PathBuf::from("d:/Programering/swedish-whisper-engine/desktop/src-tauri/resources/models/ggml-kb-whisper-small.bin");
             if fallback.exists() {
                 model_path_buf = fallback;
             }
        }

        if !model_path_buf.exists() {
             let err_msg = format!("Modell saknas. Letade i: '{}' OCH '{}'", path_root.display(), path_resources.display());
             println!("ERROR: {}", err_msg);
             let _ = handle.emit("transcription-error", err_msg);
             let mut state = session_state_clone.lock().unwrap();
             state.pending_transcriptions -= 1;
             drop(state);
             try_save_session(&handle, &session_state_clone);
             return;
        }

        let resource_path_str = model_path_buf.to_string_lossy().to_string();
        let clean_resource_path = if resource_path_str.starts_with("\\\\?\\") {
            resource_path_str[4..].to_string()
        } else {
            resource_path_str.to_string()
        };
        
        let shell = handle.shell();
        
        // 3. Resolve binaries/DLL path and Sidecar Executable Path
        let dll_path_portable = app_dir.join("binaries");
        let dll_path_root = app_dir.to_path_buf();

        let find_whisper_cli = |dir: &std::path::Path| -> Option<std::path::PathBuf> {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.filter_map(Result::ok) {
                    let path = entry.path();
                    if path.is_file() {
                        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                            if name.starts_with("whisper-cli") && name.ends_with(".exe") {
                                return Some(path);
                            }
                        }
                    }
                }
            }
            None
        };

        let (mut dll_path, mut sidecar_exe_path) = if let Some(exe) = find_whisper_cli(&dll_path_portable) {
            (dll_path_portable.clone(), exe)
        } else if let Some(exe) = find_whisper_cli(&dll_path_root) {
            (dll_path_root.clone(), exe)
        } else {
            (dll_path_portable.clone(), dll_path_portable.join("whisper-cli-fallback.exe"))
        };

        // Development fallback — excluded from release builds entirely
        #[cfg(debug_assertions)]
        if !sidecar_exe_path.exists() || !dll_path.exists() {
             let fallback_dll = std::path::PathBuf::from("d:/Programering/swedish-whisper-engine/desktop/src-tauri/binaries");
             let fallback_exe = fallback_dll.join("whisper-cli-x86_64-pc-windows-msvc.exe");
             if fallback_exe.exists() {
                 dll_path = fallback_dll;
                 sidecar_exe_path = fallback_exe;
             }
        }

        if !sidecar_exe_path.exists() || !dll_path.exists() {
             let mut found_files = Vec::new();
             if let Ok(entries) = std::fs::read_dir(&dll_path_root) {
                 for entry in entries.filter_map(Result::ok).take(20) {
                     if let Some(name) = entry.file_name().to_str() {
                         found_files.push(name.to_string());
                     }
                 }
             }
             if let Ok(entries) = std::fs::read_dir(&dll_path_portable) {
                 for entry in entries.filter_map(Result::ok).take(20) {
                     if let Some(name) = entry.file_name().to_str() {
                         found_files.push(format!("binaries/{}", name));
                     }
                 }
             }
             let err_msg = format!("Sidecar saknas. Hittade dessa filer i mappen: {:?}", found_files);
             println!("ERROR: {}", err_msg);
             let _ = handle.emit("transcription-error", err_msg);
             let mut state = session_state_clone.lock().unwrap();
             state.pending_transcriptions -= 1;
             drop(state);
             try_save_session(&handle, &session_state_clone);
             return;
        }

        let dll_path_str = dll_path.to_string_lossy().to_string();
        let clean_dll_path_str = if dll_path_str.starts_with("\\\\?\\") {
            dll_path_str[4..].to_string()
        } else {
            dll_path_str.to_string()
        };
        let clean_dll_path = std::path::PathBuf::from(&clean_dll_path_str);
        
        let sidecar_env = if cfg!(target_os = "windows") {
            let current_path = std::env::var("PATH").unwrap_or_default();
            let resources_dir = app_dir.join("resources");
            let binaries_dir = app_dir.join("binaries");
            format!("{};{};{};{};{}",  
                clean_dll_path.to_string_lossy(),
                model_path_buf.parent().unwrap().to_string_lossy(),
                resources_dir.display(),
                binaries_dir.display(),
                current_path
            )
        } else {
            String::new()
        };

        let mut cmd = std::process::Command::new(&sidecar_exe_path);
        
        if cfg!(target_os = "windows") {
             cmd.env("PATH", sidecar_env.clone());
             cmd.current_dir(&clean_dll_path);
        }

        // Greedy decoding (beam_size=1, best_of=1): 3-5x faster than beam search.
        // Slight accuracy tradeoff is acceptable for live transcription.
        // -t N: use up to 4 CPU threads per process to further reduce latency.
        let num_threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4).to_string())
            .unwrap_or_else(|_| "4".to_string());

        let args = vec![
            "-m", &clean_resource_path,
            "-f", &clean_filename,
            "-l", &language,
            "-t", &num_threads,
            "--beam-size", "1",
            "--best-of", "1",
        ];

        cmd.args(&args);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        use std::process::Stdio;
        use std::io::{BufRead, BufReader};

        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        // Acquire semaphore before spawning — limits concurrent whisper-cli processes to 2.
        // Without this, 5+ simultaneous processes starve each other and all finish too late.
        let _permit = transcription_semaphore()
            .acquire()
            .await
            .expect("Transcription semaphore closed");

        // Avbruten i kön: ny inspelning startade eller användaren tryckte Avbryt medan vi
        // väntade på semaforen → kör aldrig whisper-cli, släpp pending och avsluta.
        if current_session_generation() != my_gen {
            println!("[gen] Skippar köad transkribering (generation ändrad)");
            let mut state = session_state_clone.lock().unwrap();
            if state.pending_transcriptions > 0 { state.pending_transcriptions -= 1; }
            drop(state);
            try_save_session(&handle, &session_state_clone);
            return;
        }

        match cmd.spawn() {
            Ok(mut child) => {
                // Registrera PID:t så att cancel_transcription kan döda ALLA aktiva processer
                // (inte bara den senaste). PID:t tas bort när processen är klar nedan.
                {
                    use crate::TranscriptionProcess;
                    let proc_state = handle.state::<TranscriptionProcess>();
                    if let Ok(mut pids) = proc_state.pids.lock() {
                        pids.insert(child.id());
                        println!("[KillSwitch] Registered whisper-cli PID={}", child.id());
                    }
                    drop(proc_state);
                }

                let stdout = child.stdout.take().expect("Failed to open stdout");
                let reader = BufReader::new(stdout);
                
                let mut full_segment_text = String::new();

                for line_result in reader.lines() {
                    match line_result {
                        Ok(line) => {
                            let cleaned_text = line.trim();
                            if cleaned_text.is_empty() { continue; }

                            let mut chunk_text = String::new();
                            if let Some(pos) = cleaned_text.find(']') {
                                if pos + 1 < cleaned_text.len() {
                                    chunk_text.push_str(cleaned_text[pos+1..].trim());
                                }
                            } else {
                                chunk_text.push_str(cleaned_text);
                            }

                            let final_text = chunk_text.trim().to_string();

                            // Filter out common whisper boilerplate if NO timestamps were parsed
                            if !final_text.is_empty() && !final_text.starts_with("whisper_") && !final_text.starts_with("system_info:") {
                                println!("DEBUG: Streaming text: {}", final_text);
                                
                                if !full_segment_text.is_empty() {
                                    full_segment_text.push(' ');
                                }
                                full_segment_text.push_str(&final_text);

                                let _ = handle.emit("transcription-chunk", TranscriptionChunk {
                                    text: final_text,
                                    source: source_clone.clone(),
                                    start: start_offset,
                                    end: start_offset + duration_sec,
                                });
                            }
                        },
                        Err(e) => eprintln!("ERROR: Stdout read error: {}", e),
                    }
                }

                let child_pid = child.id();
                let output = child.wait_with_output();
                // Avregistrera PID:t — processen är klar.
                {
                    use crate::TranscriptionProcess;
                    let proc_state = handle.state::<TranscriptionProcess>();
                    if let Ok(mut pids) = proc_state.pids.lock() {
                        pids.remove(&child_pid);
                    }
                    drop(proc_state);
                }
                match output {
                    Ok(o) => {
                        // Session ändrad (ny inspelning) eller avbruten av användaren → släng
                        // resultatet tyst: visa inget fel och spara inget segment.
                        if current_session_generation() != my_gen {
                            println!("[gen] Slänger transkriberingsresultat (generation ändrad / avbruten)");
                            let mut state = session_state_clone.lock().unwrap();
                            if state.pending_transcriptions > 0 { state.pending_transcriptions -= 1; }
                            drop(state);
                            try_save_session(&handle, &session_state_clone);
                            return;
                        }

                        if !o.status.success() {
                            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                            let err_msg = format!("Sidecar (whisper-cli) kraschade: {}", stderr);
                            println!("ERROR: {}", err_msg);
                            let _ = handle.emit("transcription-error", err_msg);
                        }
                        
                        // Save the full concatenated segment to DB/Session State
                        let complete_text = full_segment_text.trim().to_string();
                        if !complete_text.is_empty() {
                            let segment = Segment {
                                id: None,
                                recording_id: None,
                                start_time: start_offset,
                                end_time: start_offset + duration_sec,
                                text: complete_text,
                                speaker: source_clone.clone(),
                            };
                            
                            let mut state = session_state_clone.lock().unwrap();
                            state.segments.push(segment);
                            state.pending_transcriptions -= 1;
                            drop(state);
                            try_save_session(&handle, &session_state_clone);
                        } else {
                            let mut state = session_state_clone.lock().unwrap();
                            state.pending_transcriptions -= 1;
                            drop(state);
                            try_save_session(&handle, &session_state_clone);
                        }
                    },
                    Err(_) => {
                        let mut state = session_state_clone.lock().unwrap();
                        state.pending_transcriptions -= 1;
                        drop(state);
                        try_save_session(&handle, &session_state_clone);
                    }
                }
            },
            Err(e) => {
                let err_msg = format!("Kunde inte starta processen. Fel: {}", e);
                eprintln!("ERROR: {}", err_msg);
                let _ = handle.emit("transcription-error", err_msg);
                let mut state = session_state_clone.lock().unwrap();
                state.pending_transcriptions -= 1;
                drop(state);
                try_save_session(&handle, &session_state_clone);
            }
        }
        
        let _ = std::fs::remove_file(filename);
    });
}

/// Sammanhängande-läge (1×): VAD över den MIXADE strömmen i session-recordern.
/// Producerar EN "MOLN"-ström med styckesvisa segment så vi betalar 1× (inte 2×).
/// Speglar VAD-tillståndsmaskinen i process_audio_stream men på redan-mixade 16kHz-samples.
struct MergedVad {
    speech: Vec<f32>,
    window: Vec<f32>,
    pre_roll: VecDeque<f32>,
    is_speaking: bool,
    silence_start: Instant,
    total_samples: u64,
    start_sample: u64,
}

impl MergedVad {
    fn new() -> Self {
        Self {
            speech: Vec::new(),
            window: Vec::with_capacity(800),
            pre_roll: VecDeque::with_capacity(PRE_ROLL_SAMPLES),
            is_speaking: false,
            silence_start: Instant::now(),
            total_samples: 0,
            start_sample: 0,
        }
    }

    fn push(&mut self, s: f32, threshold: f32, silence_ms: u128, app: &AppHandle) {
        self.total_samples += 1;

        if self.pre_roll.len() >= PRE_ROLL_SAMPLES {
            self.pre_roll.pop_front();
        }
        self.pre_roll.push_back(s);

        if self.is_speaking {
            self.speech.push(s);
        }

        self.window.push(s);
        if self.window.len() < 800 {
            return; // accumulate ~50ms before measuring RMS
        }
        let mut sq = 0.0;
        for &x in &self.window { sq += x * x; }
        let rms = (sq / self.window.len() as f32).sqrt();
        self.window.clear();

        if self.is_speaking {
            if rms > threshold {
                self.silence_start = Instant::now();
            } else if self.silence_start.elapsed().as_millis() > silence_ms {
                let dur_ms = (self.speech.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
                if dur_ms >= MIN_SEGMENT_DURATION_MS {
                    self.is_speaking = false;
                    if dur_ms > MIN_RECORDING_DURATION_MS {
                        let start_offset = self.start_sample as f64 / SAMPLE_RATE as f64;
                        emit_cloud_chunk(&self.speech, "MOLN", app, start_offset);
                    }
                    self.speech.clear();
                }
            }
            if self.is_speaking {
                let cur = (self.speech.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
                if cur > CLOUD_MAX_SEGMENT_DURATION_MS {
                    let start_offset = self.start_sample as f64 / SAMPLE_RATE as f64;
                    emit_cloud_chunk(&self.speech, "MOLN", app, start_offset);
                    // Re-seeda nästa chunk med en kort lead-in (slutet av denna) så whisper inte
                    // tappar de första orden vid abrupt klippstart i sammanhängande tal.
                    let lead = self.speech.len().saturating_sub(CHUNK_LEAD_IN_SAMPLES);
                    let tail: Vec<f32> = self.speech[lead..].to_vec();
                    self.speech.clear();
                    self.speech.extend_from_slice(&tail);
                    self.silence_start = Instant::now();
                    self.start_sample = self.total_samples.saturating_sub(tail.len() as u64);
                }
            }
        } else if rms > threshold {
            self.is_speaking = true;
            self.silence_start = Instant::now();
            self.speech.clear();
            self.speech.extend(self.pre_roll.iter());
            let pre = self.pre_roll.len() as u64;
            self.start_sample = self.total_samples.saturating_sub(pre);
        }
    }

    fn flush(&mut self, app: &AppHandle) {
        if !self.speech.is_empty() {
            let dur_ms = (self.speech.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
            if dur_ms > 500 {
                let start_offset = self.start_sample as f64 / SAMPLE_RATE as f64;
                emit_cloud_chunk(&self.speech, "MOLN", app, start_offset);
            }
            self.speech.clear();
        }
    }
}

fn start_session_recorder(
    rx: Receiver<SessionChunk>,
    app: AppHandle,
    is_running: Arc<Mutex<bool>>,
    is_recording: Arc<Mutex<bool>>,
    session_state: Arc<Mutex<SessionState>>,
    settings: Arc<Mutex<AudioSettings>>,
) {
    println!("DEBUG: Session recorder thread started");

    loop {
        // 1. Idle Loop: Drain channel but don't record
        while *is_running.lock().unwrap() && !*is_recording.lock().unwrap() {
            // Drain queue so it doesn't grow indefinitely
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(_) => {}, // Drop data
                Err(_) => {}, // Timeout or disconnect
            }
        }

        // Check if we should exit entire thread
        if !*is_running.lock().unwrap() {
             break;
        }

        // 2. Recording Start
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let temp_dir = std::env::temp_dir();
        let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros();
        let filename = temp_dir.join(format!("session_{}.wav", timestamp));
        
        let mut writer = match hound::WavWriter::create(&filename, spec) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("ERROR: Failed to create session wav writer: {}", e);
                return;
            }
        };

        println!("DEBUG: Session recorder Started Writing: {:?}", filename);

        let mut mic_buffer: VecDeque<f32> = VecDeque::new();
        let mut sys_buffer: VecDeque<f32> = VecDeque::new();

        // Sammanhängande-läge (1×): kör VAD på den mixade strömmen och strömma "MOLN"-chunks.
        // Läget sätts via set_cloud_mode FÖRE start_recording, så vi läser en gång per session.
        let (merged_cloud, vad_threshold, vad_silence_ms) = {
            let s = settings.lock().unwrap();
            (s.cloud_streaming && s.merge_channels, s.vad_threshold, s.silence_duration_ms as u128)
        };
        let mut merged_vad = MergedVad::new();

        // 3. Recording Loop
        while *is_recording.lock().unwrap() && *is_running.lock().unwrap() {
             match rx.recv_timeout(Duration::from_millis(100)) {
                 Ok(chunk) => {
                     if chunk.source == "mic" {
                         mic_buffer.extend(chunk.data);
                     } else {
                         sys_buffer.extend(chunk.data);
                     }
                 },
                 Err(crossbeam_channel::RecvTimeoutError::Timeout) => {},
                 Err(_) => break, // Disconnected
             }
             
             while !mic_buffer.is_empty() || !sys_buffer.is_empty() {
                 let amplitude = i16::MAX as f32;
                 let mixed_f32: f32;

                 if !mic_buffer.is_empty() && !sys_buffer.is_empty() {
                     let mut m = mic_buffer.pop_front().unwrap();
                     let mut s = sys_buffer.pop_front().unwrap();
                     if m.is_nan() || m.is_infinite() { m = 0.0; }
                     if s.is_nan() || s.is_infinite() { s = 0.0; }
                     mixed_f32 = (m + s).clamp(-1.0, 1.0);
                 }
                 else if !mic_buffer.is_empty() {
                      if mic_buffer.len() > 8000 {
                           let mut m = mic_buffer.pop_front().unwrap();
                           if m.is_nan() || m.is_infinite() { m = 0.0; }
                           mixed_f32 = m;
                      } else { break; }
                 }
                 else { // only sys
                      if sys_buffer.len() > 8000 {
                           let mut s = sys_buffer.pop_front().unwrap();
                           if s.is_nan() || s.is_infinite() { s = 0.0; }
                           mixed_f32 = s;
                      } else { break; }
                 }

                 if merged_cloud {
                     merged_vad.push(mixed_f32, vad_threshold, vad_silence_ms, &app);
                 }
                 writer.write_sample((mixed_f32 * amplitude) as i16).unwrap();
             }
        }
        
        // Drain any in-flight chunks still in the channel when the recording loop exited
        loop {
            match rx.try_recv() {
                Ok(chunk) => {
                    if chunk.source == "mic" { mic_buffer.extend(chunk.data); }
                    else { sys_buffer.extend(chunk.data); }
                }
                Err(_) => break,
            }
        }

        // Flush all remaining buffered samples — no 8000-sample threshold here
        {
            let amplitude = i16::MAX as f32;
            while !mic_buffer.is_empty() || !sys_buffer.is_empty() {
                let mixed_f32 = if !mic_buffer.is_empty() && !sys_buffer.is_empty() {
                    let mut m = mic_buffer.pop_front().unwrap();
                    let mut s = sys_buffer.pop_front().unwrap();
                    if m.is_nan() || m.is_infinite() { m = 0.0; }
                    if s.is_nan() || s.is_infinite() { s = 0.0; }
                    (m + s).clamp(-1.0, 1.0)
                } else if !mic_buffer.is_empty() {
                    let mut m = mic_buffer.pop_front().unwrap();
                    if m.is_nan() || m.is_infinite() { m = 0.0; }
                    m
                } else {
                    let mut s = sys_buffer.pop_front().unwrap();
                    if s.is_nan() || s.is_infinite() { s = 0.0; }
                    s
                };
                if merged_cloud {
                    merged_vad.push(mixed_f32, vad_threshold, vad_silence_ms, &app);
                }
                if writer.write_sample((mixed_f32 * amplitude) as i16).is_err() { break; }
            }
        }

        // Emit any trailing merged speech segment (last utterance before stop).
        if merged_cloud {
            merged_vad.flush(&app);
        }

        // Pad 500ms silence (8000 samples @ 16kHz) — Whisper cuts the final word
        // when audio ends abruptly without trailing silence after the last utterance.
        for _ in 0..(SAMPLE_RATE / 2) {
            let _ = writer.write_sample(0i16);
        }
        println!("DEBUG: Session recorder flushed buffers and added silence pad.");

        // 4. Recording Stop & Finalize
        match writer.finalize() {
            Ok(_) => println!("DEBUG: Session WAV finalized."),
            Err(e) => eprintln!("ERROR: Failed to finalize session WAV: {}", e),
        }

        let path_str = filename.to_string_lossy().to_string();
        
        // Update Session State
        {
            let mut state = session_state.lock().unwrap();
            state.wav_path = Some(path_str.clone());
            // Calculate duration (approx based on size if file is closed?)
            // Or just trust the writer logic which we don't have access to duration easily from finalizing.
            // But we know samples written... 
            // Let's use metadata?
            if let Ok(meta) = std::fs::metadata(&filename) {
                // Header (44) + samples * 2
                let bytes = meta.len();
                if bytes > 44 {
                    state.duration_sec = (bytes - 44) as f64 / 2.0 / SAMPLE_RATE as f64;
                }
            }
        }
        
        try_save_session(&app, &session_state);

        let clean_path = if path_str.starts_with("\\\\?\\") {
            path_str[4..].to_string()
        } else {
            path_str.to_string()
        };
        
        let _ = app.emit("session-complete", clean_path);
        println!("DEBUG: Session complete event emitted.");
    }
}

// Helper to save session to DB only when ready
fn try_save_session(app: &AppHandle, session_state: &Arc<Mutex<SessionState>>) {
    let mut state = session_state.lock().unwrap();
    
    // Check if recording is done (path exists) and all transcriptions are done
    if let Some(wav_path) = &state.wav_path {
        if state.pending_transcriptions == 0 {
            println!("DEBUG: All conditions met. Saving session to DB...");
            
            let start_time_ms = state.start_time.unwrap_or_else(|| SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
            let duration = state.duration_sec;
            let segments = state.segments.clone();
            let recording_path = wav_path.clone();
            
            // Allow multiple saves? No, clear logic.
            // But if we clear wav_path, we can't save again. Good.
            state.wav_path = None; 
            
            drop(state);
            
            let db_state = app.state::<Mutex<DatabaseManager>>();
            let db = match db_state.lock() {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("ERROR: Failed to lock DB for saving: {}", e);
                    return;
                }
            };
            
            // Format created_at manually to avoid chrono dep if not present
            // (Assuming standard ISO format is fine)
            // But verify if we can use chrono. 
            // If not, use simple formatter.
            // Using a simple SystemTime to ISO string approximation (UTC)
            let datetime = chrono::DateTime::<chrono::Utc>::from(std::time::UNIX_EPOCH + std::time::Duration::from_millis(start_time_ms as u64));
            let created_at = datetime.to_rfc3339();

            let recording = Recording {
                id: None,
                filename: "recording.wav".to_string(), 
                file_path: recording_path, 
                duration_sec: duration,
                created_at,
                cloud_job_id: None,
                analysis_json: None,
                ai_template_used: None,
                cloud_transcript: None,
                sync_status: "local".to_string(),
                audio_deleted: false,
                speaker_map: None,
                has_segments: !segments.is_empty(),
            };
            
            println!("DEBUG: Calling db.save_recording...");
            match db.save_recording(recording, segments) {
                Ok(saved_rec) => {
                    println!("DEBUG: Successfully saved recording ID {} to DB.", saved_rec.id.unwrap_or(-1));
                    let _ = app.emit("history-updated", &saved_rec);
                },
                Err(e) => eprintln!("ERROR: Database save failed: {}", e),
            }

        } else {
            println!("DEBUG: Recording check: WAV ready, but {} pending transcriptions.", state.pending_transcriptions);
        }
    }
}
