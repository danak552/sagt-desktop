// Removed ScrollArea import
import { Card } from "@/components/ui/card";
import { FileText, Sparkles, History, Loader2, Copy, RefreshCw, Play, Cloud, Check, CloudLightning, LogOut } from "lucide-react";
import { useTranscription } from "@/hooks/use-transcription";
import { useSyncStore } from "@/store/sync-store";
import { useSettingsStore } from "@/store/settings-store";
import { useTranscriptionStore, UISegment } from "@/store/transcription-store";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { getJob, reanalyzeTranscript, uploadJob } from "@/lib/api";
import { AnalysisData } from "@/store/sync-store";
import { useAuthStore } from "@/store/auth-store";
import { useBrowserAuth } from "@/hooks/use-browser-auth";
import { toast } from "sonner";
import { ModePill } from "./mode-pill";
import { UpsellModal } from "./upsell-modal";
import { useConfigStore } from "@/store/config-store";
import { usePaymentRefresh } from "@/hooks/use-payment-refresh";
import { usePostHogEvents } from "@/hooks/use-posthog-events";

export function SplitView() {
    const isSignedIn = useAuthStore((s) => s.isSignedIn);
    const getToken = useAuthStore((s) => s.getToken);
    const isPro = useAuthStore((s) => s.isPro());
    const userId = useAuthStore((s) => s.userId);
    const email = useAuthStore((s) => s.email);
    const clearSession = useAuthStore((s) => s.clearSession);
    const stripePaymentLink = useConfigStore((s) => s.stripePaymentLink);
    const { startAuth, isAuthenticating } = useBrowserAuth();
    const events = usePostHogEvents();
    const { isWaiting: isPaymentWaiting, startPolling: startPaymentPolling, stopPolling: stopPaymentPolling, manualRefresh: manualPaymentRefresh } = usePaymentRefresh();
    const [showLoginModal, setShowLoginModal] = useState(false);
    const [showUpsellModal, setShowUpsellModal] = useState(false);
    const [showUserMenu, setShowUserMenu] = useState(false);
    const userMenuRef = useRef<HTMLDivElement>(null);

    // Close user menu on click outside
    useEffect(() => {
        if (!showUserMenu) return;
        const handleClick = (e: MouseEvent) => {
            if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
                setShowUserMenu(false);
            }
        };
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [showUserMenu]);

    // Derive initials from email
    const initials = email
        ? email.split("@")[0].slice(0, 2).toUpperCase()
        : "?";

    useEffect(() => {
        if (isSignedIn && showLoginModal) {
            setShowLoginModal(false);
        }
    }, [isSignedIn, showLoginModal]);

    useEffect(() => {
        if (isSignedIn && !isPro) {
            events.upsellShown('ai_insights_panel');
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isSignedIn, isPro]);

    const { segments: rawSegments, isProcessing } = useTranscription();
    const scrollRef = useRef<HTMLDivElement>(null);

    // Polling Logic for In-App Data
    const {
        uploadedJobId, setUploadedJobId, analysisData, setAnalysisData, processingStatus, setProcessingStatus,
        activeJob, activeJobFromHistory, setActiveJob, resetToLive, reset,
        setTemplateId, setUploadStatus, currentSessionPath, currentSessionId, setErrorMessage, isRecording,
        effectiveMode
    } = useSyncStore();
    // Access store actions to populate segments for archive view
    const { setSegments, clearSegments } = useTranscriptionStore();
    const { recordingMode } = useSettingsStore();

    // Derive displayed segments synchronously so the first render after a tab switch
    // already shows the cloud result — no flash of stale local segments.
    const segments = useMemo((): UISegment[] => {
        if (activeJob?.cloud_transcript) {
            return [{
                id: -1,
                start_time: 0,
                end_time: 0,
                text: activeJob.cloud_transcript,
                speaker: "MOLN" as const,
                timestamp: 0,
            }];
        }
        return rawSegments;
    }, [activeJob?.cloud_transcript, rawSegments]);

    useEffect(() => {
        if (scrollRef.current) {
            const scrollContainer = scrollRef.current.closest('[data-radix-scroll-area-viewport]');
            if (scrollContainer) {
                const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
                if (scrollHeight - scrollTop - clientHeight < 150) {
                    scrollRef.current.scrollIntoView({ behavior: "smooth" });
                }
            } else {
                scrollRef.current.scrollIntoView({ behavior: "smooth" });
            }
        }
    }, [segments, isProcessing]);

    // Re-analyze state
    const [isReanalyzing, setIsReanalyzing] = useState(false);
    const [isRetranscribing, setIsRetranscribing] = useState(false);
    const [copiedKey, setCopiedKey] = useState<string | null>(null);

    const handleCopy = (text: string, key: string, e: React.MouseEvent<HTMLButtonElement>) => {
        if (!text) return;
        navigator.clipboard.writeText(text);
        e.currentTarget.blur();
        setCopiedKey(key);
        events.transcriptCopied();
        setTimeout(() => setCopiedKey(null), 2000);
    };

    const handleCancel = async () => {
        setIsReanalyzing(false);
        setUploadStatus('idle');
        setUploadedJobId(null);
        useTranscriptionStore.getState().setIsProcessing(false);
        try {
            // Kill the active whisper-cli child process in Rust
            await invoke('cancel_transcription');
        } catch (e) {
            console.error("Failed to kill transcription process:", e);
        }
        try {
            await invoke("stop_recording");
        } catch (e) {
            console.error("Failed to stop backend recording:", e);
        }
    };

    const handleRetranscribe = async () => {
        if (!isSignedIn) { setShowLoginModal(true); return; }
        if (!isPro) { setShowUpsellModal(true); return; }
        if (!navigator.onLine) { toast.error("Denna funktion kräver internetanslutning."); return; }

        const uploadPath = activeJob?.file_path || currentSessionPath;
        if (!uploadPath) {
            toast.error("Inspelningsfil saknas. Spela in igen och försök.");
            return;
        }

        const token = getToken();
        if (!token) { toast.error("Kunde inte hämta autentiseringstoken. Logga in igen."); return; }

        setIsRetranscribing(true);
        setUploadStatus('uploading');
        try {
            const job = await uploadJob(uploadPath, "general", token, true);
            setUploadStatus('success');
            setUploadedJobId(job.id);
            setProcessingStatus("PROCESSING");
            toast.success("Transkriberar med KB-Whisper Large...");
        } catch (error: any) {
            setUploadStatus('error');
            setUploadedJobId(null);
            if (error?.message?.startsWith("Unauthorized")) {
                clearSession();
                toast.error("Din session är inte längre giltig. Logga in igen.");
            } else {
                toast.error("Uppladdning misslyckades: " + (error?.message || error?.toString() || "Okänt fel"));
            }
        } finally {
            setIsRetranscribing(false);
        }
    };

    const handleAction = async () => {
        if (!navigator.onLine) {
            toast.error("Denna funktion kräver internetanslutning.");
            return;
        }

        if (!isSignedIn) {
            setShowLoginModal(true);
            return;
        }

        if (!isPro) {
            setShowUpsellModal(true);
            return;
        }

        const token = getToken();
        if (!token) {
            toast.error("Kunde inte hämta autentiseringstoken. Logga in igen.");
            return;
        }

        const isUploaded = activeJob && (activeJob.cloud_job_id || activeJob.sync_status === 'uploaded' || activeJob.sync_status === 'synced');
        const hasTranscription = segments.length > 0;

        if (isUploaded || analysisData || hasTranscription) {
            if (!activeJob && segments.length === 0) return;
            events.analysisRequested();
            setIsReanalyzing(true);
            try {
                const fullText = segments.map(s => s.text).join(" ");
                const newResult = await reanalyzeTranscript(fullText, "general", token);

                const mappedAnalysis = {
                    summary: newResult.summary || "",
                    decisions: newResult.key_decisions || [],
                    actions: newResult.action_items || [],
                    template_used: newResult.template_used || "general"
                };

                setAnalysisData(mappedAnalysis as AnalysisData);
                events.analysisCompleted();
                // Stop polling so it doesn't overwrite this re-analysis result
                setUploadedJobId(null);

                await invoke("save_analysis_to_db", {
                    id: activeJob.id,
                    analysis: JSON.stringify(mappedAnalysis),
                    template: "general"
                });

                const updatedJob = {
                    ...activeJob,
                    analysis_json: JSON.stringify(mappedAnalysis),
                    ai_template_used: "general"
                };
                setActiveJob(updatedJob);
                setTemplateId("general"); // Ensure global store is updated
                console.log("Analys uppdaterad!");
            } catch (e: any) {
                console.error("Re-analyze failed:", e);
                events.analysisFailed(e?.message || 'unknown');
                if (e.message?.includes("Payment Required")) {
                    setShowUpsellModal(true);
                } else {
                    toast.error("Kunde inte uppdatera analys.");
                }
            } finally {
                setIsReanalyzing(false);
            }
        } else {
            // Initial Sync
            const uploadPath = activeJob ? activeJob.file_path : currentSessionPath;

            /**
             * Guard: uploadPath may be null if the Rust backend hasn't emitted the
             * 'history-updated' event yet (e.g. WAV finalisation is still in progress).
             * We surface this as a toast rather than failing silently.
             */
            if (!uploadPath) {
                toast.error("Uppladdning saknas: Inspelningsfilen är inte klar än. Försök igen om ett ögonblick.");
                return;
            }

            events.cloudSyncStarted();
            setUploadStatus('uploading');
            setErrorMessage(null);

            try {
                const job = await uploadJob(uploadPath, "general", token, useSettingsStore.getState().autoAnalyzeCloud);
                setUploadStatus('success');

                const targetDbId = activeJob ? activeJob.id : (currentSessionId ? parseInt(currentSessionId) : null);

                if (targetDbId) {
                    try {
                        await invoke("update_recording_status", {
                            id: targetDbId,
                            status: 'uploaded',
                            cloudJobId: job.id
                        });
                        console.log("Updated DB status to uploaded for id:", targetDbId);

                        if (activeJob) {
                            setActiveJob({
                                ...activeJob,
                                sync_status: 'uploaded',
                                cloud_job_id: job.id
                            });
                        }
                    } catch (e) {
                        console.error("Failed to update DB status:", e);
                    }
                }
                setUploadedJobId(job.id);
            } catch (error: any) {
                console.error("Upload failed", error);
                setUploadStatus('error');
                setProcessingStatus('FAILED');
                setUploadedJobId(null);
                setErrorMessage(String(error));
                if (error.message?.startsWith("Unauthorized")) {
                    clearSession();
                    toast.error("Din session är inte längre giltig. Logga in igen.");
                } else if (error.message?.includes("Payment Required")) {
                    toast.error(error.message);
                } else {
                    toast.error(`Uppladdning misslyckades: ${error.message || error.toString()}`);
                }
            }
        }
    };

    // Fetch segments when activeJob changes.
    // Prefer cloud_transcript on activeJob (survives tab switches) over DB segments.
    useEffect(() => {
        if (activeJob) {
            if (activeJob.ai_template_used) {
                setTemplateId(activeJob.ai_template_used);
            } else {
                setTemplateId("general");
            }

            if (activeJob.cloud_transcript) {
                setSegments([{
                    id: -1,
                    start_time: 0,
                    end_time: 0,
                    text: activeJob.cloud_transcript,
                    speaker: "MOLN",
                    timestamp: Date.now(),
                }]);
                return;
            }

            invoke<any[]>("get_recording_segments", { recordingId: activeJob.id })
                .then(segments => {
                    const currentActiveJob = useSyncStore.getState().activeJob;
                    if (!currentActiveJob && !uploadedJobId) return;
                    const uiSegments = segments.map(s => ({
                        ...s,
                        timestamp: s.start_time * 1000
                    }));
                    setSegments(uiSegments);
                })
                .catch(err => {
                    console.error("Failed to load segments:", err);
                    setSegments([]);
                });
        } else {
            clearSegments();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeJob?.id, activeJob?.cloud_transcript, setSegments, clearSegments]);

    const formatDuration = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    useEffect(() => {
        if (!activeJob?.id) return;


        const interval = setInterval(async () => {
            // Guard: If we are no longer interested in this job (e.g. user clicked "Back to Live"), stop polling.
            // We check local variable `uploadedJobId` but also need to check if the store has been reset.
            // Since `uploadedJobId` in dependency array triggers re-run, if it becomes null, this specific interval *should* be cleared by cleanup.
            // BUT, if the async `getJob` is in flight, it might resolve AFTER we reset.

            // To fix "Zombie Analysis":
            // 1. Check if we still have a valid ID in the store (or passed prop).
            // 2. Check if we are in "Active Job" mode (which should be null for live).
            // However, `uploadedJobId` IS for live-analysis polling. `activeJob` is for archive.

            // If the user clicked "Back to Live", `uploadedJobId` becomes null.
            // The cleanup function `clearInterval(interval)` runs.
            // BUT an existing `await getJob(uploadedJobId)` might be running.

            try {
                if (!uploadedJobId) return;

                // Double check validity before setting state
                const currentJobId = useSyncStore.getState().uploadedJobId;
                if (!currentJobId) return;

                const token = getToken();
                if (!token) return;

                const job = await getJob(uploadedJobId, token);

                // Final guard before updating state
                const currentActiveJob = useSyncStore.getState().activeJob;
                if (!currentActiveJob && !useSyncStore.getState().uploadedJobId) return;

                setProcessingStatus(job.status);

                if (job.status === 'COMPLETED') {
                    const analysis = job.analysis || {};

                    const completedAnalysis: AnalysisData = {
                        summary: analysis.summary || "",
                        decisions: analysis.key_decisions || [],
                        actions: analysis.action_items || [],
                        template_used: analysis.template_used
                    };

                    // Guard again
                    if (!useSyncStore.getState().uploadedJobId) return;

                    setAnalysisData(completedAnalysis);
                    events.analysisCompleted();

                    // Replace local whisper segments with the superior Berget cloud transcription
                    const cloudText = job.result?.text;
                    if (cloudText) {
                        const wordCount = cloudText.trim().split(/\s+/).filter(Boolean).length;
                        events.cloudSyncCompleted(wordCount);
                    }
                    // Stop polling — prevents future intervals from overwriting re-analysis
                    setUploadedJobId(null);
                    if (cloudText && cloudText.trim()) {
                        const cloudSegment: UISegment = {
                            id: -1,
                            start_time: 0,
                            end_time: 0,
                            text: cloudText.trim(),
                            speaker: "MOLN", // Special marker: cloud-sourced
                            timestamp: Date.now(),
                        };
                        setSegments([cloudSegment]);
                    }

                    // Save to Local DB
                    const currentActiveJob = useSyncStore.getState().activeJob;
                    if (currentActiveJob?.id) {
                        try {
                            await invoke("save_analysis_to_db", {
                                id: currentActiveJob.id,
                                analysis: JSON.stringify(completedAnalysis),
                                template: completedAnalysis.template_used || "general"
                            });

                            // Persist cloud_transcript so segments survive tab switches
                            const updatedJob = {
                                ...currentActiveJob,
                                analysis_json: JSON.stringify(completedAnalysis),
                                cloud_transcript: cloudText || null,
                            };
                            setActiveJob(updatedJob);
                        } catch (e) {
                            console.error("Failed to save analysis to DB:", e);
                        }
                    }

                    clearInterval(interval);
                } else if (job.status === 'FAILED') {
                    console.error("Job failed processing:", job.error_message);
                    clearInterval(interval);
                }
            } catch (err) {
                console.error("Polling error:", err);
            }
        }, 2000);

        return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uploadedJobId, setAnalysisData, setProcessingStatus, activeJob?.id, setActiveJob, setUploadedJobId]);

    // Helper to get status text
    const getStatusText = () => {
        const withAnalysis = effectiveMode === 'cloud_analysis';
        switch (processingStatus) {
            case 'PENDING': return withAnalysis ? "Köar för transkribering och analys..." : "Köar för transkribering...";
            case 'PROCESSING': return withAnalysis ? "Transkriberar och analyserar med KB-Whisper Large..." : "Transkriberar med KB-Whisper Large...";
            case 'FAILED': return withAnalysis ? "Transkribering/analys misslyckades." : "Transkribering misslyckades.";
            default: return "Bearbetar i molnet...";
        }
    };

    return (
        <div className="grid grid-cols-5 h-full overflow-hidden bg-slate-50/50">
            {/* Left: Live Transcription (60% -> 3/5 cols) */}
            <div className="col-span-3 flex flex-col h-full overflow-hidden min-w-0 bg-white border-r border-slate-200/60 shadow-[4px_0_24px_-12px_rgba(0,0,0,0.1)] z-10 relative">
                <div className="px-8 py-6 flex-none flex justify-between items-center bg-white border-b border-slate-100 z-50">
                    <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2.5 text-slate-900">
                        <div className="p-1.5 bg-indigo-50 rounded-lg text-indigo-600">
                            <FileText className="w-4 h-4" />
                        </div>
                        Transkription
                        {segments.length > 0 && (
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-slate-400 hover:text-slate-600 ml-1 rounded-full"
                                onClick={(e) => handleCopy(segments.map(s => s.text).join(" "), "transcript", e)}
                                title="Kopiera transkription"
                            >
                                {copiedKey === "transcript" ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                            </Button>
                        )}
                        {/* Re-transcribe with Large — shown when cloud mode is selected, not currently recording/processing */}
                        {segments.length > 0 && !isRecording && !uploadedJobId && !isRetranscribing &&
                         (recordingMode === 'cloud' || recordingMode === 'cloud_analysis') && (
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-slate-400 hover:text-purple-600 hover:bg-purple-50 ml-0.5 rounded-full"
                                onClick={handleRetranscribe}
                                title={segments.some(s => s.speaker === 'MOLN') ? "Transkribera om med KB-Whisper Large" : "Transkribera med KB-Whisper Large"}
                            >
                                {segments.some(s => s.speaker === 'MOLN')
                                    ? <RefreshCw className="h-3.5 w-3.5" />
                                    : <Cloud className="h-3.5 w-3.5" />
                                }
                            </Button>
                        )}
                    </h2>
                    <div className="flex items-center gap-3">
                        <ModePill onUpsellClick={() => setShowUpsellModal(true)} />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto min-h-0 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-slate-200 [&::-webkit-scrollbar-thumb]:rounded-full">
                    <div className="p-8 pt-4 max-w-3xl mx-auto space-y-8">
                        {/* History Banner — only shown when user explicitly opened a recording from history */}
                        {activeJob && activeJobFromHistory && (
                            <div className="bg-slate-100 border border-slate-200 rounded-lg px-4 py-2.5 flex items-center justify-between animate-in fade-in slide-in-from-top-2">
                                <div className="flex items-center gap-2 text-slate-600">
                                    <History className="w-4 h-4 flex-shrink-0" />
                                    <span className="text-sm">
                                        {(() => {
                                            const date = new Date(activeJob.created_at || activeJob.createdAt);
                                            const isToday = date.toDateString() === new Date().toDateString();
                                            const dateStr = isToday ? 'Idag' : date.toLocaleDateString('sv-SE', { day: 'numeric', month: 'long' });
                                            const dur = formatDuration((activeJob.duration_sec || activeJob.durationSeconds) ?? 0);
                                            return `${dateStr} • ${dur}`;
                                        })()}
                                    </span>
                                </div>
                                <button
                                    className="text-xs text-slate-400 hover:text-slate-700 transition-colors ml-4"
                                    onClick={() => {
                                        reset();
                                        resetToLive();
                                        clearSegments();
                                    }}
                                >
                                    Stäng
                                </button>
                            </div>
                        )}

                        {!activeJob && segments.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-[50vh] text-center space-y-4 animate-in fade-in duration-1000">
                                <>
                                        <div className={`p-4 rounded-full bg-slate-100 ${isRecording ? "opacity-100" : "opacity-40"}`}>
                                            <Sparkles className={`w-8 h-8 ${isRecording ? "text-red-400 animate-pulse" : "text-slate-400"}`} />
                                        </div>
                                        <div className={`space-y-1 ${isRecording ? "opacity-100" : "opacity-40"}`}>
                                            <p className="text-slate-900 font-medium">
                                                {isRecording ? "🔴 Lyssnar och transkriberar lokalt..." : "Redo för mötet"}
                                            </p>
                                            <p className="text-sm text-slate-500 max-w-xs mx-auto">
                                                {isRecording
                                                    ? "Genererar ljudutskrift..."
                                                    : "Starta inspelningen för att se transkribering i realtid."}
                                            </p>
                                        </div>
                                    </>
                            </div>
                        ) : (
                            segments
                                .filter(segment => !segment.text.includes('<|nospeech|>'))
                                .map((segment, index) => (
                                    <div key={index} className="group flex flex-col gap-2 animate-in fade-in slide-in-from-bottom-2 duration-500 fill-mode-backwards" style={{ animationDelay: `${index * 50}ms` }}>
                                        <div className="flex items-center gap-2">
                                            {segment.speaker === "MOLN" ? (
                                                <span className="text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-md bg-purple-50 text-purple-600 border border-purple-100">
                                                    ☁ KB-Whisper Large
                                                </span>
                                            ) : (
                                            <>
                                            <span className={`text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-md ${segment.speaker === "DU" || segment.speaker === "mic"
                                                ? "bg-indigo-50 text-indigo-600 border border-indigo-100"
                                                : "bg-rose-50 text-rose-600 border border-rose-100"
                                                }`}>
                                                {segment.speaker === "mic" ? "DU" : segment.speaker === "sys" ? "MÖTET" : segment.speaker}
                                            </span>
                                            <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-slate-50 text-slate-400 border border-slate-100">
                                                🖥 KB-Whisper Small
                                            </span>
                                            </>
                                            )}
                                        <span className="text-[10px] text-slate-300 font-mono opacity-0 group-hover:opacity-100 transition-opacity">
                                                {segment.speaker !== "MOLN" && new Date(segment.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                            </span>
                                        </div>
                                        <p className={`leading-relaxed text-[15px] pl-1 border-l-2 transition-all ${
                                            segment.speaker === "MOLN"
                                              ? "text-slate-800 border-purple-200 group-hover:border-purple-300"
                                              : "text-slate-700 border-transparent group-hover:border-slate-100"
                                          }`}>
                                            {segment.text}
                                        </p>
                                    </div>
                                ))
                        )}
                        {/* Live Listening Indicator — shown at bottom of existing segments during recording */}
                        {isRecording && segments.length > 0 && (
                            <div className="flex items-center gap-2 pl-1 mt-2">
                                <span className="relative flex h-2 w-2">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                                </span>
                                <span className="text-xs text-slate-400">Lyssnar...</span>
                            </div>
                        )}
                        {/* Cloud Processing Indicator — shown while polling for Berget result */}
                        {!activeJob && !isRecording && processingStatus === 'PROCESSING' && (
                            <div className="flex items-center gap-2 pl-1 mt-2">
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-500" />
                                <span className="text-xs text-purple-600 font-medium">{getStatusText()}</span>
                            </div>
                        )}
                        {/* Local Finalizing Indicator */}
                        {!activeJob && isProcessing && !isRecording && processingStatus !== 'PROCESSING' && (
                            <div className="flex flex-col gap-3 animate-pulse pl-1 mt-4">
                                <div className="flex items-center gap-2">
                                    <Loader2 className="w-4 h-4 animate-spin text-indigo-500" />
                                    <span className="text-xs font-medium text-indigo-600">Slutför transkribering... vänta</span>
                                </div>
                                <div>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleCancel}
                                        className="text-xs text-slate-500 hover:text-red-600"
                                    >
                                        Avbryt
                                    </Button>
                                </div>
                            </div>
                        )}
                        <div ref={scrollRef} className="h-10" />
                    </div>
                </div>
            </div>

            {/* Right: AI Insights (40% -> 2/5 cols) */}
            <div className="col-span-2 flex flex-col h-full overflow-hidden bg-slate-50/50 relative">
                <div className="px-8 py-6 flex-none bg-slate-50 border-b border-slate-100 z-50 flex justify-between items-center">
                    <h2 className="text-lg font-medium tracking-tight flex items-center gap-2 text-slate-700">
                        <Sparkles className="w-4 h-4 text-indigo-500" />
                        AI Insikter
                    </h2>

                    {/* User button */}
                    {isSignedIn && (
                        <div className="relative" ref={userMenuRef}>
                            <button
                                onClick={() => setShowUserMenu((v) => !v)}
                                className="w-8 h-8 rounded-full bg-indigo-600 text-white text-xs font-semibold flex items-center justify-center hover:bg-indigo-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-2"
                                title={email || "Konto"}
                            >
                                {initials}
                            </button>
                            {showUserMenu && (
                                <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl shadow-lg border border-slate-200 py-2 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                                    <div className="px-4 py-2 border-b border-slate-100">
                                        <p className="text-sm font-medium text-slate-900 truncate">{email}</p>
                                        <p className="text-xs text-slate-500 mt-0.5">{isPro ? "Sagt Pro" : "Free"}</p>
                                    </div>
                                    <button
                                        onClick={() => { setShowUserMenu(false); clearSession(); }}
                                        className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 transition-colors flex items-center gap-2"
                                    >
                                        <LogOut className="w-3.5 h-3.5" />
                                        Logga ut
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className="flex-1 flex flex-col gap-4 p-8 pt-4 overflow-y-auto min-h-0 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-slate-200 [&::-webkit-scrollbar-thumb]:rounded-full">
                        {/* Summary Section */}
                        {(analysisData || uploadedJobId || (isSignedIn && isPro)) && (
                            <Card className="border border-indigo-100 shadow-sm bg-white/80 p-6 space-y-4 relative overflow-hidden flex-none">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <h3 className="font-semibold text-xs text-indigo-900 uppercase tracking-widest opacity-70">Sammanfattning</h3>
                                    {analysisData?.summary && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-5 w-5 text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-full"
                                            onClick={(e) => handleCopy(analysisData.summary, "summary", e)}
                                            title="Kopiera sammanfattning"
                                        >
                                            {copiedKey === "summary" ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                                        </Button>
                                    )}
                                </div>
                                {/* Analyze / re-analyze button: shown whenever there is a transcription and user is Pro */}
                                {!isReanalyzing && isPro && isSignedIn && segments.length > 0 && !isRecording && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-full"
                                      title={analysisData ? "Analysera igen" : "Starta analys"}
                                      onClick={handleAction}
                                    >
                                      {analysisData ? <RefreshCw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                                    </Button>
                                )}
                            </div>

                            {isReanalyzing ? (
                                <div className="flex flex-col items-center justify-center h-[50vh] space-y-4 p-8 text-center animate-in fade-in zoom-in-95 duration-500">
                                    <div className="relative">
                                        <div className="absolute inset-0 bg-indigo-200 rounded-full animate-ping opacity-25"></div>
                                        <div className="relative w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-600">
                                            <Loader2 className="w-6 h-6 animate-spin" />
                                        </div>
                                    </div>
                                    <div className="text-center space-y-1">
                                        <h3 className="text-sm font-medium text-slate-900">Uppdaterar analys...</h3>
                                        <p className="text-xs text-slate-500 animate-pulse">
                                            Analyserar kontext, beslut och åtgärder...
                                        </p>
                                    </div>
                                </div>
                            ) : analysisData ? (
                                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
                                    <div className="prose prose-sm prose-slate max-w-none">
                                        <p className="text-sm text-slate-700 leading-relaxed bg-white p-3 rounded-lg border border-slate-100 shadow-sm">
                                            {analysisData.summary || "Ingen sammanfattning tillgänglig."}
                                        </p>
                                    </div>

                                    {/* Decisions Block */}
                                    <div className="space-y-2 mt-4">
                                        <div className="flex items-center gap-2">
                                            <h4 className="text-xs font-semibold text-slate-900 uppercase tracking-wide flex items-center gap-1.5">
                                                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div>
                                                Beslut
                                            </h4>
                                            {analysisData.decisions && analysisData.decisions.length > 0 && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-5 w-5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full"
                                                    onClick={(e) => handleCopy(analysisData.decisions!.join("\n"), "decisions", e)}
                                                    title="Kopiera beslut"
                                                >
                                                    {copiedKey === "decisions" ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                                                </Button>
                                            )}
                                        </div>
                                        {analysisData.decisions && analysisData.decisions.length > 0 ? (
                                            <ul className="space-y-2">
                                                {analysisData.decisions.map((decision: string, i: number) => (
                                                    <li key={i} className="text-xs text-slate-600 bg-emerald-50/50 p-2 rounded border border-emerald-100/50 flex gap-2 items-start">
                                                        <span className="text-emerald-500 font-bold">•</span>
                                                        {decision}
                                                    </li>
                                                ))}
                                            </ul>
                                        ) : (
                                            <p className="text-xs text-slate-400 italic">Inga beslut identifierade.</p>
                                        )}
                                    </div>

                                    {/* Actions Block */}
                                    <div className="space-y-2 mt-4">
                                        <div className="flex items-center gap-2">
                                            <h4 className="text-xs font-semibold text-slate-900 uppercase tracking-wide flex items-center gap-1.5">
                                                <div className="w-1.5 h-1.5 rounded-full bg-indigo-500"></div>
                                                Åtgärder
                                            </h4>
                                            {analysisData.actions && analysisData.actions.length > 0 && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-5 w-5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full"
                                                    onClick={(e) => handleCopy(analysisData.actions!.join("\n"), "actions", e)}
                                                    title="Kopiera åtgärder"
                                                >
                                                    {copiedKey === "actions" ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                                                </Button>
                                            )}
                                        </div>
                                        {analysisData.actions && analysisData.actions.length > 0 ? (
                                            <ul className="space-y-2">
                                                {analysisData.actions.map((action: string, i: number) => (
                                                    <li key={i} className="text-xs text-slate-600 bg-indigo-50/50 p-2 rounded border border-indigo-100/50 flex gap-2 items-start">
                                                        <div className="w-3 h-3 rounded border border-indigo-200 mt-0.5 flex-shrink-0"></div>
                                                        {action}
                                                    </li>
                                                ))}
                                            </ul>
                                        ) : (
                                            <p className="text-xs text-slate-400 italic">Inga åtgärder identifierade.</p>
                                        )}
                                    </div>
                                </div>
                            ) : uploadedJobId ? (
                                <div className="flex flex-col items-center justify-center p-8 space-y-4 animate-in fade-in zoom-in-95 duration-500">
                                    <div className="relative">
                                        <div className="absolute inset-0 bg-indigo-200 rounded-full animate-ping opacity-25"></div>
                                        <div className="relative w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-600">
                                            <Sparkles className="w-6 h-6 animate-pulse" />
                                        </div>
                                    </div>
                                    <div className="text-center space-y-1">
                                        <h3 className="text-sm font-medium text-slate-900">{getStatusText()}</h3>
                                        <p className="text-xs text-slate-500">
                                            Analyserar kontext, beslut och åtgärder.
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div className="space-y-3 opacity-50">
                                        <div className="h-2 bg-slate-100 rounded w-3/4"></div>
                                        <div className="h-2 bg-slate-100 rounded w-full"></div>
                                        <div className="h-2 bg-slate-100 rounded w-5/6"></div>
                                    </div>
                                    <p className="text-xs text-slate-400 italic pt-2 text-center">
                                        {isRecording ? "Transkriberar ljudutskrift i realtid..." : "Starta inspelning för att se live-transkribering."}
                                    </p>
                                </>
                            )}
                        </Card>
                        )}

                        {/* Rendering Auth vs Action Block Hierarchy */}
                        {(!isSignedIn) ? (
                            <div className="border border-indigo-100 rounded-xl overflow-hidden animate-in fade-in zoom-in-95 duration-500">
                                {/* Gradient header */}
                                <div className="h-20 bg-gradient-to-br from-indigo-500 to-purple-600 relative flex items-center justify-center overflow-hidden">
                                    <div className="absolute top-0 right-0 -translate-y-1/2 translate-x-1/3 w-32 h-32 bg-white/10 rounded-full blur-2xl" />
                                    <div className="relative z-10 flex flex-col items-center text-white gap-1">
                                        <div className="w-9 h-9 bg-white/20 backdrop-blur border border-white/30 rounded-full flex items-center justify-center shadow-lg">
                                            <CloudLightning className="w-5 h-5 text-white" />
                                        </div>
                                        <span className="text-sm font-bold tracking-tight">Sagt.ai Pro</span>
                                    </div>
                                </div>
                                <div className="p-5 bg-white space-y-4">
                                    <ul className="space-y-2.5">
                                        {[
                                            "KB-Whisper Large — överlägsen precision på svenska",
                                            "AI-sammanfattning, beslut och åtgärdspunkter",
                                            "Molnsynk av dina inspelningar",
                                            "100% Data Sovereignty inom EU"
                                        ].map((item, i) => (
                                            <li key={i} className="flex items-start gap-2.5 text-xs text-slate-700">
                                                <div className="mt-0.5 w-3.5 h-3.5 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center flex-shrink-0">
                                                    <Check className="w-2 h-2" />
                                                </div>
                                                {item}
                                            </li>
                                        ))}
                                    </ul>
                                    <div className="flex flex-col gap-2 pt-1">
                                        <Button onClick={() => setShowLoginModal(true)} className="w-full bg-indigo-600 hover:bg-indigo-700 shadow-sm" size="sm">
                                            Logga in
                                        </Button>
                                        <p className="text-[10px] text-slate-400 text-center">Redan kund? Logga in för att aktivera Pro-funktioner.</p>
                                    </div>
                                </div>
                            </div>
                        ) : (!isPro) ? (
                            <div className="flex flex-col items-center justify-center p-6 space-y-4 border border-indigo-200 rounded-xl bg-indigo-50/80 text-center relative overflow-hidden animate-in fade-in zoom-in-95 duration-500">
                                <div className="absolute -right-4 -top-4 w-24 h-24 bg-indigo-200 rounded-full blur-2xl opacity-50"></div>
                                <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center text-indigo-600 shadow-sm border border-indigo-100 relative z-10">
                                    {isPaymentWaiting
                                        ? <Loader2 className="w-6 h-6 animate-spin" />
                                        : <Sparkles className="w-6 h-6" />
                                    }
                                </div>
                                <div className="relative z-10">
                                    <h3 className="text-sm font-bold text-indigo-950 mb-1">
                                        {isPaymentWaiting ? "Väntar på betalningsbekräftelse" : "Lås upp Sagt Pro"}
                                    </h3>
                                    <p className="text-xs text-indigo-800/80 w-full max-w-xs mx-auto mb-3 leading-relaxed">
                                        {isPaymentWaiting
                                            ? "Betalning öppnad i webbläsaren. Uppdateras automatiskt..."
                                            : "Få obegränsad molntranskribering och djupgående analyser (Sovereign Llama 3.3)."}
                                    </p>
                                </div>

                                {isPaymentWaiting ? (
                                    <div className="flex flex-col items-center gap-2 relative z-10 w-full">
                                        <button
                                            onClick={manualPaymentRefresh}
                                            className="text-xs font-medium text-indigo-700 hover:text-indigo-900 underline underline-offset-2"
                                        >
                                            Jag har betalat — uppdatera nu
                                        </button>
                                        <button
                                            onClick={stopPaymentPolling}
                                            className="text-xs text-slate-400 hover:text-slate-600"
                                        >
                                            Avbryt
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex flex-col items-center gap-2 relative z-10 w-full">
                                        <Button onClick={async () => {
                                            if (stripePaymentLink && userId) {
                                                events.upgradeClicked();
                                                const { invoke } = await import('@tauri-apps/api/core');
                                                invoke('plugin:shell|open', { path: `${stripePaymentLink}?client_reference_id=${userId}` });
                                                startPaymentPolling();
                                            } else {
                                                toast.error("Betalningslänk ej tillgänglig. Försök starta om appen.");
                                            }
                                        }} className="w-full max-w-[200px] bg-indigo-600 hover:bg-indigo-700 shadow-sm transition-all duration-200" size="sm">
                                            Uppgradera nu
                                        </Button>
                                        <button
                                            onClick={manualPaymentRefresh}
                                            className="text-xs text-indigo-500 hover:text-indigo-700"
                                        >
                                            Har du redan betalat? Uppdatera status →
                                        </button>
                                    </div>
                                )}
                            </div>
                        ) : null}
                </div>
            </div >

            {/* Login Modal Overlay */}
            {showLoginModal && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl p-8 w-[440px] shadow-2xl relative animate-in zoom-in-95 duration-300 text-center">
                        <button
                            onClick={() => setShowLoginModal(false)}
                            className="absolute top-4 right-4 p-2 rounded-full hover:bg-slate-100 text-slate-500 hover:text-slate-900 transition-colors z-10"
                        >
                            ✕
                        </button>
                        <div className="w-14 h-14 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4">
                            <CloudLightning className="w-7 h-7 text-indigo-600" />
                        </div>
                        <h2 className="text-lg font-bold text-slate-900 mb-2">Logga in på Sagt.ai</h2>
                        <p className="text-sm text-slate-500 mb-6">
                            {isAuthenticating
                                ? "Väntar på att du loggar in i webbläsaren..."
                                : "Inloggningen öppnas i din webbläsare. Logga in och kom tillbaka hit."}
                        </p>
                        {isAuthenticating ? (
                            <div className="flex flex-col items-center gap-3">
                                <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
                                <p className="text-xs text-slate-400">Väntar på autentisering...</p>
                            </div>
                        ) : (
                            <Button
                                onClick={startAuth}
                                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
                            >
                                Öppna webbläsaren
                            </Button>
                        )}
                    </div>
                </div>
            )}
            
            <UpsellModal 
                isOpen={showUpsellModal} 
                onClose={() => setShowUpsellModal(false)} 
            />
        </div >
    );
}
