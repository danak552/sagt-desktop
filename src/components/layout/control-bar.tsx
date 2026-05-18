import { Mic, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAudioAmplitude } from "@/hooks/use-audio-amplitude";
import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { toast } from "sonner";
// import { open } from "@tauri-apps/plugin-shell"; // Removed for In-App Analysis
// import { useSettingsStore } from "@/store/settings-store";
// import { useRecordingStore } from "@/store/recording-store";
import { useAuthStore } from "@/store/auth-store";
import { uploadJob } from "@/lib/api";
import { useSyncStore } from "@/store/sync-store";
import { useTranscriptionStore } from "@/store/transcription-store";
import { usePostHogEvents } from "@/hooks/use-posthog-events";

interface Recording {
    id: number | null;
    filename: string;
    file_path: string;
    duration_sec: number;
    created_at: string;
    sync_status: string;
    cloud_job_id: string | null;
}

export function ControlBar() {
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
                
                // --- AUTO-SYNC LOGIC ---
                // Trigger auto-sync if effective mode says we should use cloud, and we are Pro
                const currentEffectiveMode = useSyncStore.getState().effectiveMode;
                const isCloudMode = currentEffectiveMode === 'cloud_analysis' || currentEffectiveMode === 'cloud';
                
                if (isCloudMode && isPro) {
                    try {
                        const token = getToken();
                        if (!token) {
                            toast.error("Auto-synk misslyckades: Kunde inte hämta autentiseringstoken.");
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

                        // Mark DB as uploaded
                        await invoke("update_recording_status", {
                            id: recording.id,
                            status: 'uploaded',
                            cloudJobId: job.id,
                        });
                        await emit("recording-synced");

                        const updatedJobState: any = {
                            ...recording,
                            sync_status: 'uploaded',
                            cloud_job_id: job.id
                        };
                        setActiveJob(updatedJobState);

                        // Start polling regardless of mode — cloud transcription replaces local even without analysis
                        useSyncStore.getState().setUploadedJobId(job.id);
                        useSyncStore.getState().setProcessingStatus("PROCESSING");

                        if (shouldAnalyze) {
                            toast.success("Inspelningen är uppladdad! Analyserar i molnet...");
                        } else {
                            toast.success("Inspelningen är uppladdad! Transkriberar med KB-Whisper Large...");
                        }

                    } catch (error: any) {
                        console.error("Auto-sync failed:", error);
                        events.cloudSyncFailed(error?.message || 'unknown');
                        setUploadStatus('error');
                        setErrorMessage(error.message || "Ett okänt fel inträffade vid auto-synk.");
                        toast.error("Auto-synk misslyckades: " + (error?.message || error?.toString() || "Okänt fel"));
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
                <span className={`font-semibold transition-colors ${isRecording ? "text-red-500 animate-pulse" : "text-primary"}`}>
                    {isRecording ? "Spelar in..." : "Redo"}
                </span>
                <span className="text-xs text-muted-foreground/60 font-mono">{formatTime(elapsedSeconds)}</span>
            </div>

            {/* AI Control removed and migrated to SplitView */}
            <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2" style={{ left: 'calc(50vw - 16rem)' }}>
                <Button
                    size="icon"
                    onClick={toggleRecording}
                    className={`h-16 w-16 rounded-full shadow-xl border-4 border-white transition-all hover:scale-105 active:scale-95 ring-4 ${isRecording
                        ? "bg-red-600 hover:bg-red-700 ring-red-100"
                        : "bg-indigo-600 hover:bg-indigo-700 ring-indigo-100"
                        }`}
                >
                    <Mic className="h-6 w-6 text-white" />
                </Button>
            </div>

            <div className="flex items-center gap-4">
                {/* Audio Visualizers */}
                <div className="flex gap-2 items-end h-8">
                    <div className="flex flex-col items-center gap-1">
                        <div className="w-1.5 h-6 bg-slate-100 rounded-full overflow-hidden relative">
                            <div
                                className={`absolute bottom-0 w-full ${isRecording ? 'bg-indigo-500' : 'bg-slate-300'} transition-all duration-75 ease-out rounded-full`}
                                style={{ height: isRecording ? `${Math.min(amplitude.mic * 500, 100)}%` : '0%' }}
                            />
                        </div>
                        <span className="text-[10px] text-slate-400 font-mono uppercase">Mic</span>
                    </div>
                    <div className="flex flex-col items-center gap-1">
                        <div className="w-1.5 h-6 bg-slate-100 rounded-full overflow-hidden relative">
                            <div
                                className={`absolute bottom-0 w-full ${isRecording ? 'bg-emerald-500' : 'bg-slate-300'} transition-all duration-75 ease-out rounded-full`}
                                style={{ height: isRecording ? `${Math.min(amplitude.system * 500, 100)}%` : '0%' }}
                            />
                        </div>
                        <span className="text-[10px] text-slate-400 font-mono uppercase">Sys</span>
                    </div>
                </div>

                <div onClick={() => events.settingsOpened()} className="flex items-center gap-2 text-xs bg-slate-100 px-3 py-1.5 rounded-full border border-slate-200 text-slate-700 hover:bg-slate-200 cursor-pointer transition-colors">
                    <Settings2 className="w-3 h-3" />
                    Systemljud + Mic
                </div>
            </div>
        </div>
    );
}
