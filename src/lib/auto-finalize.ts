// Post-stop-pipelinen för PRO live-molnströmning (STEG 4 + 5). Extraherad ur ControlBars
// history-updated-gren (som var stor) och anropad därifrån. Kör efter att moln-kön dränerats:
//
//   1. Persistera de strömmade segmenten (Du/Mötet) — texten är redan läsbar.
//   2. PARALLELLT (oberoende indata): auto-analys (§5) på texten + auto-diarisering (§4) som
//      delar MÖTET-kanalen i Talare 1/2/3 och namnger dem. Analysen läser bara `text`,
//      diariseringen bara `speaker` → ingen kapplöpning om samma fält, snabbast till "allt klart".
//
// All automatik är GATEAD på molnläge + structured + Pro + online + respektive toggle. Aldrig
// i lokal-läge (integritetslöftet). Fel degraderar TYST till dagens Du/Mötet-läge — de manuella
// reparationsmenyerna ("Transkribera om med talarseparering", "Namnge talare igen", "Starta
// analys") finns kvar i SplitView.
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/store/settings-store";
import { useSyncStore } from "@/store/sync-store";
import { useTranscriptionStore, UISegment } from "@/store/transcription-store";
import { useAuthStore } from "@/store/auth-store";
import { diarizeMeeting, reanalyzeTranscript } from "@/lib/api";
import { applyDiarizationTurns } from "@/lib/diarize-relabel";
import { autoIdentify, mergeSuggestions, parseSpeakerData, serializeSpeakerData, speakerKey } from "@/lib/speaker-naming";
import { stripUnstableSpeakerMapKeys } from "@/lib/cloud-sync";
import { captureEvent } from "@/hooks/use-posthog-events";
import { waitForCloudStreamIdle } from "@/hooks/use-cloud-stream";

interface StoppedRecording {
    id: number | null;
    file_path: string;
}

/** Serialisera UI-segment till Rust `update_recording_segments`-payloaden (DB-formen). */
function toDbSegments(segs: UISegment[]) {
    return segs.map(s => ({
        start_time: s.start_time,
        end_time: s.end_time,
        text: s.text,
        speaker: s.speaker,
    }));
}

/**
 * True om `recordingId` fortfarande är den session som visas. Pipelinen är långkörande
 * (drän + extraktion + diarisering kan ta tiotals sekunder på ett långt möte); under tiden
 * kan användaren ha startat en NY inspelning eller öppnat ett annat historikjobb. GLOBALA
 * store-skrivningar (setSegments/setAnalysisData/setActiveJob) får då INTE ske — annars
 * klottrar det gamla mötets resultat över den nya vyn (setSegments över live-segmenten →
 * korrupt transkript). DB-skrivningar är nycklade på `recording.id` och alltid säkra.
 */
function isViewingRecording(recordingId: number | null): boolean {
    const st = useSyncStore.getState();
    return !st.isRecording && st.activeJob?.id === recordingId;
}

/**
 * Kör auto-analysen (§steg 5) på den strömmade texten. Egen felhantering: analysfel får
 * ALDRIG påverka diariseringen eller den redan persisterade texten. Tyst degradering.
 */
async function runAutoAnalysis(recordingId: number | null, segs: UISegment[], token: string): Promise<void> {
    try {
        captureEvent("analysis_requested", { source: "auto_stop" });
        const fullText = segs.map(s => s.text).join(" ");
        const raw = await reanalyzeTranscript(fullText, "general", token);
        // Publicera bara om detta möte fortfarande visas (annars klottrar vi den nya
        // sessionens analysvy). reset() vid ny inspelning har redan nollställt analysData.
        if (isViewingRecording(recordingId)) {
            useSyncStore.getState().setAnalysisData({
                summary: raw.summary || "",
                decisions: raw.key_decisions || [],
                actions: raw.action_items || [],
                template_used: raw.template_used || "general",
            });
        }
        captureEvent("analysis_completed", { source: "auto_stop" });
    } catch (e: any) {
        console.error("Auto-analys vid stopp misslyckades:", e);
        captureEvent("analysis_failed", { error: e?.message || "unknown", source: "auto_stop" });
    }
}

/**
 * Efter en lyckad diarisering: föreslå namn på de nya MÖTET N-talarna och persistera.
 * R4: strippa instabila (omnumrerbara) nycklar ur gällande map INNAN merge så gamla namn
 * inte hänger kvar på fel omnumrerad röst. Provenance bevaras (mergeSuggestions).
 */
