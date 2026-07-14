import { describe, it, expect } from "vitest";
import { LiveDiarizeAccumulator, type LiveSpeakerMessage } from "./live-diarize-labels";

function start(speaker: string, timestamp: number): LiveSpeakerMessage {
    return { type: "diarization_speaker_start", data: { speaker, timestamp } };
}
function end(speaker: string, timestamp: number): LiveSpeakerMessage {
    return { type: "diarization_speaker_end", data: { speaker, timestamp } };
}

describe("LiveDiarizeAccumulator", () => {
    it("bygger en tur från start+end med MÖTET 1 och baseSec-offset", () => {
        const acc = new LiveDiarizeAccumulator();
        expect(acc.onEvent(start("SPEAKER_00", 1.0), 0, 10)).toBe(false);
        expect(acc.onEvent(end("SPEAKER_00", 3.0), 0, 10)).toBe(true);
        expect(acc.getTurns()).toEqual([
            { start: 11, end: 13, speaker: "MÖTET 1", channel: "right" },
        ]);
    });

    it("numrerar distinkta talare i första-START-ordning", () => {
        const acc = new LiveDiarizeAccumulator();
        acc.onEvent(start("SPEAKER_00", 0), 0, 0);   // MÖTET 1
        acc.onEvent(start("SPEAKER_01", 1), 0, 0);   // MÖTET 2
        acc.onEvent(end("SPEAKER_01", 2), 0, 0);
        acc.onEvent(end("SPEAKER_00", 3), 0, 0);
        const speakers = acc.getTurns().map((t) => t.speaker);
        // SPEAKER_00 startade först → MÖTET 1 (även om den avslutades sist).
        expect(speakers).toEqual(["MÖTET 2", "MÖTET 1"]);
    });

    it("återanvänder samma etikett för samma (session, talare) — stabilt", () => {
        const acc = new LiveDiarizeAccumulator();
        acc.onEvent(start("SPEAKER_00", 0), 0, 0);
        acc.onEvent(end("SPEAKER_00", 1), 0, 0);
        acc.onEvent(start("SPEAKER_00", 2), 0, 0);
        acc.onEvent(end("SPEAKER_00", 3), 0, 0);
        expect(acc.getTurns().map((t) => t.speaker)).toEqual(["MÖTET 1", "MÖTET 1"]);
    });

    it("håller sessioner isär: samma SPEAKER_NN i olika sessioner = olika etiketter (Q3)", () => {
        const acc = new LiveDiarizeAccumulator();
        acc.onEvent(start("SPEAKER_00", 0), 0, 0);   // session 0 → MÖTET 1
        acc.onEvent(end("SPEAKER_00", 1), 0, 0);
        acc.onEvent(start("SPEAKER_00", 0), 1, 60);  // session 1, baseSec 60 → MÖTET 2
        acc.onEvent(end("SPEAKER_00", 1), 1, 60);
        expect(acc.getTurns()).toEqual([
            { start: 0, end: 1, speaker: "MÖTET 1", channel: "right" },
            { start: 60, end: 61, speaker: "MÖTET 2", channel: "right" },
        ]);
    });

    it("ignorerar end utan matchande start", () => {
        const acc = new LiveDiarizeAccumulator();
        expect(acc.onEvent(end("SPEAKER_00", 5), 0, 0)).toBe(false);
        expect(acc.getTurns()).toEqual([]);
    });

    it("hoppar över degenererade turer (end <= start)", () => {
        const acc = new LiveDiarizeAccumulator();
        acc.onEvent(start("SPEAKER_00", 5), 0, 0);
        expect(acc.onEvent(end("SPEAKER_00", 5), 0, 0)).toBe(false); // 0-längd
        expect(acc.getTurns()).toEqual([]);
    });

    it("ignorerar ofullständiga/okända meddelanden", () => {
        const acc = new LiveDiarizeAccumulator();
        expect(acc.onEvent({ type: "end_of_stream" }, 0, 0)).toBe(false);
        expect(acc.onEvent({ type: "diarization_speaker_start", data: {} }, 0, 0)).toBe(false);
        expect(acc.onEvent({ type: "diarization_speaker_end", data: { speaker: "SPEAKER_00" } }, 0, 0)).toBe(false);
        expect(acc.getTurns()).toEqual([]);
    });
});
