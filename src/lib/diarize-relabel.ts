// Ren, enhetstestbar motor som mappar akustiska diariseringsturer (MÖTET-kanalen) på de
// redan STRÖMMADE segmenten via största tidsöverlapp. Delas av STEG 4:s auto-diarisering
// vid stopp (auto-finalize.ts) och — i STEG 3 — Live-1:s inkrementella speaker-events.
//
// Fungerar för att BÅDA sidor bär sessionsrelativa sekunder med SAMMA origo: strömmade
// segment får `session_offset` (audio.rs) och diariseringsturerna kommer från samma
// sessions-WAV → en turs `{start,end}` och ett segments `{start_time,end_time}` är direkt
// jämförbara. Största-överlapp är robust mot den lilla skevheten mellan recorder-trådens
// start och sessionsstarten.
//
// Håll den STATISKA importgrafen ren (endast `import type` + den rena `speakerKey`) så
// modulen kan enhetstestas i en Node-miljö utan att dra in Zustand/api.ts.
import type { UISegment } from "@/store/transcription-store";
import type { DiarizeTurn } from "@/lib/api";
import { speakerKey } from "@/lib/speaker-naming";

/**
 * Relabela MÖTET-segmenten enligt diariseringsturerna. DU-/MOLN-/övriga segment lämnas
 * orörda (endast MÖTET-kanalen diariseras — DU är redan en känd enskild talare via mic-
 * hinten §13.4). Ett MÖTET-segment får etiketten (`MÖTET`, `MÖTET 1`, `MÖTET 2` …) från
 * den tur det överlappar MEST i tid; utan positivt överlapp behålls `MÖTET`.
 *
 * Muterar inte inparametrarna. Vid inga turer returneras segmenten oförändrade.
 */
export function applyDiarizationTurns(segments: UISegment[], turns: DiarizeTurn[]): UISegment[] {
    if (!Array.isArray(segments) || segments.length === 0) return segments;
    if (!Array.isArray(turns) || turns.length === 0) return segments;

    // Endast MÖTET-turer appliceras (endpointen returnerar bara högerkanalen, men var
    // defensiv mot framtida flerkanalssvar): "MÖTET" eller "MÖTET N".
    const meetingTurns = turns.filter(t => {
        const sp = String(t?.speaker ?? "");
        return sp === "MÖTET" || /^MÖTET\s+\d+$/.test(sp);
    });
    if (meetingTurns.length === 0) return segments;

    return segments.map(seg => {
        if (speakerKey(String(seg?.speaker ?? "")) !== "MÖTET") return seg; // DU/MOLN/övrigt orört
        const s = typeof seg.start_time === "number" ? seg.start_time : 0;
        const e = typeof seg.end_time === "number" ? seg.end_time : 0;

        let bestSpeaker: string | null = null;
        let bestOverlap = 0;
        for (const t of meetingTurns) {
            const ts = typeof t.start === "number" ? t.start : 0;
            const te = typeof t.end === "number" ? t.end : 0;
            const overlap = Math.min(e, te) - Math.max(s, ts);
            if (overlap > bestOverlap) {
                bestOverlap = overlap;
                bestSpeaker = String(t.speaker);
            }
        }

        // Ingen positiv överlapp, eller turen är redan "MÖTET" (1 talare → ingen numrering)
        // → segmentet är redan rätt märkt, undvik onödig objektallokering.
        if (bestSpeaker == null || bestSpeaker === seg.speaker) return seg;
        return { ...seg, speaker: bestSpeaker };
    });
}