async function autoNameAfterDiarize(
    recording: StoppedRecording,
    relabeled: UISegment[],
    baseSpeakerMapRaw: string | null,
    token: string,
): Promise<void> {
    // Basen läses från det VÄRDE som fångades vid finalize-start (då activeJob garanterat var
    // detta möte, efter flushen). Att läsa activeJob här sent vore fel om användaren öppnat ett
    // annat historikjobb under diariseringen.
    const current = parseSpeakerData(baseSpeakerMapRaw);

    // R4: ta bort MÖTET N / DU N / TALARE N ur basen (den nya diariseringen numrerar om).
    const strippedMap = stripUnstableSpeakerMapKeys(current.map);
    const strippedAuto = current.auto.filter(k => k in strippedMap);

    const suggested = await autoIdentify(relabeled, current.participants, token);
    // Ingen namnhärledning → behåll strippade basen (men persistera ändå strippningen nedan
    // så en tidigare namngiven, nu omnumrerad talare inte visar fel namn).
    const merged = suggested
        ? mergeSuggestions(strippedMap, suggested, strippedAuto)
        : { map: strippedMap, autoKeys: strippedAuto };

    // Ingen namnhärledning OCH inga instabila nycklar strippade → payloaden är identisk med
    // det redan sparade (stripping tar bara bort nycklar; lika längd ⇒ inget borttaget). Hoppa
    // persistensen så vi undviker en onödig DB-skrivning + activeJob-re-render.
    const nothingChanged =
        suggested == null &&
        Object.keys(strippedMap).length === Object.keys(current.map).length;
    if (nothingChanged) return;

    const payload = serializeSpeakerData({
        map: merged.map,
        participants: current.participants,
        auto: merged.autoKeys,
    });
    if (recording.id != null) {
        await invoke("save_speaker_map_to_db", { id: recording.id, speakerMap: payload });
    }
    // Uppdatera activeJob så SplitView (post-stop läser activeJob.speaker_map) visar namnen —
    // men BARA om detta möte fortfarande visas. liveSpeakerMap rörs INTE (nollställd vid flush).
    if (isViewingRecording(recording.id)) {
        const latest = useSyncStore.getState().activeJob;
        useSyncStore.getState().setActiveJob(
            { ...latest, speaker_map: payload },
            useSyncStore.getState().activeJobFromHistory,
        );
    }
}

/**
 * Auto-diarisering vid stopp (§steg 4): extrahera MÖTET-kanalen i Rust → diarisera i molnet →
 * mappa turerna på de strömmade segmenten → persistera + namnge. Tyst degradering vid fel.
 */
async function runAutoDiarize(
    recording: StoppedRecording,
    segs: UISegment[],
    baseSpeakerMapRaw: string | null,
    token: string,
): Promise<void> {
    // Deklareras utanför try så finally alltid kan städa den extraherade mono-kopian (upp till
    // ~440 MB), oavsett om diariseringen lyckas, ger 0 turer eller kastar. Utan detta läcker
    // MÖTET-kopian till app_data/diarize_temp/ (utanför DB-gallringen) — lagring + integritet.
    let monoPath: string | null = null;
    try {
        monoPath = await invoke<string>("extract_meeting_channel", { path: recording.file_path });
        const turns = await diarizeMeeting(monoPath, token);
        if (!turns || turns.length === 0) return; // inget att applicera → behåll DU/MÖTET

        const relabeled = applyDiarizationTurns(segs, turns);

        // Persistera de omdöpta segmenten till DB (nyckel = recording.id → alltid säkert).
        if (recording.id != null) {
            await invoke("update_recording_segments", {
                recordingId: recording.id,
                segments: toDbSegments(relabeled),
            });
        }
        // Uppdatera live-vyn BARA om detta möte fortfarande visas — annars skulle vi klottra
        // en ny sessions live-segment (transcription-store är global och överlever flikbyte).
        if (isViewingRecording(recording.id)) {
            useTranscriptionStore.getState().setSegments(relabeled);
        }

        await autoNameAfterDiarize(recording, relabeled, baseSpeakerMapRaw, token);
    } catch (e: any) {
        console.warn("Auto-diarisering vid stopp misslyckades:", e?.message || e);
        captureEvent("diarization_failed", { reason: e?.message || "unknown", source: "auto_stop" });
        // behåll DU/MÖTET (dagens läge) — den manuella menyn finns kvar som reparation.
    } finally {
        // Best-effort radering. Rust vägrar sökvägar utanför diarize_temp och sväljer NotFound,
        // så detta är säkert även om filen redan städats av nästa extract_meeting_channel-körning.
        if (monoPath) {
            try {
                await invoke("delete_diarize_temp", { path: monoPath });
            } catch (e: any) {
                console.warn("Kunde inte radera diarize-temp-fil:", e?.message || e);
            }
        }
    }
}

