import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranscriptionStore, UISegment } from "@/store/transcription-store";
import { toast } from "sonner";
import posthog from "posthog-js";

const posthogEnabled = !!import.meta.env.VITE_POSTHOG_KEY;

interface TranscriptionEvent {
    text: string;
    source: string;
    start?: number;
    end?: number;
}

export function useTranscription() {
    const { addSegment, setIsProcessing } = useTranscriptionStore();

    useEffect(() => {
        const unlistenChunkPromise = listen<TranscriptionEvent>("transcription-chunk", (event) => {
            const { text, source } = event.payload;

            // Map source "mic" -> "DU", "sys" -> "MÖTET" if backend sends raw tags
            // Backend sends "DU" or "MÖTET" in process_audio_stream.

            const newSegment: UISegment = {
                text,
                start_time: event.payload.start || (Date.now() / 1000), // Seconds
                end_time: event.payload.end || (Date.now() / 1000), // Seconds
                timestamp: Date.now(), // Milliseconds for UI key/display
                speaker: source
            };

            addSegment(newSegment);
            // isProcessing styrs enbart av transcription-status-eventet (idle/processing).
            // Att sätta false här fick "Avbryt"-knappen att försvinna mitt i pågående
            // transkribering när beam-size 1 levererar chunks snabbt.
        });

        const unlistenStatusPromise = listen<string>("transcription-status", (event) => {
            console.log("React: Status update", event.payload);
            setIsProcessing(event.payload === "processing");
            if (event.payload === "idle" && posthogEnabled) {
                const segs = useTranscriptionStore.getState().segments
                if (segs.length > 0) {
                    const wordCount = segs.reduce((n, s) => n + s.text.split(' ').length, 0)
                    posthog.capture('transcription_completed', { word_count: wordCount })
                }
            }
        });

        const unlistenErrorPromise = listen<string>("transcription-error", (event) => {
            console.error("React: Transcription Error", event.payload);
            toast.error(event.payload, {
                duration: 6000,
            });
            setIsProcessing(false);
        });

        return () => {
            unlistenChunkPromise.then((unlisten) => unlisten());
            unlistenStatusPromise.then((unlisten) => unlisten());
            unlistenErrorPromise.then((unlisten) => unlisten());
        };
    }, []);

    // Return nothing, or return store values if needed for backward compat?
    // Consumers should use useTranscriptionStore() directly.
    // But SplitView uses: const { segments, isProcessing } = useTranscription();
    // So let's return from store here to minimize refactor in SplitView for now.

    // We can't use hooks conditionally, but we can call the store hook here.
    const segments = useTranscriptionStore(state => state.segments);
    const isProcessing = useTranscriptionStore(state => state.isProcessing);

    return { segments, isProcessing };
}
