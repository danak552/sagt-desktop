use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{unbounded, Receiver, Sender};
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
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

const SAMPLE_RATE: u32 = 16000;
const VAD_THRESHOLD: f32 = 0.008;
// 0.8s silence triggers a cut (was 1.2s) — snappier segmentation for live feel
const SILENCE_DURATION_MS: u128 = 800;
const MIN_RECORDING_DURATION_MS: u128 = 1000;
// 3.0s minimum keeps short sounds from becoming separate segments
const MIN_SEGMENT_DURATION_MS: u128 = 3000;
// 8s max chunk (was 15s) — shorter chunks → faster transcription → live text sooner
const MAX_SEGMENT_DURATION_MS: u128 = 8000;
// Pre-roll buffer size: 2.0 seconds * SAMPLE_RATE
const PRE_ROLL_SAMPLES: usize = (2.0 * SAMPLE_RATE as f32) as usize;

#[derive(Clone, Serialize, Debug)]
pub struct AudioSettings {
    pub vad_threshold: f32,
    pub silence_duration_ms: u64,
    pub language: String,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            vad_threshold: VAD_THRESHOLD,
            silence_duration_ms: SILENCE_DURATION_MS as u64,
            language: "sv".to_string(),
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
    start: Option<u64>,
    end: Option<u64>,
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
        }
    }

    pub fn update_settings(&self, threshold: f32, silence_ms: u64, language: String) {
        let mut s = self.settings.lock().unwrap();
        s.vad_threshold = threshold;
        s.silence_duration_ms = silence_ms;
        s.language = language;
        println!("DEBUG: Updated Audio Settings: {:?}", s);
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
        let mut running = self.is_running.lock().unwrap();
        if *running {
            println!("DEBUG: Audio engine already running");
            return Ok(());
        }
        *running = true;
        let is_running = self.is_running.clone();
        let is_recording = self.is_recording.clone(); // Clone for threads
        let settings = self.settings.clone();
        let session_state = self.session_state.clone();

        thread::spawn(move || {
            let host = cpal::default_host();
            
            // Channel for aggregating VAD levels
            let (level_tx, level_rx) = unbounded::<AudioInput>();
            
            // Channel for Session Recording (Full Mix)
            let (session_tx, session_rx) = unbounded::<SessionChunk>();

            // Start Session Recorder Thread
            let app_handle_recorder = app.clone();
            let is_running_recorder = is_running.clone();
            let is_recording_recorder = is_recording.clone();
            let session_state_recorder = session_state.clone();
            
            thread::spawn(move || {
                start_session_recorder(session_rx, app_handle_recorder, is_running_recorder, is_recording_recorder, session_state_recorder);
            });

            // --- Microphone Capture ---
            // Select device based on name or default
            let mic_device = if let Some(ref name) = input_device_name {
                let mut found = None;
                if let Ok(devices) = host.input_devices() {
                    for d in devices {
                        if let Ok(d_name) = d.name() {
                            if d_name == *name {
                                found = Some(d);
                                break;
                            }
                        }
                    }
                }
                found.or_else(|| {
                    println!("DEBUG: Requested device not found, falling back to default");
                    host.default_input_device()
                })
            } else {
                host.default_input_device()
            }.expect("No mic found");

            println!("DEBUG: Selected input device: {:?}", mic_device.name().unwrap_or_default());
            
            let mic_config = mic_device.default_input_config().expect("Mic config failed");
            let app_handle_mic = app.clone();
            let (mic_sample_tx, mic_sample_rx) = unbounded::<f32>();
            
            let mic_sample_rate = mic_config.sample_rate().0;
            let mic_level_tx = level_tx.clone();
            let mic_session_tx = session_tx.clone();
            
            let mic_stream = match mic_config.sample_format() {
                cpal::SampleFormat::F32 => run_stream::<f32>(&mic_device, &mic_config.clone().into(), mic_sample_tx),
                cpal::SampleFormat::I16 => run_stream::<i16>(&mic_device, &mic_config.clone().into(), mic_sample_tx),
                cpal::SampleFormat::U16 => run_stream::<u16>(&mic_device, &mic_config.clone().into(), mic_sample_tx),
                _ => panic!("Unsupported sample format"),
            };
            mic_stream.play().expect("Mic stream failed");
            println!("DEBUG: Mic stream started");

            // --- System Loopback Capture ---
            let mut _sys_stream_guard = None;
            
            if let Some(sys_device) = host.default_output_device() {
                 println!("DEBUG: Default output device: {:?}", sys_device.name().unwrap_or_default());
                 if let Ok(sys_config) = sys_device.default_output_config() {
                     let app_handle_sys = app.clone();
                     let (sys_sample_tx, sys_sample_rx) = unbounded::<f32>();
                     
                     let sys_sample_rate = sys_config.sample_rate().0;
                     let sys_config_clone = sys_config.clone();
                     let sys_stream_config: cpal::StreamConfig = sys_config_clone.into();
                     let sys_level_tx = level_tx.clone();
                     let sys_session_tx = session_tx.clone();
                     
                     let sys_stream_res = sys_device.build_input_stream(
                        &sys_stream_config,
                        move |data: &[f32], _: &_| {
                            for &sample in data {
                                 let _ = sys_sample_tx.send(sample);
                            }
                        },
                        |err| eprintln!("System stream error: {}", err),
                        None,
                    );

                    if let Ok(stream) = sys_stream_res {
                        stream.play().expect("System stream play failed");
                        println!("DEBUG: System stream started");
                        
                        let settings_sys = settings.clone();
                        // Clone is_recording for Sys thread
                        let is_recording_sys = is_recording.clone();
                        let session_state_sys = session_state.clone();

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
                                session_state_sys
                            );
                        });
                        
                        // Keep stream alive by storing it in the outer variable
                        _sys_stream_guard = Some(stream);
                    } else {
                        eprintln!("DEBUG: Failed to build system stream");
                    }
                 }
            } else {
                eprintln!("DEBUG: No output device found");
            }

            // --- Processing Threads ---
            let settings_mic = settings.clone();
            // Clone is_recording for Mic thread
            let is_recording_mic = is_recording.clone();
            let session_state_mic = session_state.clone();

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
                    session_state_mic
                );
            });

             // --- Main Loop: Aggregating Levels & Keeping Alive ---
             let mut current_mic = 0.0;
             let mut current_sys = 0.0;
             let app_handle_main = app.clone();
             let mut last_log = Instant::now();

             let mut last_emit = Instant::now();
             
             loop {
                if !*is_running.lock().unwrap() {
                    break;
                }
                
                // Use a shorter timeout to stay responsive but drain messages
                match level_rx.recv_timeout(Duration::from_millis(20)) {
                    Ok(input) => {
                        match input {
                            AudioInput::Mic(v) => current_mic = v,
                            AudioInput::System(v) => current_sys = v,
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



fn run_stream<T>(device: &cpal::Device, config: &cpal::StreamConfig, tx: Sender<f32>) -> cpal::Stream
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
        |err| eprintln!("Stream error: {}", err),
        None,
    ).unwrap()
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
    
    // Time tracking
    let mut total_16k_samples: u64 = 0;
    let mut speech_start_sample: u64 = 0;

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 128,
        window: WindowFunction::BlackmanHarris2,
    };

    let mut resampler = SincFixedIn::<f32>::new(
        ratio,
        2.0, // max deviation
        params,
        input_chunk_size, 
        1
    ).expect("Failed to init resampler");

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
                 let chunk_len = output_data.len();
                 total_16k_samples += chunk_len as u64;
                 
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
                 let (threshold, silence_duration, whisper_lang) = {
                    let s = settings.lock().unwrap();
                    (s.vad_threshold, s.silence_duration_ms as u128, s.language.clone())
                 };

                 // Gate VAD logic behind is_recording
                 if !*is_recording.lock().unwrap() {
                     // If not recording, prevent state buildup and clear buffers
                     if !speech_buffer.is_empty() {
                         // Flush whatever is in the buffer if we just stopped recording
                         let duration_ms = (speech_buffer.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
                         if duration_ms > 100 { // Only flush if meaningful data (>0.1s)
                            println!("DEBUG: Recording stopped, flushing pending speech buffer on {} ({}ms)", source_label, duration_ms);
                            let start_offset = speech_start_sample as f64 / SAMPLE_RATE as f64;
                            transcribe(&speech_buffer, source_label, &app, session_state.clone(), start_offset, whisper_lang.clone());
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
                                    let start_offset = speech_start_sample as f64 / SAMPLE_RATE as f64;
                                    transcribe(&speech_buffer, source_label, &app, session_state.clone(), start_offset, whisper_lang.clone());
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
                         if current_dur > MAX_SEGMENT_DURATION_MS {
                             println!("DEBUG: Max segment length reached ({}ms) on {}. Forcing flush.", current_dur, source_label);
                             let start_offset = speech_start_sample as f64 / SAMPLE_RATE as f64;
                             transcribe(&speech_buffer, source_label, &app, session_state.clone(), start_offset, whisper_lang.clone());
                             speech_buffer.clear();
                             // Reset silence timer to keep recording if still talking, but treated as new chunk
                             silence_start = Instant::now();
                             // Update start sample for NEXT chunk
                             speech_start_sample = total_16k_samples; 
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
                         
                         // Set Start Sample: Current total minus pre-roll length (approx)
                         // Accurate: total_16k_samples - current_chunk (already added) - pre_roll
                         // Wait, pre_roll_buffer has accumulated samples.
                         // speech_start_sample should be "Now" minus "Pre-roll duration".
                         let pre_roll_len = pre_roll_buffer.len() as u64;
                         // We just did total_16k_samples += chunk_len.
                         if total_16k_samples >= pre_roll_len {
                             speech_start_sample = total_16k_samples - pre_roll_len;
                         } else {
                             speech_start_sample = 0;
                         }
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
            let start_offset = speech_start_sample as f64 / SAMPLE_RATE as f64;
            let whisper_lang = settings.lock().unwrap().language.clone();
            transcribe(&speech_buffer, source_label, &app, session_state.clone(), start_offset, whisper_lang);
        }
    }
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

        match cmd.spawn() {
            Ok(mut child) => {
                // Store PID so cancel_transcription can kill this process
                // Also clear any previous cancelled flag so a fresh recording isn't affected
                {
                    use crate::TranscriptionProcess;
                    use std::sync::atomic::Ordering;
                    let proc_state = handle.state::<TranscriptionProcess>();
                    proc_state.cancelled.store(false, Ordering::SeqCst);
                    if let Ok(mut pid_lock) = proc_state.pid.lock() {
                        *pid_lock = Some(child.id());
                        println!("[KillSwitch] Registered whisper-cli PID={:?}", *pid_lock);
                        drop(pid_lock);
                    };
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
                                    start: Some(start_offset as u64),
                                    end: Some((start_offset + duration_sec) as u64),
                                });
                            }
                        },
                        Err(e) => eprintln!("ERROR: Stdout read error: {}", e),
                    }
                }

                let output = child.wait_with_output();
                // Clear the stored PID — process is done
                {
                    use crate::TranscriptionProcess;
                    let proc_state = handle.state::<TranscriptionProcess>();
                    if let Ok(mut pid_lock) = proc_state.pid.lock() {
                        *pid_lock = None;
                        drop(pid_lock);
                    };
                    drop(proc_state);
                }
                match output {
                    Ok(o) => {
                        if !o.status.success() {
                            // Check if this was an intentional cancellation — if so, don't show error
                            use crate::TranscriptionProcess;
                            use std::sync::atomic::Ordering;
                            let was_cancelled = handle
                                .state::<TranscriptionProcess>()
                                .cancelled
                                .load(Ordering::SeqCst);

                            if !was_cancelled {
                                let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                                let err_msg = format!("Sidecar (whisper-cli) kraschade: {}", stderr);
                                println!("ERROR: {}", err_msg);
                                let _ = handle.emit("transcription-error", err_msg);
                            } else {
                                println!("[KillSwitch] Transcription cancelled by user — suppressing crash error.");
                            }
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

fn start_session_recorder(
    rx: Receiver<SessionChunk>, 
    app: AppHandle, 
    is_running: Arc<Mutex<bool>>, 
    is_recording: Arc<Mutex<bool>>,
    session_state: Arc<Mutex<SessionState>>,
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
                 let sample;

                 if !mic_buffer.is_empty() && !sys_buffer.is_empty() {
                     let mut m = mic_buffer.pop_front().unwrap();
                     let mut s = sys_buffer.pop_front().unwrap();
                     if m.is_nan() || m.is_infinite() { m = 0.0; }
                     if s.is_nan() || s.is_infinite() { s = 0.0; }
                     let mixed = (m + s).clamp(-1.0, 1.0);
                     sample = (mixed * amplitude) as i16;
                 } 
                 else if !mic_buffer.is_empty() {
                      if mic_buffer.len() > 8000 { 
                           let mut m = mic_buffer.pop_front().unwrap();
                           if m.is_nan() || m.is_infinite() { m = 0.0; }
                           sample = (m * amplitude) as i16;
                      } else { break; }
                 }
                 else { // only sys
                      if sys_buffer.len() > 8000 {
                           let mut s = sys_buffer.pop_front().unwrap();
                           if s.is_nan() || s.is_infinite() { s = 0.0; }
                           sample = (s * amplitude) as i16;
                      } else { break; }
                 }
                 
                 writer.write_sample(sample).unwrap();
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
                let sample = if !mic_buffer.is_empty() && !sys_buffer.is_empty() {
                    let mut m = mic_buffer.pop_front().unwrap();
                    let mut s = sys_buffer.pop_front().unwrap();
                    if m.is_nan() || m.is_infinite() { m = 0.0; }
                    if s.is_nan() || s.is_infinite() { s = 0.0; }
                    ((m + s).clamp(-1.0, 1.0) * amplitude) as i16
                } else if !mic_buffer.is_empty() {
                    let mut m = mic_buffer.pop_front().unwrap();
                    if m.is_nan() || m.is_infinite() { m = 0.0; }
                    (m * amplitude) as i16
                } else {
                    let mut s = sys_buffer.pop_front().unwrap();
                    if s.is_nan() || s.is_infinite() { s = 0.0; }
                    (s * amplitude) as i16
                };
                if writer.write_sample(sample).is_err() { break; }
            }
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
                sync_status: "local".to_string(),
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