/** True om auto-diarisering ska köras: molnläge + structured + Pro + online + autoDiarize +
 *  ljudfil + minst ett MÖTET-segment att dela + token. */
function shouldAutoDiarize(isCloudMode: boolean, recording: StoppedRecording, segs: UISegment[], token: string | null): boolean {
    const s = useSettingsStore.getState();
    return (
        isCloudMode &&
        s.cloudDiarizationMode === "structured" &&
        s.autoDiarize &&
        useAuthStore.getState().isPro() &&
        navigator.onLine &&
        !!token &&
        recording.id != null &&
        !!recording.file_path &&
        segs.some(seg => speakerKey(String(seg.speaker ?? "")) === "MÖTET")
    );
}

/**
 * Post-stop-pipelinen för en STRÖMMAD molnsession. Anropas av ControlBar i history-updated
 * när `cloudStreamingActive`. Persisterar strömmade segment, kör sedan analys + diarisering
 * parallellt. Blockerar inte UI:t med toaster — texten är redan läsbar; en diskret
 * "Förfinar talare…"-indikator styrs via isProcessing i anroparen.
 */
export async function finalizeStreamingSession(params: {
    recording: StoppedRecording;
    isCloudMode: boolean;
    token: string | null;
}): Promise<void> {
    const { recording, isCloudMode, token } = params;
    const tStore = useTranscriptionStore.getState();
    tStore.setIsProcessing(true);
    // Fånga talarmap-basen NU, medan activeJob garanterat är detta möte (satt + flushat i
    // history-updated före detta anrop). autoNameAfterDiarize läser detta värde, inte en sent
    // omläst activeJob som kan ha bytts av en ny session/historiköppning under diariseringen.
    const baseSpeakerMapRaw: string | null = useSyncStore.getState().activeJob?.speaker_map ?? null;
    try {
        // Vänta tills moln-kön dränerats så de sista chunkarna hinner in (analysen ska köra
        // på KOMPLETT text; eftersläpande chunks vid mötesslut tar ofta >8 s).
        await waitForCloudStreamIdle(60000);
        const segs = useTranscriptionStore.getState().segments;

        // Persistera de strömmade segmenten som baslinje (Du/Mötet-vy) INNAN diariseringen.
        // Detta är avsiktligt: om runAutoDiarize kastar eller aldrig hinner klart (t.ex. appen
        // stängs) finns texten redan i DB. På success-vägen skriver runAutoDiarize över med de
        // omdöpta segmenten — det andra skrivet är alltså inte redundant utan en förfining.
        if (recording.id != null && segs.length > 0) {
            await invoke("update_recording_segments", {
                recordingId: recording.id,
                segments: toDbSegments(segs),
            });
        }

        // Analys (§5) + diarisering (§4) parallellt — oberoende indata. allSettled: den ena
        // får misslyckas utan att stoppa den andra.
        const settings = useSettingsStore.getState();
        const tasks: Promise<void>[] = [];
        if (isCloudMode && settings.autoAnalyze && segs.length > 0 && token) {
            tasks.push(runAutoAnalysis(recording.id, segs, token));
        }
        if (shouldAutoDiarize(isCloudMode, recording, segs, token)) {
            tasks.push(runAutoDiarize(recording, segs, baseSpeakerMapRaw, token as string));
        }
        if (tasks.length > 0) await Promise.allSettled(tasks);
    } catch (e: any) {
        console.error("Streaming post-stop finalize failed:", e);
    } finally {
        // Rensa "Bearbetar…"-indikatorn bara om detta möte fortfarande visas ELLER ingen ny
        // inspelning pågår — en ny session äger då flaggan själv (undviker att släcka dess spinner).
        if (!useSyncStore.getState().isRecording) {
            useTranscriptionStore.getState().setIsProcessing(false);
        }
    }
}
