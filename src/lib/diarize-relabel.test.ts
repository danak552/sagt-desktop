import { describe, it, expect } from "vitest";
import { applyDiarizationTurns } from "./diarize-relabel";
import type { UISegment } from "@/store/transcription-store";
import type { DiarizeTurn } from "@/lib/api";

function seg(start: number, end: number, speaker: string, text = "x"): UISegment {
    return { start_time: start, end_time: end, text, speaker, timestamp: 0 };
}
function turn(start: number, end: number, speaker: string): DiarizeTurn {
    return { start, end, speaker, channel: "right" };
}

describe("applyDiarizationTurns", () => {
    it("lämnar segmenten orörda vid inga turer", () => {
        const segs = [seg(0, 5, "MÖTET"), seg(5, 10, "DU")];
        expect(applyDiarizationTurns(segs, [])).toBe(segs);
    });

    it("rör aldrig DU-segment (endast MÖTET-kanalen diariseras)", () => {
        const segs = [seg(0, 5, "DU")];
        const turns = [turn(0, 5, "MÖTET 1")];
        const out = applyDiarizationTurns(segs, turns);
        expect(out[0].speaker).toBe("DU");
    });

    it("tilldelar MÖTET-segment etiketten från turen med störst överlapp", () => {
        // Segment 0..10; tur A (MÖTET 1) överlappar 0..3 (=3), tur B (MÖTET 2) överlappar 3..10 (=7).
        const segs = [seg(0, 10, "MÖTET")];
        const turns = [turn(0, 3, "MÖTET 1"), turn(3, 10, "MÖTET 2")];
        const out = applyDiarizationTurns(segs, turns);
        expect(out[0].speaker).toBe("MÖTET 2");
    });

    it("behåller MÖTET när ingen tur överlappar segmentet", () => {
        const segs = [seg(20, 25, "MÖTET")];
        const turns = [turn(0, 5, "MÖTET 1")];
        const out = applyDiarizationTurns(segs, turns);
        expect(out[0].speaker).toBe("MÖTET");
    });

    it("gör ingen ändring när enda talaren är 'MÖTET' (1 talare, ingen numrering)", () => {
        const segs = [seg(0, 5, "MÖTET")];
        const turns = [turn(0, 5, "MÖTET")];
        const out = applyDiarizationTurns(segs, turns);
        expect(out[0]).toBe(segs[0]); // samma referens → ingen onödig allokering
    });

    it("kanoniserar 'sys'-etiketten till MÖTET-kanalen", () => {
        const segs = [seg(0, 5, "sys")];
        const turns = [turn(0, 5, "MÖTET 1")];
        const out = applyDiarizationTurns(segs, turns);
        expect(out[0].speaker).toBe("MÖTET 1");
    });

    it("ignorerar turer utan MÖTET-etikett (defensivt mot flerkanalssvar)", () => {
        const segs = [seg(0, 5, "MÖTET")];
        const turns = [turn(0, 5, "DU 1"), turn(0, 5, "TALARE 2")];
        const out = applyDiarizationTurns(segs, turns);
        expect(out[0].speaker).toBe("MÖTET");
    });

    it("nolltoleranslös överlapp (endast rörande kanter) räknas inte", () => {
        // Tur slutar exakt där segmentet börjar → overlap = 0 → behåll MÖTET.
        const segs = [seg(5, 10, "MÖTET")];
        const turns = [turn(0, 5, "MÖTET 1")];
        const out = applyDiarizationTurns(segs, turns);
        expect(out[0].speaker).toBe("MÖTET");
    });

    it("relabelar flera MÖTET-segment oberoende och lämnar DU emellan", () => {
        const segs = [seg(0, 4, "MÖTET"), seg(4, 6, "DU"), seg(6, 10, "MÖTET")];
        const turns = [turn(0, 4, "MÖTET 1"), turn(6, 10, "MÖTET 2")];
        const out = applyDiarizationTurns(segs, turns);
        expect(out.map(s => s.speaker)).toEqual(["MÖTET 1", "DU", "MÖTET 2"]);
    });
});
