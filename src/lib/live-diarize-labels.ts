// Ren, enhetstestbar kärna för STEG 3:s live-diarisering: ackumulerar pyannoteAI Live-1
// speaker-events (över en HEL sessionskedja) → DiarizeTurn[] med STABILA "MÖTET N"-etiketter,
// redo för `applyDiarizationTurns` (samma motor som steg 4). Ingen ws, inga stores, inga
// sidoeffekter → testbar i Node.
//
// Två fynd från SPIKE S0-Live-1 som styr designen:
//   * Q3 — SPEAKER_NN är SESSIONSLOKALA (omnumreras + annan klustring per session). Därför
//     prefixas varje etikett med sessionsindex; ett unikt (session, SPEAKER_NN) får en egen
//     BESTÅENDE "MÖTET k" i första-förekomst-ordning. Etiketten ändras ALDRIG när fler turer
//     kommer → live-vyns namngivning (steg 2) hänger kvar (ingen R4-churn under mötet).
//     Batchen vid stopp (Q6) är slutkvalitet och skriver över allt.
//   * Q4 — event-timestamp är STREAM-START-relativ (ljudposition). Adderas med sessionens
//     `baseSec` (ljudposition när sessionens ström startade) → sessionsrelativa sekunder,
//     samma origo som de strömmade segmenten → direkt jämförbara i `applyDiarizationTurns`.
import type { DiarizeTurn } from "@/lib/api";

export interface LiveSpeakerMessage {
    type?: string;
    data?: { timestamp?: number; speaker?: string };
}

const SPEAKER_START = "diarization_speaker_start";
const SPEAKER_END = "diarization_speaker_end";

export class LiveDiarizeAccumulator {
    private labels = new Map<string, string>();     // "s:SPEAKER_NN" -> "MÖTET k"
    private openStarts = new Map<string, number>(); // "s:SPEAKER_NN" -> sessionsrelativ start (sek)
    private turns: DiarizeTurn[] = [];
    private next = 1;

    /** Bestående "MÖTET k" för ett (session, SPEAKER_NN); tilldelas vid första förekomst. */
    private labelFor(key: string): string {
        let label = this.labels.get(key);
        if (!label) {
            label = `MÖTET ${this.next++}`;
            this.labels.set(key, label);
        }
        return label;
    }

    /**
     * Bearbeta ETT event för sessionen (`sessionIndex` + `baseSec`). Returnerar true om en ny
     * tur lades till (ett speaker_end som stängde en öppen tur) → anroparen kan re-applicera.
     * Okända/ofullständiga meddelanden ignoreras tyst (returnerar false).
     */
    onEvent(msg: LiveSpeakerMessage, sessionIndex: number, baseSec: number): boolean {
        const sp = msg?.data?.speaker;
        const ts = msg?.data?.timestamp;
        if (typeof sp !== "string" || typeof ts !== "number" || !isFinite(ts)) return false;
        const key = `${sessionIndex}:${sp}`;

        if (msg.type === SPEAKER_START) {
            // Lås etikettnumret vid FÖRSTA förekomst (start-ordning) + öppna turen.
            this.labelFor(key);
            this.openStarts.set(key, baseSec + ts);
            return false;
        }

        if (msg.type === SPEAKER_END) {
            const start = this.openStarts.get(key);
            if (start == null) return false; // end utan matchande start → hoppa
            this.openStarts.delete(key);
            const end = baseSec + ts;
            if (end <= start) return false;  // degenererad/icke-positiv tur → hoppa
            this.turns.push({ start, end, speaker: this.labelFor(key), channel: "right" });
            return true;
        }

        return false; // end_of_stream / okänd typ
    }

    /** De ackumulerade turerna (växande lista). Muteras inte av anroparen. */
    getTurns(): DiarizeTurn[] {
        return this.turns;
    }
}
