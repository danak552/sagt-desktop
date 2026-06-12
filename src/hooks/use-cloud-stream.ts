import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useTranscriptionStore, UISegment } from "@/store/transcription-store";
import { useAuthStore } from "@/store/auth-store";
import { useSyncStore } from "@/store/sync-store";
import { transcribeChunk } from "@/lib/api";
import { toast } from "sonner";
import posthog from "posthog-js";

// Matchar Rust `CloudChunk` (serde) — audio är WAV-bytes som number[].
interface CloudChunkEvent {
    audio: number[];
    speaker: string;  // "DU" | "MÖTET" | "MOLN"
    start: number;    // sekunder
    duration: number; // segmentlängd i sekunder → end_time = start + duration
}

// Begränsa samtidiga moln-POST så vi inte översvämmar Berget vid snabb segmentering.
const MAX_CONCURRENT = 3;

// Modulnivå-tillstånd — useCloudStream monteras EN gång i App.tsx (singleton), så detta är
// säkert och låter control-bar/split-view styra kön (vänta/avbryt) utan prop-trådning.
let queue: CloudChunkEvent[] = [];
let pending = 0;
let cancelRequested = false;
let wasBusy = false;
let errored = false;

export function cloudStreamBusy(): boolean {
    return pending > 0 || queue.length > 0;
}

export async function waitForCloudStreamIdle(timeoutMs = 60000): Promise<void> {
    const start = Date.now();
    while (cloudStreamBusy() && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 150));
    }
}

// #11: Avbryt ska bita på moln-kön — töm den, släpp in inga fler chunks och släck "Bearbetar".
export function cancelCloudStream() {
    cancelRequested = true;
    queue = [];
    wasBusy = false;
    useTranscriptionStore.getState().setIsProcessing(false);
}

// Nollställs vid varje inspelningsstart (control-bar) så en ny session inte ärver avbrottet.
export function resetCloudStream() {
    cancelRequested = false;
    queue = [];
    wasBusy = false;
    errored = false;
}

// #12: persistera hela segment-storen till DB. Körs vid varje äkta kö-dränering post-stop så
// eftersläpande chunks alltid fångas — annars sparas bara det som hunnit in vid control-bars
// timeout, och ett flikbyte (SplitView remount) läser då tillbaka en halv transkribering.
async function persistSegments() {
    const sid = useSyncStore.getState().currentSessionId;
    if (!sid) return;
    const segs = useTranscriptionStore.getState().segments;
    if (segs.length === 0) return;
    try {
        await invoke("update_recording_segments", {
            recordingId: parseInt(sid, 10),
            segments: segs.map((s) => ({
                start_time: s.start_time,
                end_time: s.end_time,
                text: s.text,
                speaker: s.speaker,
            })),
        });
    } catch (e) {
        console.error("persistSegments failed:", e);
    }
}

// #7: Lead-in:en (#5B) kan transkriberas i både chunk N och N+1 → sista orden i ett stycke
// blir samma som första i nästa. Trimma nya segmentets ledande ord som dubblerar föregående
// (samma talare) segments avslutande ord. Skiftläges-/skiljeteckensokänslig, ≥2 ord.
function stripOverlap(prevText: string, newText: string): string {
    const norm = (w: string) => w.toLowerCase().replace(/[.,!?;:]/g, "");
    const prev = prevText.trim().split(/\s+/).filter(Boolean);
    const next = newText.trim().split(/\s+/).filter(Boolean);
    if (prev.length === 0 || next.length === 0) return newText;
    const maxOverlap = Math.min(6, prev.length, next.length);
    for (let k = maxOverlap; k >= 2; k--) {
        const tail = prev.slice(prev.length - k).map(norm).join(" ");
        const head = next.slice(0, k).map(norm).join(" ");
        if (tail === head) return next.slice(k).join(" ");
    }
    return newText;
}

/**
 * Lyssnar på Rust `cloud-chunk-ready` (PRO live-molnströmning), POSTar varje VAD-segment
 * till /transcribe-chunk och matar in resultatet i transcription-store med talar-tag.
 * Äger även "Bearbetar…"-statusen post-stop (#11) och persisterar vid dränering (#12).
 */
