// Removed ScrollArea import
import { Card } from "@/components/ui/card";
import { FileText, Sparkles, History, Loader2, Copy, RefreshCw, Play, Cloud, Check, LogOut, Lock, Users, X } from "lucide-react";
import { useTranscription } from "@/hooks/use-transcription";
import { cancelCloudStream } from "@/hooks/use-cloud-stream";
import { useSyncStore } from "@/store/sync-store";
import { useSettingsStore } from "@/store/settings-store";
import { useTranscriptionStore, UISegment } from "@/store/transcription-store";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { getJob, reanalyzeTranscript, reanalyzeJob, uploadJob, identifySpeakers, SpeakerTurn } from "@/lib/api";
import { applyInlineCloudResult, cloudSegmentsJsonFromJob } from "@/lib/cloud-sync";
import { AnalysisData } from "@/store/sync-store";
import { useAuthStore } from "@/store/auth-store";
import { toast } from "sonner";
import { ModePill } from "./mode-pill";
import { UpsellModal } from "./upsell-modal";
import { usePaymentRefresh } from "@/hooks/use-payment-refresh";
import { usePostHogEvents } from "@/hooks/use-posthog-events";

export function SplitView() {
    const isSignedIn = useAuthStore((s) => s.isSignedIn);
    const getToken = useAuthStore((s) => s.getToken);
    const isPro = useAuthStore((s) => s.isPro());
    const email = useAuthStore((s) => s.email);
    const clearSession = useAuthStore((s) => s.clearSession);
    const events = usePostHogEvents();
    const { isWaiting: isPaymentWaiting, stopPolling: stopPaymentPolling } = usePaymentRefresh();
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
        effectiveMode, cloudStreamingActive
    } = useSyncStore();
    // Access store actions to populate segments for archive view
    const { setSegments, clearSegments } = useTranscriptionStore();
    const { recordingMode, pauseBreakMs } = useSettingsStore();

    // "Lokalt"-indikatorn ska bara visas som ÄKTA fallback — när molnet var avsett (Pro valde
    // moln) men inte är aktivt (offline) — aldrig när användaren medvetet valt lokalt läge.
    // Och endast medan inspelning pågår, så den inte ligger kvar efteråt.
    const cloudIntended = recordingMode === 'cloud' || recordingMode === 'cloud_analysis';
    const showLocalFallbackBadge = cloudIntended && !cloudStreamingActive && isRecording;

    // Per-modell-vy: en inspelning kan ha BÅDE lokala segment (Du/Mötet) och ett
    // molnresultat (KB-Whisper Large i cloud_transcript). Resultaten skriver aldrig
    // över varandra — användaren växlar vy och ser skillnaden mellan modellerna.
    const [transcriptView, setTranscriptView] = useState<'local' | 'cloud'>('local');
    const cloudTranscript: string | null = activeJob?.cloud_transcript?.trim() || null;

    // Fas 1c: strukturerade molnsegment (DU/MÖTET-turer från stereo-omtranskribering).
    // När de finns renderar molnvyn äkta turer i stället för den flata textblobben — och
    // Fas 1:s namnsättning ("Identifiera talare") fungerar då även på molnresultatet.
    // Faller tillbaka till flat blob (cloud_transcript) för mono/gamla inspelningar.
    const cloudStructured = useMemo((): UISegment[] => {
        const raw: string | undefined = activeJob?.cloud_segments;
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed
                .filter((s: any) => String(s?.text ?? "").trim())
                .map((s: any, i: number) => ({
                    id: -(i + 1),
                    start_time: s.start_time ?? 0,
                    end_time: s.end_time ?? 0,
                    text: String(s.text).trim(),
                    speaker: s.speaker || "MÖTET",
                    timestamp: 0,
                }));
        } catch {
            return [];
        }
    }, [activeJob?.cloud_segments]);

    const hasCloudResult = !!cloudTranscript || cloudStructured.length > 0;
    const hasModelToggle = hasCloudResult && rawSegments.length > 0;

    // Derive displayed segments synchronously so the first render after a tab switch
    // already shows the cloud result — no flash of stale local segments.
    const segments = useMemo((): UISegment[] => {
        // Molnvyn: strukturerade turer om de finns, annars flat MOLN-blob (gamla/mono).
        const cloudSeg = (): UISegment[] => {
            if (cloudStructured.length > 0) return cloudStructured;
            if (cloudTranscript) return [{
                id: -1,
                start_time: 0,
                end_time: 0,
                text: cloudTranscript,
                speaker: "MOLN" as const,
                timestamp: 0,
            }];
            return [];
        };
        if (hasModelToggle && transcriptView === 'cloud') return cloudSeg();
        if (rawSegments.length > 0) {
            // Molnchunks kan slutföras i annan ordning än de talades — sortera på start_time.
            return [...rawSegments].sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
        }
        if (hasCloudResult) return cloudSeg();
        return [];
    }, [cloudTranscript, cloudStructured, hasCloudResult, hasModelToggle, transcriptView, rawSegments]);

    // Visa molnresultatet som standard när det finns (bästa modellen) — både vid
    // återöppning från historiken och när en omtranskribering/auto-synk blir klar.
    // Manuell växling påverkas inte (deps ändras bara när molnresultatet byts).
    useEffect(() => {
        setTranscriptView((activeJob?.cloud_transcript || activeJob?.cloud_segments) ? 'cloud' : 'local');
    }, [activeJob?.id, activeJob?.cloud_transcript, activeJob?.cloud_segments]);

    // Sammanhängande-läge: alla segment är "MOLN" → rendera som ETT flöde med styckesbryt
    // vid pauser (gap mellan segment ≥ pauseBreakMs). Pausbryt härleds ur Rusts VAD-timing.
    const isMerged = segments.length > 0 && segments.every(s => s.speaker === "MOLN");
    const mergedParagraphs = useMemo((): string[] => {
        if (!isMerged) return [];
        const paras: string[] = [];
        let cur = "";
        let prevEnd: number | null = null;
        for (const s of segments) {
            const t = s.text.trim();
            if (!t) continue;
            if (prevEnd != null && (s.start_time - prevEnd) * 1000 >= pauseBreakMs) {
                if (cur) paras.push(cur);
                cur = t;
            } else {
                cur = cur ? `${cur} ${t}` : t;
            }
            prevEnd = s.end_time || s.start_time;
        }
        if (cur) paras.push(cur);
        return paras;
    }, [isMerged, segments, pauseBreakMs]);

    // Talaridentifiering (Fas 1): namnmappning (kanonisk etikett → namn) + deltagarlista.
    // Icke-förstörande — segmenten rörs aldrig, namnen appliceras ovanpå Du/Mötet i vyn.
    const [speakerMap, setSpeakerMap] = useState<Record<string, string>>({});
    const [participants, setParticipants] = useState<string[]>([]);
    const [editingTurnIndex, setEditingTurnIndex] = useState<number | null>(null);
    const [editingName, setEditingName] = useState("");
    const [newParticipant, setNewParticipant] = useState("");
    const [isIdentifying, setIsIdentifying] = useState(false);

    // Kanonisk etikett: mic/DU → "DU", sys/MÖTET → "MÖTET" (segment kan bära endera formen).
    // Mappning och hints nycklas på den kanoniska formen så de två varianterna inte splittras.
    const speakerKey = (sp: string) =>
        (sp === "mic" || sp === "DU") ? "DU" : (sp === "sys" || sp === "MÖTET") ? "MÖTET" : sp;
    const defaultLabel = (sp: string) => {
        const k = speakerKey(sp);
        return k === "DU" ? "Du" : k === "MÖTET" ? "Mötet" : sp;
    };

    // #9: gruppera på varandra följande segment med SAMMA talare till en "tur" (som mockupen
    // på startsidan): fet "Mötet:"/"Du:" inline + text, ny tur bara vid talarbyte eller paus.
    // Namnet hämtas ur speakerMap (kanonisk nyckel), annars Du/Mötet-default.
    const speakerLabel = (sp: string) => speakerMap[speakerKey(sp)] || defaultLabel(sp);
    const turns = useMemo(() => {
        const out: { speaker: string; text: string; start_time: number; end_time: number }[] = [];
        for (const s of segments) {
            if (s.text.includes('<|nospeech|>')) continue;
            const t = s.text.trim();
            if (!t) continue;
            const last = out[out.length - 1];
            const gap = last ? (s.start_time - last.end_time) * 1000 : 0;
            if (last && last.speaker === s.speaker && gap < pauseBreakMs) {
                last.text += " " + t;
                last.end_time = s.end_time || s.start_time;
            } else {
                out.push({ speaker: s.speaker, text: t, start_time: s.start_time, end_time: s.end_time || s.start_time });
            }
        }
        return out;
    }, [segments, pauseBreakMs]);

    // Det finns talaretiketter att namnsätta (Du/Mötet/Talare-N) — inte sammanhängande
    // molntext (MOLN, ett enda flöde utan talare). Styr chips-raden + "Identifiera talare".
    const hasNamableSpeakers = !isMerged && turns.some(t => t.speaker !== "MOLN");

    // Kopiera EXAKT det som visas i vyn: samma turer (gruppering per talare) som renderas,
    // inte ett prefix per råsegment/mening. Merged-läget kopierar styckena.
    const buildCopyText = (): string => {
        if (isMerged) return mergedParagraphs.join("\n\n");
        return turns
            .map(turn => {
                const label = turn.speaker === "MOLN" ? "" : speakerLabel(turn.speaker);
                return label ? `${label}: ${turn.text}` : turn.text;
            })
            .join("\n\n");
    };

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
        // #11: töm moln-kön också — annars fortsätter buffrade chunks att POSTas och text dimpa in.
        cancelCloudStream();
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
        if (!isSignedIn || !isPro) { setShowUpsellModal(true); return; }
        if (!navigator.onLine) { toast.error("Denna funktion kräver internetanslutning."); return; }
        if (activeJob?.audio_deleted) {
            toast.error("Ljudfilen är raderad — molntranskribering kräver ljudet. Transkript och analys finns kvar.");
            return;
        }

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
            if (useSettingsStore.getState().cloudSync) {
                setUploadedJobId(job.id);
                setProcessingStatus("PROCESSING");
                toast.success("Transkriberar med KB-Whisper Large...");
            } else {
                const dbId = activeJob?.id ?? (currentSessionId ? parseInt(currentSessionId) : null);
                const wc = await applyInlineCloudResult(job, dbId);
                events.cloudSyncCompleted(wc);
                setTranscriptView('cloud'); // visa det nya molnresultatet direkt
                toast.success("Transkriberad med KB-Whisper Large (resultat endast lokalt).");
            }
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

    // Ladda persisterad namnmappning + deltagarlista. SPARAD inspelning (öppnad från historik):
    // läs recordings.speaker_map. Live→sparad (fromHistory=false) hanteras INTE här — ControlBar
    // flushar den live-buffrade datan (pendingSpeakerData i store) vid history-updated, eftersom
    // SplitView kan vara avmonterad när lokal transkribering sparar inspelningen efter stopp.
    useEffect(() => {
        if (!activeJob) { setSpeakerMap({}); setParticipants([]); return; }
        if (!useSyncStore.getState().activeJobFromHistory) return;
        const raw = activeJob.speaker_map;
        if (!raw) { setSpeakerMap({}); setParticipants([]); return; }
        try {
            const parsed = JSON.parse(raw);
            setSpeakerMap(parsed?.map && typeof parsed.map === 'object' ? parsed.map : {});
            setParticipants(Array.isArray(parsed?.participants) ? parsed.participants : []);
        } catch { setSpeakerMap({}); setParticipants([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeJob?.id, activeJob?.speaker_map]);

    // Persistera namnmappning + deltagarlista. SPARAD inspelning (id finns) → skriv direkt till
    // recordings.speaker_map. LIVE (inget id än) → buffra i global store; ControlBar flushar den
    // vid history-updated (alltid monterad → fungerar även när SplitView avmonterats vid flikbyte,
    // vilket händer i lokalt läge där inspelningen sparas asynkront efter stopp).
    const persistSpeakerData = async (map: Record<string, string>, parts: string[]) => {
        const id = activeJob?.id ?? (currentSessionId ? parseInt(currentSessionId) : null);
        if (!id) {
            useSyncStore.getState().setPendingSpeakerData({ map, participants: parts });
            return;
        }
        const payload = JSON.stringify({ map, participants: parts });
        try {
            // camelCase: Rust-param speaker_map → speakerMap i JS-invoke (annars None tyst).
            await invoke("save_speaker_map_to_db", { id, speakerMap: payload });
            useSyncStore.getState().setPendingSpeakerData(null);
            const aj = useSyncStore.getState().activeJob;
            // Bevara fromHistory-flaggan (annars tappas historik-bannern vid namnbyte).
            if (aj && aj.id === id) setActiveJob({ ...aj, speaker_map: payload }, useSyncStore.getState().activeJobFromHistory);
        } catch (e) {
            console.error("Failed to persist speaker map:", e);
        }
    };

    const openRename = (turnIndex: number, sp: string) => {
        const k = speakerKey(sp);
        // "Du" förifyller fältet med e-postens lokaldel (auth-store har bara e-post) — ett
        // förslag som bekräftas med Enter, inte ett auto-applicerat namn.
        const prefill = speakerMap[k] || (k === "DU" && email ? email.split("@")[0] : "");
        setEditingName(prefill);
        setEditingTurnIndex(turnIndex);
    };

    const cancelRename = () => {
        setEditingTurnIndex(null);
        setEditingName("");
    };

    const commitRename = (sp: string) => {
        const k = speakerKey(sp);
        const name = editingName.trim();
        const next = { ...speakerMap };
        if (name) next[k] = name; else delete next[k];
        setSpeakerMap(next);
        persistSpeakerData(next, participants);
        cancelRename();
    };

    const addParticipant = () => {
        const name = newParticipant.trim();
        if (!name || participants.includes(name)) { setNewParticipant(""); return; }
        const next = [...participants, name];
        setParticipants(next);
        persistSpeakerData(speakerMap, next);
        setNewParticipant("");
    };

    const removeParticipant = (name: string) => {
        const next = participants.filter(p => p !== name);
        setParticipants(next);
        persistSpeakerData(speakerMap, next);
    };

    // "Identifiera talare": LLM-förslag som FÖRIFYLLER etiketterna (Pro + online-guard,
    // samma mönster som handleRetranscribe). Användaren korrigerar genom att klicka.
    const handleIdentifySpeakers = async () => {
        if (!isSignedIn || !isPro) { setShowUpsellModal(true); return; }
        if (!navigator.onLine) { toast.error("Denna funktion kräver internetanslutning."); return; }
        const token = getToken();
        if (!token) { toast.error("Kunde inte hämta autentiseringstoken. Logga in igen."); return; }

        // Skicka kanoniska etiketter; hoppa över MOLN (sammanhängande molntext har inga talare).
        const apiTurns: SpeakerTurn[] = turns
            .filter(t => t.speaker !== "MOLN")
            .map(t => ({ speaker: speakerKey(t.speaker), text: t.text, start: t.start_time ?? null }));
        if (apiTurns.length === 0) { toast.error("Inga talarsegment att identifiera."); return; }

        setIsIdentifying(true);
        events.speakersIdentifyRequested();
        try {
            const result = await identifySpeakers(apiTurns, participants, token);
            const suggested = result.speaker_map || {};
            const count = Object.keys(suggested).length;
            if (count === 0) {
                toast.info("Kunde inte härleda namn ur samtalet. Klicka på en etikett för att namnge manuellt.");
            } else {
                const next = { ...speakerMap, ...suggested };
                setSpeakerMap(next);
                persistSpeakerData(next, participants);
                toast.success(`Identifierade ${count} talare. Klicka på ett namn för att ändra.`);
            }
        } catch (error: any) {
            if (error?.message?.startsWith("Unauthorized")) {
                clearSession();
                toast.error("Din session är inte längre giltig. Logga in igen.");
            } else if (error?.message?.includes("Payment Required")) {
                setShowUpsellModal(true);
            } else {
                toast.error("Talaridentifiering misslyckades: " + (error?.message || "Okänt fel"));
            }
        } finally {
            setIsIdentifying(false);
        }
    };

    const handleAction = async () => {
        if (!navigator.onLine) {
            toast.error("Denna funktion kräver internetanslutning.");
            return;
        }

        if (!isSignedIn || !isPro) {
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

                // Synkat moln-jobb → kör om i molnet (job.analysis uppdateras → dashboard matchar
                // desktop). Osynkat/lokalt → stateless analys på den visade texten.
                // OBS: activeJob kan vara null direkt efter stopp (history-updated ej landad) —
                // segmenten finns redan, så analysera texten statelesst i det fallet.
                const raw = (activeJob?.cloud_job_id && useSettingsStore.getState().cloudSync)
                    ? ((await reanalyzeJob(activeJob.cloud_job_id, "general", token)).analysis || {})
                    : await reanalyzeTranscript(fullText, "general", token);

                const mappedAnalysis = {
                    summary: raw.summary || "",
                    decisions: raw.key_decisions || [],
                    actions: raw.action_items || [],
                    template_used: raw.template_used || "general"
                };

                setAnalysisData(mappedAnalysis as AnalysisData);
                events.analysisCompleted();
                // Stop polling so it doesn't overwrite this re-analysis result
                setUploadedJobId(null);

                // Persistens kräver en sparad inspelning — hoppa över tyst om activeJob
                // saknas (analysen visas ändå; sparas när inspelningen öppnas/synkas).
                if (activeJob?.id) {
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
                }
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
            if (activeJob?.audio_deleted) {
                toast.error("Ljudfilen är raderad — molnsynk kräver ljudet. Transkript och analys finns kvar.");
                return;
            }
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

                if (useSettingsStore.getState().cloudSync) {
                    // Synk PÅ → persistera + polla (visas i dashboard)
                    if (targetDbId) {
                        try {
                            await invoke("update_recording_status", {
                                id: targetDbId,
                                status: 'uploaded',
                                cloudJobId: job.id
                            });
                            if (activeJob) {
                                setActiveJob({ ...activeJob, sync_status: 'uploaded', cloud_job_id: job.id });
                            }
                        } catch (e) {
                            console.error("Failed to update DB status:", e);
                        }
                    }
                    setUploadedJobId(job.id);
                } else {
                    // Synk AV (default, privacy-first) → inline-resultat, inget sparas i molnet
                    const wc = await applyInlineCloudResult(job, targetDbId);
                    events.cloudSyncCompleted(wc);
                }
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

            // #14: hämta diariserade DB-segment FÖRST; batch-blobben (cloud_transcript) är
            // bara fallback när inga segment finns — så strömmade inspelningar behåller
            // Du/Mötet-layouten även efter synk.
            invoke<any[]>("get_recording_segments", { recordingId: activeJob.id })
                .then(dbSegments => {
                    const currentActiveJob = useSyncStore.getState().activeJob;
                    if (!currentActiveJob && !uploadedJobId) return;
                    const storeSegs = useTranscriptionStore.getState().segments;
                    const sid = useSyncStore.getState().currentSessionId;
                    const isCurrentSession = !!sid && String(activeJob.id) === sid;
                    if (dbSegments.length > 0) {
                        // #12: DB kan ligga efter live-storen medan sena chunks persisteras —
                        // skriv aldrig över en fylligare live-vy med en partiell DB-lista.
                        if (isCurrentSession && dbSegments.length < storeSegs.length) return;
                        setSegments(dbSegments.map(s => ({
                            ...s,
                            timestamp: s.start_time * 1000
                        })));
                    } else if (isCurrentSession && storeSegs.length > 0) {
                        return; // DB tom men live har text (persist ej klar) — behåll live-vyn
                    } else {
                        // Ingen lokal text för denna inspelning — töm storen så föregående
                        // inspelnings segment inte ligger kvar. Ett ev. molnresultat visas
                        // via cloud_transcript-fallbacken i segments-memon, INTE via storen
                        // (annars tror modellväxlaren att det finns två olika resultat).
                        clearSegments();
                    }
                })
                .catch(err => {
                    console.error("Failed to load segments:", err);
                    if (useTranscriptionStore.getState().segments.length === 0) setSegments([]);
                });
        } else {
            clearSegments();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeJob?.id, activeJob?.cloud_transcript, activeJob?.cloud_segments, setSegments, clearSegments]);

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
                    // Fas 1c: strukturerade DU/MÖTET-turer (stereo) → molnvyn renderar turer i
                    // stället för flat blob. Null för mono (inga talare) → flat blob behålls.
                    const cloudSegmentsJson = cloudSegmentsJsonFromJob(job);
                    if (cloudText) {
                        const wordCount = cloudText.trim().split(/\s+/).filter(Boolean).length;
                        events.cloudSyncCompleted(wordCount);
                    }
                    // Stop polling — prevents future intervals from overwriting re-analysis
                    setUploadedJobId(null);
                    if (cloudText && cloudText.trim()) {
                        // Skriv ALDRIG över lokala/diariserade segment — molnresultatet visas
                        // via modellväxlaren (activeJob.cloud_transcript/cloud_segments). Endast när
                        // inget annat resultat finns OCH molnet saknar strukturerade turer sätts den
                        // flata blobben direkt (batch-only); med turer renderar molnvyn dem via
                        // activeJob.cloud_segments (ingen falsk "lokal"-flik med samma text).
                        if (useTranscriptionStore.getState().segments.length === 0 && !cloudSegmentsJson) {
                            setSegments([{
                                id: -1,
                                start_time: 0,
                                end_time: 0,
                                text: cloudText.trim(),
                                speaker: "MOLN", // Special marker: cloud-sourced
                                timestamp: Date.now(),
                            }]);
                        }
                        setTranscriptView('cloud');
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
                            // Persistera molnresultatet i sqlite — överlever omstart och
                            // gör att modellväxlaren fungerar när inspelningen återöppnas.
                            if (cloudText && cloudText.trim()) {
                                await invoke("save_cloud_transcript_to_db", {
                                    id: currentActiveJob.id,
                                    transcript: cloudText.trim(),
                                });
                            }
                            // Skriv ALLTID cloud_segments (tom sträng = rensa) så DB och
                            // in-memory aldrig divergerar — annars skulle en stereo→mono-
                            // omtranskribering lämna kvar gamla turer i DB medan activeJob
                            // nollställs → stale turer vid återöppning.
                            await invoke("save_cloud_segments_to_db", {
                                id: currentActiveJob.id,
                                cloudSegments: cloudSegmentsJson || "",
                            });

                            // Persist cloud_transcript + cloud_segments so segments survive tab switches
                            const updatedJob = {
                                ...currentActiveJob,
                                analysis_json: JSON.stringify(completedAnalysis),
                                cloud_transcript: cloudText || null,
                                cloud_segments: cloudSegmentsJson,
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
        <div className="grid grid-cols-5 h-full overflow-hidden bg-paper-dim/50">
            {/* Left: Live Transcription (60% -> 3/5 cols) */}
            <div className="col-span-3 flex flex-col h-full overflow-hidden min-w-0 bg-white border-r border-line/60 shadow-[4px_0_24px_-12px_rgba(0,0,0,0.1)] z-10 relative">
                <div className="px-8 py-6 flex-none flex justify-between items-center bg-white border-b border-line z-50">
                    <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2.5 text-ink">
                        <div className="p-1.5 bg-brand/5 rounded-lg text-brand">
                            <FileText className="w-4 h-4" />
                        </div>
                        Transkription
                        {segments.length > 0 && (
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-ink-muted hover:text-ink-soft ml-1 rounded-full"
                                onClick={(e) => handleCopy(buildCopyText(), "transcript", e)}
                                title="Kopiera transkription"
                            >
                                {copiedKey === "transcript" ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                            </Button>
                        )}
                        {/* Re-transcribe with Large — shown when cloud mode is selected, not currently recording/processing.
                            Döljs när ljudfilen är gallrad (auto-gallring) — uppladdningen kräver WAV:en. */}
                        {segments.length > 0 && !isRecording && !uploadedJobId && !isRetranscribing &&
                         !activeJob?.audio_deleted &&
                         (recordingMode === 'cloud' || recordingMode === 'cloud_analysis') && (
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-ink-muted hover:text-brand hover:bg-brand/5 ml-0.5 rounded-full"
                                onClick={handleRetranscribe}
                                title={segments.some(s => s.speaker === 'MOLN') ? "Transkribera om med KB-Whisper Large" : "Transkribera med KB-Whisper Large"}
                            >
                                {segments.some(s => s.speaker === 'MOLN')
                                    ? <RefreshCw className="h-3.5 w-3.5" />
                                    : <Cloud className="h-3.5 w-3.5" />
                                }
                            </Button>
                        )}
                        {/* Identifiera talare (Fas 1) — namnsätter Du/Mötet via LLM. Visas bara
                            när det finns talaretiketter att namnge, inte under inspelning.
                            Pro/online-guard hanteras i handlern (samma mönster som omtranskribera). */}
                        {segments.length > 0 && !isRecording && hasNamableSpeakers && (
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-ink-muted hover:text-brand hover:bg-brand/5 ml-0.5 rounded-full"
                                onClick={handleIdentifySpeakers}
                                disabled={isIdentifying}
                                title={isPro ? "Identifiera talare — namnsätt Du/Mötet" : "Identifiera talare (Pro)"}
                            >
                                {isIdentifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Users className="h-3.5 w-3.5" />}
                            </Button>
                        )}
                    </h2>
                    <div className="flex items-center gap-3">
                        <ModePill onUpsellClick={() => setShowUpsellModal(true)} />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto min-h-0 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-line [&::-webkit-scrollbar-thumb]:rounded-full">
                    <div className="p-8 pt-4 max-w-3xl mx-auto space-y-8">
                        {/* History Banner — only shown when user explicitly opened a recording from history */}
                        {activeJob && activeJobFromHistory && (
                            <div className="bg-paper-dim border border-line rounded-lg px-4 py-2.5 flex items-center justify-between animate-in fade-in slide-in-from-top-2">
                                <div className="flex items-center gap-2 text-ink-soft">
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
                                    className="text-xs text-ink-muted hover:text-ink-soft transition-colors ml-4"
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

                        {/* Modellväxlare — visas när inspelningen har resultat från BÅDA
                            modellerna (lokala segment + KB-Whisper Large) så användaren kan
                            jämföra och se värdet av Pro. */}
                        {hasModelToggle && (
                            <div className="flex items-center gap-1.5">
                                <button
                                    onClick={() => setTranscriptView('local')}
                                    className={`text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-md border transition-colors ${
                                        transcriptView === 'local'
                                            ? 'bg-paper-dim text-ink-soft border-line'
                                            : 'bg-transparent text-ink-muted border-transparent hover:text-ink-soft'
                                    }`}
                                >
                                    🖥 Lokal
                                </button>
                                <button
                                    onClick={() => setTranscriptView('cloud')}
                                    className={`text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-md border transition-colors ${
                                        transcriptView === 'cloud'
                                            ? 'bg-brand/5 text-brand border-brand/10'
                                            : 'bg-transparent text-ink-muted border-transparent hover:text-brand'
                                    }`}
                                >
                                    ☁ KB-Whisper Large
                                </button>
                            </div>
                        )}

                        {!activeJob && segments.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-[50vh] text-center space-y-4 animate-in fade-in duration-1000">
                                <>
                                        <div className={`p-4 rounded-full bg-paper-dim ${isRecording ? "opacity-100" : "opacity-40"}`}>
                                            <Sparkles className={`w-8 h-8 ${isRecording ? "text-red-400 animate-pulse" : "text-ink-muted"}`} />
                                        </div>
                                        <div className={`space-y-1 ${isRecording ? "opacity-100" : "opacity-40"}`}>
                                            <p className="text-ink font-medium">
                                                {isRecording
                                                    ? (cloudStreamingActive ? "🔴 Lyssnar — transkriberar i molnet..." : "🔴 Lyssnar — transkriberar lokalt...")
                                                    : "Redo för mötet"}
                                            </p>
                                            <p className="text-sm text-ink-muted max-w-xs mx-auto">
                                                {isRecording
                                                    ? "Texten visas här om en liten stund."
                                                    : "Starta inspelningen för att se transkribering i realtid."}
                                            </p>
                                        </div>
                                    </>
                            </div>
                        ) : isMerged ? (
                            // Sammanhängande (1×): ett flöde, styckesbryt vid pauser
                            <div className="space-y-4 animate-in fade-in duration-500">
                                {/* Badge redundant när modellväxlaren redan visar källan */}
                                {!hasModelToggle && (
                                    <span className="inline-block text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-md bg-brand/5 text-brand border border-brand/10">
                                        ☁ KB-Whisper Large
                                    </span>
                                )}
                                {mergedParagraphs.map((para, i) => (
                                    <p key={i} className="leading-relaxed text-[15px] pl-1 border-l-2 border-brand/20 text-ink">
                                        {para}
                                    </p>
                                ))}
                            </div>
                        ) : (
                            <div className="space-y-0">
                                {showLocalFallbackBadge && (
                                    <span className="inline-block text-[10px] font-medium px-2 py-0.5 rounded-md bg-paper-dim text-ink-muted border border-line mb-3">
                                        🖥 Lokalt (molnet ej tillgängligt)
                                    </span>
                                )}
                                {/* Click-outside: stänger en öppen namnbyte-popover. z under popovern (z-50). */}
                                {editingTurnIndex !== null && (
                                    <div className="fixed inset-0 z-40" onClick={cancelRename} />
                                )}
                                {/* Deltagar-chips (frivilligt) — "Vilka är med?". Skickas som
                                    participant_hints vid identifiering + snabbval i namnbyte-popovern. */}
                                {hasNamableSpeakers && (
                                    <div className="flex flex-wrap items-center gap-1.5 mb-4 pb-3 border-b border-line/60">
                                        <Users className="w-3.5 h-3.5 text-ink-muted mr-0.5" />
                                        <span className="text-xs text-ink-muted mr-1">Vilka är med?</span>
                                        {participants.map((p) => (
                                            <span key={p} className="inline-flex items-center gap-1 text-xs bg-brand/5 text-brand border border-brand/10 rounded-full pl-2.5 pr-1 py-0.5">
                                                {p}
                                                <button onClick={() => removeParticipant(p)} className="hover:bg-brand/10 rounded-full p-0.5" title="Ta bort">
                                                    <X className="w-2.5 h-2.5" />
                                                </button>
                                            </span>
                                        ))}
                                        <input
                                            value={newParticipant}
                                            onChange={(e) => setNewParticipant(e.target.value)}
                                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addParticipant(); } }}
                                            onBlur={addParticipant}
                                            placeholder="Lägg till namn…"
                                            className="text-xs bg-transparent border-b border-dashed border-line focus:border-brand outline-none px-1 py-0.5 w-28 text-ink placeholder:text-ink-muted/60"
                                        />
                                    </div>
                                )}
                                {turns.map((turn, index, arr) => {
                                    // Pausbryt: extra luft när gapet till föregående tur ≥ pauseBreakMs.
                                    const prev = arr[index - 1];
                                    const pauseBreak = !!prev && (turn.start_time - prev.end_time) * 1000 >= pauseBreakMs;
                                    const isDu = turn.speaker === "DU" || turn.speaker === "mic";
                                    const isMoln = turn.speaker === "MOLN";
                                    const isEditing = editingTurnIndex === index;
                                    return (
                                        <p
                                            key={index}
                                            className={`leading-relaxed text-[15px] animate-in fade-in slide-in-from-bottom-1 duration-500 fill-mode-backwards ${pauseBreak ? 'mt-5' : 'mt-1.5'}`}
                                        >
                                            {!isMoln && (
                                                <span className="relative inline-block">
                                                    <button
                                                        type="button"
                                                        onClick={() => openRename(index, turn.speaker)}
                                                        className={`font-semibold rounded hover:underline decoration-dotted underline-offset-2 transition-colors ${isDu ? "text-brand" : "text-rose-600"}`}
                                                        title="Klicka för att namnge talaren"
                                                    >
                                                        {speakerLabel(turn.speaker)}:
                                                    </button>
                                                    {/* Namnbyte-popover (span-only inuti <p>; div är ogiltigt i p) */}
                                                    {isEditing && (
                                                        <span className="absolute left-0 top-full mt-1 z-50 flex flex-col gap-2 bg-white border border-line rounded-lg shadow-lg p-3 w-64 font-normal normal-case text-left">
                                                            <input
                                                                autoFocus
                                                                value={editingName}
                                                                onChange={(e) => setEditingName(e.target.value)}
                                                                onKeyDown={(e) => {
                                                                    if (e.key === 'Enter') { e.preventDefault(); commitRename(turn.speaker); }
                                                                    if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                                                                }}
                                                                placeholder={`Namn för "${defaultLabel(turn.speaker)}"`}
                                                                className="text-sm border border-line rounded-md px-2 py-1 outline-none focus:border-brand text-ink"
                                                            />
                                                            {participants.length > 0 && (
                                                                <span className="flex flex-wrap gap-1">
                                                                    {participants.map((p) => (
                                                                        <button
                                                                            key={p}
                                                                            type="button"
                                                                            onClick={() => setEditingName(p)}
                                                                            className="text-xs bg-paper-dim hover:bg-brand/10 text-ink-soft hover:text-brand border border-line rounded-full px-2 py-0.5"
                                                                        >
                                                                            {p}
                                                                        </button>
                                                                    ))}
                                                                </span>
                                                            )}
                                                            <span className="flex items-center justify-end gap-2">
                                                                <button type="button" onClick={cancelRename} className="text-xs text-ink-muted hover:text-ink-soft px-2 py-1">Avbryt</button>
                                                                <button type="button" onClick={() => commitRename(turn.speaker)} className="text-xs font-medium bg-brand text-paper rounded-md px-3 py-1 hover:bg-brand-deep">Spara</button>
                                                            </span>
                                                        </span>
                                                    )}
                                                </span>
                                            )}
                                            {!isMoln && " "}
                                            <span className="text-ink-soft">{turn.text}</span>
                                        </p>
                                    );
                                })}
                            </div>
                        )}
                        {/* Live Listening Indicator — shown at bottom of existing segments during recording */}
                        {isRecording && segments.length > 0 && (
                            <div className="flex items-center gap-2 pl-1 mt-2">
                                <span className="relative flex h-2 w-2">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                                </span>
                                <span className="text-xs text-ink-muted">Lyssnar...</span>
                            </div>
                        )}
                        {/* Cloud Processing Indicator — shown while polling for Berget result */}
                        {!activeJob && !isRecording && processingStatus === 'PROCESSING' && (
                            <div className="flex items-center gap-2 pl-1 mt-2">
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" />
                                <span className="text-xs text-brand font-medium">{getStatusText()}</span>
                            </div>
                        )}
                        {/* GDPR 24h-notice — visas när cloud-synk slutförts */}
                        {!isRecording && processingStatus === 'COMPLETED' && activeJob?.cloud_job_id && (
                            <span className="text-[10px] text-ink-muted pl-1 mt-1 block">
                                ℹ Ljud raderas automatiskt om 24 h (GDPR)
                            </span>
                        )}
                        {/* Local Finalizing Indicator */}
                        {/* #11: gata INTE på !activeJob — activeJob sätts direkt vid stopp medan
                            moln-kön fortfarande processar; indikatorn + Avbryt ska lysa tills klart. */}
                        {isProcessing && !isRecording && processingStatus !== 'PROCESSING' && (
                            <div className="flex flex-col gap-3 animate-pulse pl-1 mt-4">
                                <div className="flex items-center gap-2">
                                    <Loader2 className="w-4 h-4 animate-spin text-brand" />
                                    <span className="text-xs font-medium text-brand">Slutför transkribering... vänta</span>
                                </div>
                                <div>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleCancel}
                                        className="text-xs text-ink-muted hover:text-red-600"
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
            <div className="col-span-2 flex flex-col h-full overflow-hidden bg-paper/60 relative">
                <div className="px-8 py-6 flex-none bg-paper/60 border-b border-line z-50 flex justify-between items-center">
                    <h2 className="text-lg font-medium tracking-tight flex items-center gap-2 text-ink-soft">
                        <Sparkles className="w-4 h-4 text-ochre" />
                        <span className="text-[11px] font-semibold uppercase tracking-widest text-ochre">Protokoll</span>
                    </h2>

                    {/* User button */}
                    {isSignedIn && (
                        <div className="relative" ref={userMenuRef}>
                            <button
                                onClick={() => setShowUserMenu((v) => !v)}
                                className="w-8 h-8 rounded-full bg-brand text-paper text-xs font-semibold flex items-center justify-center hover:bg-brand-deep transition-colors focus:outline-none focus:ring-2 focus:ring-brand/40 focus:ring-offset-2"
                                title={email || "Konto"}
                            >
                                {initials}
                            </button>
                            {showUserMenu && (
                                <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl shadow-lg border border-line py-2 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                                    <div className="px-4 py-2 border-b border-line">
                                        <p className="text-sm font-medium text-ink truncate">{email}</p>
                                        <p className="text-xs text-ink-muted mt-0.5">{isPro ? "Sagt Pro" : "Free"}</p>
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

                <div className="flex-1 flex flex-col gap-4 p-8 pt-4 overflow-y-auto min-h-0 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-line [&::-webkit-scrollbar-thumb]:rounded-full">
                        {/* Summary Section */}
                        {(analysisData || uploadedJobId || (isSignedIn && isPro)) && (
                            <Card className="border border-brand/10 shadow-sm bg-white/80 p-6 space-y-4 relative overflow-hidden flex-none">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <h3 className="font-semibold text-xs text-ink uppercase tracking-widest opacity-70">Sammanfattning</h3>
                                    {analysisData?.summary && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-5 w-5 text-brand/60 hover:text-brand hover:bg-brand/5 rounded-full"
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
                                      className="h-6 w-6 text-ink-muted hover:text-brand hover:bg-brand/5 rounded-full"
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
                                        <div className="absolute inset-0 bg-brand/20 rounded-full animate-ping opacity-25"></div>
                                        <div className="relative w-12 h-12 bg-brand/10 rounded-full flex items-center justify-center text-brand">
                                            <Loader2 className="w-6 h-6 animate-spin" />
                                        </div>
                                    </div>
                                    <div className="text-center space-y-1">
                                        <h3 className="text-sm font-medium text-ink">Uppdaterar analys...</h3>
                                        <p className="text-xs text-ink-muted animate-pulse">
                                            Analyserar kontext, beslut och åtgärder...
                                        </p>
                                    </div>
                                </div>
                            ) : analysisData ? (
                                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
                                    <div className="prose prose-sm prose-slate max-w-none">
                                        <p className="text-sm text-ink-soft leading-relaxed bg-white p-3 rounded-lg border border-line shadow-sm">
                                            {analysisData.summary || "Ingen sammanfattning tillgänglig."}
                                        </p>
                                    </div>

                                    {/* Decisions Block */}
                                    <div className="space-y-2 mt-4">
                                        <div className="flex items-center gap-2">
                                            <h4 className="text-xs font-semibold text-ink uppercase tracking-wide flex items-center gap-1.5">
                                                <div className="w-1.5 h-1.5 rounded-full bg-verified"></div>
                                                Beslut
                                            </h4>
                                            {analysisData.decisions && analysisData.decisions.length > 0 && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-5 w-5 text-ink-muted hover:text-ink-soft hover:bg-paper-dim rounded-full"
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
                                                    <li key={i} className="text-xs text-ink-soft bg-verified/[0.04] p-2 rounded border border-verified/10 flex gap-2 items-start">
                                                        <span className="text-verified font-bold">•</span>
                                                        {decision}
                                                    </li>
                                                ))}
                                            </ul>
                                        ) : (
                                            <p className="text-xs text-ink-muted italic">Inga beslut identifierade.</p>
                                        )}
                                    </div>

                                    {/* Actions Block */}
                                    <div className="space-y-2 mt-4">
                                        <div className="flex items-center gap-2">
                                            <h4 className="text-xs font-semibold text-ink uppercase tracking-wide flex items-center gap-1.5">
                                                <div className="w-1.5 h-1.5 rounded-full bg-brand"></div>
                                                Åtgärder
                                            </h4>
                                            {analysisData.actions && analysisData.actions.length > 0 && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-5 w-5 text-ink-muted hover:text-ink-soft hover:bg-paper-dim rounded-full"
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
                                                    <li key={i} className="text-xs text-ink-soft bg-brand/[0.03] p-2 rounded border border-brand/10 flex gap-2 items-start">
                                                        <div className="w-3 h-3 rounded border border-brand/20 mt-0.5 flex-shrink-0"></div>
                                                        {action}
                                                    </li>
                                                ))}
                                            </ul>
                                        ) : (
                                            <p className="text-xs text-ink-muted italic">Inga åtgärder identifierade.</p>
                                        )}
                                    </div>
                                </div>
                            ) : uploadedJobId ? (
                                <div className="flex flex-col items-center justify-center p-8 space-y-4 animate-in fade-in zoom-in-95 duration-500">
                                    <div className="relative">
                                        <div className="absolute inset-0 bg-brand/20 rounded-full animate-ping opacity-25"></div>
                                        <div className="relative w-12 h-12 bg-brand/10 rounded-full flex items-center justify-center text-brand">
                                            <Sparkles className="w-6 h-6 animate-pulse" />
                                        </div>
                                    </div>
                                    <div className="text-center space-y-1">
                                        <h3 className="text-sm font-medium text-ink">{getStatusText()}</h3>
                                        <p className="text-xs text-ink-muted">
                                            Analyserar kontext, beslut och åtgärder.
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div className="space-y-3 opacity-50">
                                        <div className="h-2 bg-paper-dim rounded w-3/4"></div>
                                        <div className="h-2 bg-paper-dim rounded w-full"></div>
                                        <div className="h-2 bg-paper-dim rounded w-5/6"></div>
                                    </div>
                                    {/* #15: samma stil + copy-logik som vänstra panelens statustext (ej kursiv). */}
                                    <p className="text-sm text-ink-muted pt-2 text-center">
                                        {isRecording
                                            ? (cloudStreamingActive ? "Transkriberar i molnet..." : "Transkriberar lokalt...")
                                            : "Starta inspelningen för att se transkribering i realtid."}
                                    </p>
                                </>
                            )}
                        </Card>
                        )}

                        {/* Skeleton — syns genom blur-overlay för ej Pro-användare */}
                        {(!isSignedIn || !isPro) && (
                            <div className="space-y-5 pointer-events-none select-none" aria-hidden="true">

                                {/* Sammanfattning */}
                                <div className="space-y-2">
                                    <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-widest">Sammanfattning</p>
                                    <div className="space-y-1.5">
                                        <div className="h-2 bg-paper-dim rounded-full w-full" />
                                        <div className="h-2 bg-paper-dim rounded-full w-5/6" />
                                        <div className="h-2 bg-paper-dim rounded-full w-4/6" />
                                    </div>
                                </div>

                                {/* Beslut */}
                                <div className="space-y-2">
                                    <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-widest">Beslut</p>
                                    <div className="space-y-2">
                                        <div className="flex items-start gap-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-paper-dim mt-1.5 flex-shrink-0" />
                                            <div className="h-2 bg-paper-dim rounded-full w-4/5" />
                                        </div>
                                        <div className="flex items-start gap-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-paper-dim mt-1.5 flex-shrink-0" />
                                            <div className="h-2 bg-paper-dim rounded-full w-3/5" />
                                        </div>
                                    </div>
                                </div>

                                {/* Åtgärder */}
                                <div className="space-y-2">
                                    <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-widest">Åtgärder</p>
                                    <div className="space-y-2">
                                        <div className="flex items-start gap-2">
                                            <div className="w-3 h-3 rounded border border-line mt-0.5 flex-shrink-0" />
                                            <div className="h-2 bg-paper-dim rounded-full w-full" />
                                        </div>
                                        <div className="flex items-start gap-2">
                                            <div className="w-3 h-3 rounded border border-line mt-0.5 flex-shrink-0" />
                                            <div className="h-2 bg-paper-dim rounded-full w-5/6" />
                                        </div>
                                        <div className="flex items-start gap-2">
                                            <div className="w-3 h-3 rounded border border-line mt-0.5 flex-shrink-0" />
                                            <div className="h-2 bg-paper-dim rounded-full w-3/4" />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                </div>

                {/* Lock overlay — täcker hela höger kolonn inklusive "Protokoll"-rubrik, exakt som hero-mockupen */}
                {(!isSignedIn || !isPro) && (
                    <div className="absolute inset-0 z-[51] bg-white/55 backdrop-blur-[2px] grid place-items-center pointer-events-none">
                        <div className="pointer-events-auto">
                            {isPaymentWaiting ? (
                                <div className="flex flex-col items-center gap-2">
                                    <div className="inline-flex items-center gap-2 rounded-full bg-ink text-paper text-xs font-semibold px-4 py-2 shadow-md">
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        Väntar på betalning...
                                    </div>
                                    <button
                                        onClick={stopPaymentPolling}
                                        className="text-xs text-ink-muted hover:text-ink-soft transition-colors"
                                    >
                                        Avbryt
                                    </button>
                                </div>
                            ) : (
                                <button
                                    onClick={() => setShowUpsellModal(true)}
                                    className="inline-flex items-center gap-2 rounded-full bg-ink text-paper text-xs font-semibold px-4 py-2 hover:bg-ink/90 transition-colors shadow-md"
                                >
                                    <Lock className="w-3.5 h-3.5" />
                                    Lås upp med Pro
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div >

            <UpsellModal
                isOpen={showUpsellModal} 
                onClose={() => setShowUpsellModal(false)} 
            />
        </div >
    );
}
