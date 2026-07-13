import { describe, it, expect } from "vitest";
import {
    speakerKey,
    buildTurnsFromSegments,
    mergeSuggestions,
    parseSpeakerData,
    serializeSpeakerData,
} from "@/lib/speaker-naming";
import type { UISegment } from "@/store/transcription-store";

// Hjälpare: minimalt segment.
const seg = (over: Partial<UISegment>): UISegment => ({
    id: 0,
    start_time: 0,
    end_time: 0,
    text: "",
    speaker: "MÖTET",
    timestamp: 0,
    ...over,
});

describe("speakerKey", () => {
    it("kanoniserar mic/DU → DU och sys/MÖTET → MÖTET", () => {
        expect(speakerKey("mic")).toBe("DU");
        expect(speakerKey("DU")).toBe("DU");
        expect(speakerKey("sys")).toBe("MÖTET");
        expect(speakerKey("MÖTET")).toBe("MÖTET");
    });
    it("lämnar numrerade diariserings-etiketter orörda", () => {
        expect(speakerKey("TALARE 2")).toBe("TALARE 2");
    });
});

describe("buildTurnsFromSegments", () => {
    it("kanoniserar nycklar och mappar start_time → start", () => {
        const turns = buildTurnsFromSegments([
            seg({ speaker: "mic", text: "Hej", start_time: 1.5 }),
            seg({ speaker: "sys", text: "Hallå", start_time: 3 }),
        ]);
        expect(turns).toEqual([
            { speaker: "DU", text: "Hej", start: 1.5 },
            { speaker: "MÖTET", text: "Hallå", start: 3 },
        ]);
    });

    it("filtrerar bort MOLN och tomma texter", () => {
        const turns = buildTurnsFromSegments([
            seg({ speaker: "MOLN", text: "molntext" }),
            seg({ speaker: "MÖTET", text: "   " }),
            seg({ speaker: "MÖTET", text: "riktigt" }),
        ]);
        expect(turns).toEqual([{ speaker: "MÖTET", text: "riktigt", start: 0 }]);
    });

    it("sätter start: null när start_time saknas", () => {
        const turns = buildTurnsFromSegments([
            seg({ speaker: "DU", text: "x", start_time: undefined as unknown as number }),
        ]);
        expect(turns[0].start).toBeNull();
    });
});

describe("mergeSuggestions — provenance-invariant", () => {
    it("sätter en osatt nyckel och registrerar den som auto", () => {
        const { map, autoKeys } = mergeSuggestions({}, { DU: "Anna" }, []);
        expect(map).toEqual({ DU: "Anna" });
        expect(autoKeys).toEqual(["DU"]);
    });

    it("förfinar en tidigare auto-satt nyckel", () => {
        const { map, autoKeys } = mergeSuggestions({ DU: "Anna" }, { DU: "Anna Andersson" }, ["DU"]);
        expect(map.DU).toBe("Anna Andersson");
        expect(autoKeys).toContain("DU");
    });

    it("rör ALDRIG en användarsatt nyckel (i base, ej i autoKeys)", () => {
        const { map, autoKeys } = mergeSuggestions({ DU: "Mitt namn" }, { DU: "LLM-gissning" }, []);
        expect(map.DU).toBe("Mitt namn");
        expect(autoKeys).not.toContain("DU");
    });

    it("skyddar användarsatt nyckel men sätter samtidigt en ny auto-nyckel", () => {
        const { map, autoKeys } = mergeSuggestions(
            { DU: "Mitt namn" },
            { DU: "LLM", "MÖTET": "Erik" },
            [],
        );
        expect(map).toEqual({ DU: "Mitt namn", "MÖTET": "Erik" });
        expect(autoKeys).toEqual(["MÖTET"]);
    });

    it("ignorerar tomma förslagsnamn", () => {
        const { map, autoKeys } = mergeSuggestions({}, { DU: "  " }, []);
        expect(map).toEqual({});
        expect(autoKeys).toEqual([]);
    });

    it("muterar inte inparametrarna", () => {
        const base = { DU: "Anna" };
        const auto = ["DU"];
        mergeSuggestions(base, { "MÖTET": "Erik" }, auto);
        expect(base).toEqual({ DU: "Anna" });
        expect(auto).toEqual(["DU"]);
    });
});

describe("parseSpeakerData / serializeSpeakerData", () => {
    it("defaultar auto: [] för äldre rader utan fältet (bakåtkompatibelt)", () => {
        const parsed = parseSpeakerData(JSON.stringify({ map: { DU: "Anna" }, participants: ["Erik"] }));
        expect(parsed).toEqual({ map: { DU: "Anna" }, participants: ["Erik"], auto: [] });
    });

    it("tom/trasig payload → tom default", () => {
        expect(parseSpeakerData(null)).toEqual({ map: {}, participants: [], auto: [] });
        expect(parseSpeakerData("{trasig")).toEqual({ map: {}, participants: [], auto: [] });
    });

    it("roundtrip bevarar map, participants och auto", () => {
        const data = { map: { DU: "Anna" }, participants: ["Erik"], auto: ["DU"] };
        expect(parseSpeakerData(serializeSpeakerData(data))).toEqual(data);
    });
});
