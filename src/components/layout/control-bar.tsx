import { Mic, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAudioAmplitude } from "@/hooks/use-audio-amplitude";
import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { toast } from "sonner";
// import { open } from "@tauri-apps/plugin-shell"; // Removed for In-App Analysis
import { useSettingsStore } from "@/store/settings-store";
// import { useRecordingStore } from "@/store/recording-store";
import { useAuthStore } from "@/store/auth-store";
import { uploadJob, reanalyzeTranscript } from "@/lib/api";
import { applyInlineCloudResult } from "@/lib/cloud-sync";
import { useSyncStore } from "@/store/sync-store";
import { useTranscriptionStore } from "@/store/transcription-store";
import { usePostHogEvents } from "@/hooks/use-posthog-events";
import { waitForCloudStreamIdle, resetCloudStream } from "@/hooks/use-cloud-stream";

interface Recording {
    id: number | null;
    filename: string;
    file_path: string;
    duration_sec: number;
    created_at: string;
    sync_status: string;
    cloud_job_id: string | null;
    audio_deleted: boolean;
}

interface ControlBarProps {
    onViewChange?: (view: 'dashboard' | 'settings' | 'recordings') => void;
}

export function ControlBar({ onViewChange }: ControlBarProps) {
    const amplitude = useAudioAmplitude();
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    // Robust timer start time
    const [startTime, setStartTime] = useState<number | null>(null);

    // Cloud Sync State from Store
    const {
        setUploadStatus,
        setUploadProgress,
        setErrorMessage,
        setSession,
        setActiveJob,
        setAnalysisData,
        reset,
        isRecording, setIsRecording,
    } = useSyncStore();
    
    const getToken = useAuthStore((s) => s.getToken);
    const isPro = useAuthStore((s) => s.isPro());
    const isSignedIn = useAuthStore((s) => s.isSignedIn);
    const events = usePostHogEvents();


    // Timer Logic: Use Date.now() for accuracy
    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (isRecording) {
            // Set start time if not set (or use ref to track actual start)
            const start = startTime || Date.now();
            if (!startTime) setStartTime(start);

            setElapsedSeconds(Math.floor((Date.now() - start) / 1000)); // Immediate update

            interval = setInterval(() => {
                const now = Date.now();
                setElapsedSeconds(Math.floor((now - start) / 1000));
            }, 500); // Check twice a second for responsiveness
        }
        return () => clearInterval(interval);
    }, [isRecording, startTime]);

    // Format Timer
    const formatTime = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    // Track duration in ref for the listener to access latest value
    const durationRef = useRef(0);
    useEffect(() => {
        durationRef.current = elapsedSeconds;
    }, [elapsedSeconds]);

    // Listen for History Update (Backend Save Complete)
    useEffect(() => {
        const unlistenPromise = listen<Recording>("history-updated", async (event) => {
            console.log("ControlBar: Received history-updated", event.payload);
            const recording = event.payload;

            // Guard: if a NEW recording has already started while this event was in-flight
            // (e.g. previous session's transcription finished late), don't show the archive banner.
            if (useSyncStore.getState().isRecording) {
                console.log("ControlBar: Ignoring history-updated — new recording already active");
                return;
            }

            if (recording.id && recording.file_path) {
                events.recordingStopped(durationRef.current);
                setSession(recording.file_path, recording.id.toString());
                setUploadStatus('idle');
                setActiveJob(recording);
                useTranscriptionStore.getState().setIsProcessing(false);

                // Flusha talarnamn/chips som fyllts i UNDER live (buffrade i store, ej i den nu
                // ev. avmonterade SplitView). Körs för BÅDE lokal och moln, FÖRE den cloud-
                // streaming-gren som return:ar nedan. Lokal transkribering sparar inspelningen
                // asynkront efter stopp — ofta efter att användaren bytt flik (SplitView avmonterad)
                // → SplitViews egen persistens hinner inte. ControlBar är alltid monterad.
                {
                    const pending = useSyncStore.getState().pendingSpeakerData;
                    if (pending && (Object.keys(pending.map).length > 0 || pending.participants.length > 0)) {
                        try {
                            const payload = JSON.stringify({ map: pending.map, participants: pending.participants });
                            await invoke("save_speaker_map_to_db", { id: recording.id, speakerMap: payload });
                            useSyncStore.getState().setPendingSpeakerData(null);
                            const aj = useSyncStore.getState().activeJob;
                            if (aj && aj.id === recording.id) {
                                setActiveJob({ ...aj, speaker_map: payload }, useSyncStore.getState().activeJobFromHistory);
                            }
                        } catch (e) {
                            console.error("Failed to flush pending speaker_map:", e);
                        }
                    }
                }

                // transcription_completed (lokal/gratis): sista steget i free-aktiveringsfunneln.
                // history-updated fyrar när Rust sparat den lokalt transkriberade inspelningen
                // (whisper-cli, pending=0). PRO live-molnströmning har egna server-events
                // (transcription_chunk_completed/cloud_chunk_ok) och hanteras i grenen nedan —
                // fyra därför bara när vi INTE strömmar mot molnet, annars dubbelräknas sessionen.
                if (!useSyncStore.getState().cloudStreamingActive) {
                    const segs = useTranscriptionStore.getState().segments;
                    if (segs.length > 0) {
                        const wordCount = segs.reduce((n, s) => n + s.text.split(" ").length, 0);
                        events.transcriptionCompleted(wordCount);
                    }
                }
                
                // --- AUTO-SYNC LOGIC ---
                // Trigger auto-sync if effective mode says we should use cloud, and we are Pro
                const currentEffectiveMode = useSyncStore.getState().effectiveMode;
                const isCloudMode = currentEffectiveMode === 'cloud_analysis' || currentEffectiveMode === 'cloud';

                // PRO live-molnströmning: texten kom redan succesivt från molnet (Du/Mötet/MOLN).
                // Ladda INTE upp hela filen igen — det skulle skriva över de strömmade segmenten
                // med ett enda MOLN-stycke OCH kosta 2×. Kör bara analys om läget är cloud_analysis.
                if (useSyncStore.getState().cloudStreamingActive) {
                    setUploadStatus('idle');
                    try {
                        // #6: vänta tills moln-kön dränerats så de sista chunkarna hinner in,
                        // persistera sedan de strömmade segmenten till DB → historik/återöppning
                        // visar samma Du/Mötet-vy, och vyn blankas inte vid stopp.
                        useTranscriptionStore.getState().setIsProcessing(true);
                        // 60 s: analysen ska köras på KOMPLETT text — eftersläpande chunks vid
                        // mötesslut tar ofta >8 s att dränera (use-cloud-stream re-persisterar
                        // dessutom vid varje äkta dränering som skyddsnät).
                        await waitForCloudStreamIdle(60000);
                        const segs = useTranscriptionStore.getState().segments;
                        if (recording.id && segs.length > 0) {
                            await invoke("update_recording_segments", {
                                recordingId: recording.id,
                                segments: segs.map(s => ({
                                    start_time: s.start_time,
                                    end_time: s.end_time,
                                    text: s.text,
                                    speaker: s.speaker,
                                })),
                            });
                        }
                        // Analys på den strömmade texten om läget är cloud_analysis.
                        if (currentEffectiveMode === 'cloud_analysis' && segs.length > 0) {
                            const token = getToken();
                            if (token) {
                                const fullText = segs.map(s => s.text).join(" ");
                                const raw = await reanalyzeTranscript(fullText, "general", token);
                                setAnalysisData({
                                    summary: raw.summary || "",
                                    decisions: raw.key_decisions || [],
                                    actions: raw.action_items || [],
                                    template_used: raw.template_used || "general",
                                });
                                events.analysisCompleted();
                            }
                        }
                    } catch (e: any) {
                        console.error("Streaming post-stop persist/analysis failed:", e);
                    } finally {
                        useTranscriptionStore.getState().setIsProcessing(false);
                    }
                    return;
                }

                if (isCloudMode && isPro) {
                    try {
                        const token = getToken();
                        if (!token) {
                            toast.error("Autosynk misslyckades: Kunde inte hämta autentiseringstoken.");
                            return;
                        }

                        events.cloudSyncStarted();
                        setUploadStatus('uploading');
                        setErrorMessage(null);

                        // We use autoAnalyzeCloud from settings since we preserved it for backwards compat,
                        // or we could just check currentEffectiveMode === 'cloud_analysis'.
                        // Using explicit check for clarity.
                        const shouldAnalyze = currentEffectiveMode === 'cloud_analysis';
                        
                        toast.success(`Påbörjar automatisk uppladdning (${shouldAnalyze ? 'med analys' : 'endast transkribering'})...`);

                        const job = await uploadJob(recording.file_path, "general", token, shouldAnalyze);
                        setUploadStatus('success');

                        if (useSettingsStore.getState().cloudSync) {
                            // Synk PÅ → persisterat moln-jobb: markera synkat + polla (visas i dashboard)
                            await invoke("update_recording_status", {
                                id: recording.id,
                                status: 'uploaded',
                                cloudJobId: job.id,
                            });
                            await emit("recording-synced");
                            setActiveJob({ ...recording, sync_status: 'uploaded', cloud_job_id: job.id });
                            useSyncStore.getState().setUploadedJobId(job.id);
                            useSyncStore.getState().setProcessingStatus("PROCESSING");
                            toast.success(shouldAnalyze
                                ? "Inspelningen är uppladdad! Analyserar i molnet..."
                                : "Inspelningen är uppladdad! Transkriberar med KB-Whisper Large...");
                        } else {
                            // Synk AV (default, privacy-first) → resultatet kom inline, inget sparas i molnet
                            const wc = await applyInlineCloudResult(job, recording.id);
                            events.cloudSyncCompleted(wc);
                            toast.success("Transkriberad med KB-Whisper Large (resultat endast lokalt).");
                        }

                    } catch (error: any) {
                        console.error("Auto-sync failed:", error);
                        events.cloudSyncFailed(error?.message || 'unknown');
                        setUploadStatus('error');
                        setErrorMessage(error.message || "Ett okänt fel inträffade vid autosynk.");
                        toast.error("Autosynk misslyckades: " + (error?.message || error?.toString() || "Okänt fel"));
                    }
                } else if (isCloudMode && !isPro && isSignedIn) {
                    toast.warning("Molnläge kräver Pro. Inspelningen sparades lokalt.");
                }
            }
        });

        return () => { unlistenPromise.then(f => f()); };
    }, [setSession, setUploadStatus, setActiveJob, setUploadProgress, setErrorMessage, getToken, isPro, setAnalysisData]);

    const toggleRecording = async () => {
        try {
            if (isRecording) {
                // STOP RECORDING
                // Backend handles saving now.
                // We just stop and wait for event.
                await invoke("stop_recording");
                setIsRecording(false);
                useTranscriptionStore.getState().setIsProcessing(true); // Show Finalizing state
                setStartTime(null);

                // Note: We don't setSession here anymore. 
                // We wait for 'history-updated' event which contains the DB ID.

            } else {
                // START RECORDING
                // Avgör PRO live-molnströmning och informera Rust FÖRE inspelning startar.
                // streaming=true → Rust skickar VAD-segment till molnet (ingen lokal small).
                // Offline eller icke-Pro → false → lokal small-fallback (offline-first).
                const cfg = useSettingsStore.getState();
                const cloudMode = cfg.recordingMode === 'cloud' || cfg.recordingMode === 'cloud_analysis';
                const streaming = isPro && navigator.onLine && cloudMode;
                const merge = cfg.cloudDiarizationMode === 'merged';
                // Ny session: nollställ moln-köns avbrotts-/felstatus från föregående session.
                resetCloudStream();
                try {
                    await invoke("set_cloud_mode", { cloudStreaming: streaming, mergeChannels: merge });
                } catch (e) {
                    console.error("set_cloud_mode failed:", e);
                }
                useSyncStore.getState().setCloudStreamingActive(streaming);

                await invoke("start_recording");
                events.recordingStarted();

                /**
                 * clearSegments() is intentionally called AFTER start_recording.
                 * Calling it before caused stale Tauri transcription-chunk events
                 * (buffered from the previous session) to repopulate segments before
                 * the new session cleared them. By clearing after the Rust side has
                 * started, any in-flight events from the old session are discarded.
                 */
                useTranscriptionStore.getState().clearSegments();

                setStartTime(Date.now());
                setIsRecording(true);
                setElapsedSeconds(0);
                setActiveJob(null);
                setSession(null, null);
                reset(); // Clears uploadedJobId, processingStatus, analysisData, uploadStatus
                useSyncStore.getState().setPendingSpeakerData(null); // nollställ talar-buffert för ny session
            }
        } catch (error: any) {
            console.error("Failed to toggle recording:", error);
            setIsRecording(false);
            setStartTime(null);
            toast.error("Transkriberingsfel: " + (error?.message || error?.toString() || "Okänt fel"));
        }
    };

    return (
        <div className="h-24 border-t bg-white flex items-center justify-between px-8 relative z-30 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
            <div className="text-sm font-medium text-muted-foreground flex flex-col min-w-[120px]">
                <span className={`font-semibold transition-colors ${isRecording ? "text-red-500 animate-pulse" : "text-ink-muted"}`}>
                    {isRecording ? "Spelar in..." : "Redo"}
                </span>
                <span className="text-xs text-muted-foreground/60 font-mono">{formatTime(elapsedSeconds)}</span>
            </div>

            {/* AI Control removed and migrated to SplitView */}
            <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2" style={{ left: 'calc(50vw - 16rem)' }}>
                <div className="relative">
                    <Button
                        size="icon"
                        onClick={toggleRecording}
                        className={`relative h-16 w-16 rounded-full shadow-xl transition-all duration-300 hover:scale-105 active:scale-95 ${isRecording
                            ? "bg-red-600 hover:bg-red-700 border-4 border-white ring-4 ring-red-100"
                            : "bg-green-500/15 hover:bg-green-500/25 border-2 border-green-400/60"
                            }`}
                    >
                        <Mic className={`h-6 w-6 transition-colors duration-300 ${isRecording ? "text-white" : "text-green-600"}`} />
                    </Button>
                </div>
            </div>

            <div className="flex items-center gap-4">
                {/* Audio Visualizers */}
                <div className="flex gap-2 items-end h-8">
                    <div className="flex flex-col items-center gap-1">
                        <div className="w-1.5 h-6 bg-paper-dim rounded-full overflow-hidden relative">
                            <div
                                className={`absolute bottom-0 w-full ${isRecording ? 'bg-brand' : 'bg-line'} transition-all duration-75 ease-out rounded-full`}
                                style={{ height: isRecording ? `${Math.min(amplitude.mic * 500, 100)}%` : '0%' }}
                            />
                        </div>
                        <span className="text-[10px] text-ink-muted font-mono uppercase">Mic</span>
                    </div>
                    <div className="flex flex-col items-center gap-1">
                        <div className="w-1.5 h-6 bg-paper-dim rounded-full overflow-hidden relative">
                            <div
                                className={`absolute bottom-0 w-full ${isRecording ? 'bg-verified' : 'bg-line'} transition-all duration-75 ease-out rounded-full`}
                                style={{ height: isRecording ? `${Math.min(amplitude.system * 500, 100)}%` : '0%' }}
                            />
                        </div>
                        <span className="text-[10px] text-ink-muted font-mono uppercase">Sys</span>
                    </div>
                </div>

                <div onClick={() => { events.settingsOpened(); onViewChange?.('settings'); }} className="flex items-center gap-2 text-xs bg-paper-dim px-3 py-1.5 rounded-full border border-line text-ink-soft hover:bg-line cursor-pointer transition-colors">
                    <Settings2 className="w-3 h-3" />
                    Systemljud + Mic
                </div>
            </div>
        </div>
    );
}
