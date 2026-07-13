// Ren, enhetstestbar kärna för talarnamngivning — delas av den manuella "Namnge talare
// igen", §13.1 post-diariserings-auto-kedjan och STEG 2:s live-namngivningsloop.
//
// VIKTIGT: håll den STATISKA importgrafen ren (endast `import type`). `identifySpeakers`
// laddas via dynamisk import inuti `autoIdentify` så att modulen kan importeras i en ren
// Node-testmiljö utan att dra in api.ts → settings-store → Zustand-persist (som läser
// localStorage vid hydrering och kraschar utanför webbläsaren).
import type { UISegment } from "@/store/transcription-store";
import type { SpeakerTurn } from "@/lib/api";

export type SpeakerMap = Record<string, string>;

/** Persisterad talardata i `recordings.speaker_map`. `auto` är provenance (STEG 2) —
 *  vilka nycklar som satts av auto-namngivningen, så en användarredigering kan skydda
 *  sin nyckel mot framtida auto-överskrivning. Bakåtkompatibel: äldre rader saknar `auto`. */
export interface SpeakerData {
    map: SpeakerMap;
    participants: string[];
    auto: string[];
}

// Kanonisk etikett: mic/DU → "DU", sys/MÖTET → "MÖTET" (segment kan bära endera formen).
// Mappning och hints nycklas på den kanoniska formen så de två varianterna inte splittras.
// Delad källa — SplitView importerar denna i stället för en lokal dubblett.
export function speakerKey(sp: string): string {
    return (sp === "mic" || sp === "DU") ? "DU" : (sp === "sys" || sp === "MÖTET") ? "MÖTET" : sp;
}

/**
 * Bygg kanoniska talarturer ur strömmade/visade segment. Generaliserar `turnsFromJob`
 * (split-view.tsx) från ett jobbresultat till godtyckliga `UISegment[]` (t.ex. live-
 * segmenten i transcription-store). Filtrerar bort MOLN (sammanhängande molntext utan
 * talare) och tomma texter; nycklarna kanoniseras.
 */
export function buildTurnsFromSegments(segments: UISegment[]): SpeakerTurn[] {
    return segments
        .map(s => ({
            speaker: speakerKey(String(s?.speaker ?? "")),
            text: String(s?.text ?? "").trim(),
            start: typeof s?.start_time === "number" ? s.start_time : null,
        }))
        .filter(t => t.text && t.speaker && t.speaker !== "MOLN");
}

/**
 * Provenance-styrd merge av LLM-förslag ovanpå den gällande namnmappningen.
 *
 * INVARIANT: ett auto-satt namn får förfinas av en senare auto-körning; ett ANVÄNDARSATT
 * namn (finns i `base` men INTE i `autoKeys`) rörs ALDRIG. En nyckel som saknas i `base`
 * får sitt förslag och registreras som auto. Fixar dagens bugg `{ ...base, ...suggested }`
 * som lät ett auto-förslag skriva över manuellt inskrivna namn.
 *
 * Muterar inte inparametrarna. Returnerar ny map + ny auto-lista.
 */
export function mergeSuggestions(
    base: SpeakerMap,
    suggested: SpeakerMap,
    autoKeys: string[],
): { map: SpeakerMap; autoKeys: string[] } {
    const map: SpeakerMap = { ...base };
    const auto = new Set(autoKeys);
    for (const [key, name] of Object.entries(suggested)) {
        if (!name || !name.trim()) continue;
        const isUserSet = key in base && !auto.has(key);
        if (isUserSet) continue; // användaren vinner alltid
        map[key] = name;
        auto.add(key);
    }
    return { map, autoKeys: [...auto] };
}

/** Serialisera talardata till DB-payloaden `{map, participants, auto}`. */
export function serializeSpeakerData(data: SpeakerData): string {
    return JSON.stringify({ map: data.map, participants: data.participants, auto: data.auto });
}

/** Parsa DB-payloaden bakåtkompatibelt. Saknat/trasigt fält → tom default (`auto: []`
 *  för rader skrivna före STEG 2). */
export function parseSpeakerData(raw: string | null | undefined): SpeakerData {
    if (!raw) return { map: {}, participants: [], auto: [] };
    try {
        const p = JSON.parse(raw);
        return {
            map: p?.map && typeof p.map === "object" ? p.map : {},
            participants: Array.isArray(p?.participants) ? p.participants : [],
            auto: Array.isArray(p?.auto) ? p.auto : [],
        };
    } catch {
        return { map: {}, participants: [], auto: [] };
    }
}

/**
 * Bygg turer ur segmenten → anropa `identifySpeakers` → returnera RÅA LLM-förslag (etikett → namn).
 * Ingen merge, ingen persistens: anroparen mergar själv (mergeSuggestions) mot FÄRSK state, vilket
 * är nödvändigt för race-säkerhet i live-loopen — användaren kan ha döpt om en talare medan anropet
 * var i luften, och den rename:n måste vinna. Returnerar `null` när det inte finns turer att
 * identifiera eller LLM:en inte gav några namn (då ska staten lämnas oförändrad).
 *
 * `identifySpeakers` laddas dynamiskt (se filhuvudet) så modulens statiska graf förblir ren.
 */
export async function autoIdentify(
    segments: UISegment[],
    participantHints: string[],
    token: string,
): Promise<SpeakerMap | null> {
    const turns = buildTurnsFromSegments(segments);
    if (turns.length === 0) return null;
    const { identifySpeakers } = await import("@/lib/api");
    const result = await identifySpeakers(turns, participantHints, token);
    const suggested = result.speaker_map || {};
    if (Object.keys(suggested).length === 0) return null;
    return suggested;
}