export function useCloudStream() {
    useEffect(() => {
        let active = true;
        queue = [];
        pending = 0;
        cancelRequested = false;
        wasBusy = false;
        errored = false;

        const handleChunk = async (chunk: CloudChunkEvent, attempt: number): Promise<void> => {
            try {
                const token = useAuthStore.getState().getToken();
                if (!token) throw new Error("Ingen autentiseringstoken");
                const limit = useAuthStore.getState().monthlyMinutesLimit;
                const res = await transcribeChunk(chunk.audio, chunk.speaker, chunk.start, token, limit);
                if (cancelRequested) return; // #11: avbrutet medan POST var i luften — släng resultatet
                const text = (res.text || "").trim();
                if (text) {
                    const store = useTranscriptionStore.getState();
                    let prevSame: UISegment | undefined;
                    for (let i = store.segments.length - 1; i >= 0; i--) {
                        if (store.segments[i].speaker === chunk.speaker) { prevSame = store.segments[i]; break; }
                    }
                    const deduped = (prevSame ? stripOverlap(prevSame.text, text) : text).trim();
                    if (deduped) {
                        store.addSegment({
                            text: deduped,
                            start_time: chunk.start,
                            end_time: chunk.start + chunk.duration,
                            timestamp: chunk.start * 1000,
                            speaker: chunk.speaker,
                        });
                    }
                    posthog?.capture?.("cloud_chunk_ok", { speaker: chunk.speaker });
                    errored = false; // #8 re-arm: lyckad chunk → tillåt ny felnotis senare
                } else {
                    posthog?.capture?.("cloud_chunk_empty", { speaker: chunk.speaker });
                }
            } catch (e: any) {
                const msg = String(e?.message || e);
                // #8 retry en gång vid transient fel (ej auth/quota/payment).
                if (attempt === 0 && !/Payment Required|Quota|autentisering/i.test(msg)) {
                    await new Promise((r) => setTimeout(r, 400));
                    return handleChunk(chunk, 1);
                }
                console.error("Cloud chunk failed:", msg);
                posthog?.capture?.("cloud_chunk_error", { speaker: chunk.speaker, message: msg.slice(0, 140) });
                if (!errored) {
                    errored = true;
                    if (msg.includes("Payment Required")) toast.error("Molntranskribering kräver aktiv Pro-prenumeration.");
                    else if (msg.includes("Quota")) toast.error("Månadsgränsen för molntranskribering är nådd.");
                    else toast.error("Molntranskribering avbröts (nätverk/server). Försöker igen automatiskt.", { duration: 6000 });
                }
            }
        };

        // Körs efter varje avslutad chunk: när kön är ÄKTA tom post-stop → persistera (#12)
        // och släck "Bearbetar…" (#11). wasBusy gör att den bara fyrar en gång per dränering.
        const onMaybeDrained = () => {
            if (cloudStreamBusy()) return;
            if (!wasBusy) return;
            wasBusy = false;
            if (useSyncStore.getState().isRecording) return;
            void persistSegments().finally(() => {
                useTranscriptionStore.getState().setIsProcessing(false);
            });
        };

        const pump = () => {
            while (active && !cancelRequested && pending < MAX_CONCURRENT && queue.length > 0) {
                const chunk = queue.shift()!;
                pending++;
                wasBusy = true;
                void (async () => {
                    await handleChunk(chunk, 0);
                    pending--;
                    pump();
                    onMaybeDrained();
                })();
            }
        };

        const unlistenPromise = listen<CloudChunkEvent>("cloud-chunk-ready", (event) => {
            if (cancelRequested) return; // #11: avbrutet — släng eftersläpande chunks
            queue.push(event.payload);
            wasBusy = true;
            // #11: chunks som anländer/processas efter stopp → håll "Bearbetar…" tänd tills dränerat.
            if (!useSyncStore.getState().isRecording) {
                useTranscriptionStore.getState().setIsProcessing(true);
            }
            pump();
        });

        return () => {
            active = false;
            queue = [];
            pending = 0;
            wasBusy = false;
            errored = false;
            unlistenPromise.then((f) => f());
        };
    }, []);
}
