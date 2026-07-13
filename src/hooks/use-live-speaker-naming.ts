import { useEffect, useRef } from "react";
import { useSyncStore } from "@/store/sync-store";
import { useSettingsStore } from "@/store/settings-store";
import { useAuthStore } from "@/store/auth-store";
import { useTranscriptionStore } from "@/store/transcription-store";
import { autoIdentify, buildTurnsFromSegments, mergeSuggestions } from "@/lib/speaker-naming";
import { captureEvent } from "@/hooks/use-posthog-events";

// STEG 2 — live auto-namngivning under pågående inspelning.
//
// Loopen MÅSTE bo i en alltid-monterad hook (monteras en gång i App.tsx, som useCloudStream):
// SplitView avmonteras vid flikbyte och kan därför inte äga en periodisk loop. Sanningskällan
// för namn under live ligger i sync-store (liveSpeakerMap/liveAutoKeys), som SplitView läser.
//
// Trigger (ALLA krävs): molnläge (cloudStreamingActive) + structured + Pro + online + inspelning
// pågår. Aldrig i lokal-läge (integritetslöftet). Tyst: fel sväljs, inga toaster.

const THROTTLE_MS = 90_000;

export function useLiveSpeakerNaming() {
    // Signatur av senast bearbetade segment — hoppa om inget nytt talats sedan förra körningen.
    const lastSignatureRef = useRef<string>("");
    // In-flight-guard: ett anrop i taget (undviker överlappande /identify-speakers-anrop).
    const runningRef = useRef(false);

    useEffect(() => {
        const tick = async () => {
            if (runningRef.current) return;

            const sync = useSyncStore.getState();
            const settings = useSettingsStore.getState();
            const auth = useAuthStore.getState();

            // Gate — läs allt färskt. Villkoret för ALL automatik: molnläge + structured + Pro + online.
            if (!sync.isRecording) return;
            if (!sync.cloudStreamingActive) return;
            if (!auth.isPro()) return;
            if (!navigator.onLine) return;
            if (settings.cloudDiarizationMode !== "structured") return;

            const segments = useTranscriptionStore.getState().segments;
            const turns = buildTurnsFromSegments(segments);
            if (turns.length === 0) return;

            // Kör bara om nya turer/text tillkommit sedan förra körningen (spara anrop + pengar).
            const signature = `${turns.length}:${turns.reduce((n, t) => n + t.text.length, 0)}`;
            if (signature === lastSignatureRef.current) return;

            // Vila när alla talarnycklar redan är ANVÄNDARSATTA (inget kvar att auto-namnge):
            // en nyckel är "arbete" om den saknas i map:en ELLER är auto-satt (får förfinas).
            const base = sync.liveSpeakerMap;
            const autoKeys = sync.liveAutoKeys;
            const keys = Array.from(new Set(turns.map((t) => t.speaker)));
            const hasWork = keys.some((k) => !(k in base) || autoKeys.includes(k));
            if (!hasWork) { lastSignatureRef.current = signature; return; }

            const token = auth.getToken();
            if (!token) return;

            runningRef.current = true;
            try {
                // participantHints [] i v1: deltagarlistan är SplitView-lokal och hint är valfri
                // för LLM:en — inte värt en egen store-nyckel bara för live-loopen.
                const suggested = await autoIdentify(segments, [], token);
                lastSignatureRef.current = signature;
                if (!suggested) return;

                // Race-säkert: merga råförslaget mot FÄRSK state — användaren kan ha döpt om
                // en talare medan anropet var i luften, och mergeSuggestions skyddar då den
                // (nu användarsatta) nyckeln mot överskrivning.
                const fresh = useSyncStore.getState();
                if (!fresh.isRecording) return; // stoppad under await:en → post-stop-flödet tar över
                const merged = mergeSuggestions(fresh.liveSpeakerMap, suggested, fresh.liveAutoKeys);
                let changed = 0;
                for (const [k, v] of Object.entries(merged.map)) {
                    if (fresh.liveSpeakerMap[k] !== v) changed++;
                }
                if (changed > 0) {
                    fresh.setLiveSpeakerMap(merged.map);
                    fresh.setLiveAutoKeys(merged.autoKeys);
                    const elapsed = Math.round(
                        segments.reduce((m, s) => Math.max(m, s.end_time || s.start_time || 0), 0),
                    );
                    captureEvent("live_speaker_named", {
                        speaker_count: changed,
                        elapsed_recording_sec: elapsed,
                    });
                }
            } catch (e: any) {
                // Tyst — auto-loopen ska aldrig gnälla på användaren (speglar runIdentify silent).
                console.warn("Live-namngivning misslyckades:", e?.message || e);
            } finally {
                runningRef.current = false;
            }
        };

        const id = setInterval(() => { void tick(); }, THROTTLE_MS);
        return () => clearInterval(id);
    }, []);
}
