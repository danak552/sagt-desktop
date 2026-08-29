import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, type LocalAudioRetention } from "@/store/settings-store";

// Speglar Rust-structarna i database.rs (StorageUsage / CleanupResult).
export interface StorageUsage {
    recordings_bytes: number;
    db_bytes: number;
    file_count: number;
}

export interface CleanupResult {
    deleted_count: number;
    freed_bytes: number;
    /** Inspelnings-id:n vars ljudfil gallrats — för uppdatering av in-memory-state (activeJob). */
    deleted_ids: number[];
}

export const GB = 1024 ** 3;

/**
 * Översätt gallringspolicy till parametrar för cleanup_audio_storage.
 * null = ingen gallring (keep_all).
 * OBS Tauri v2: Rust-parametrarna max_age_days/max_total_bytes anropas med camelCase.
 */
export function retentionToParams(policy: LocalAudioRetention): { maxAgeDays?: number; maxTotalBytes?: number } | null {
    switch (policy) {
        case 'keep_all': return null;
        case 'days_30':  return { maxAgeDays: 30 };
        case 'days_90':  return { maxAgeDays: 90 };
        case 'gb_10':    return { maxTotalBytes: 10 * GB };
    }
}

/**
 * Kör auto-gallring enligt användarens policy. No-op vid 'keep_all'.
 * Raderar äldsta ljudfilerna först — transkript och analys behålls alltid.
 */
export async function runStorageCleanup(): Promise<CleanupResult | null> {
    const params = retentionToParams(useSettingsStore.getState().localAudioRetention);
    if (!params) return null;
    return invoke<CleanupResult>("cleanup_audio_storage", params);
}

export async function getStorageUsage(): Promise<StorageUsage> {
    return invoke<StorageUsage>("get_storage_usage");
}

/**
 * Öppnar inspelningskatalogen i systemets filhanterare — Utforskaren på Windows,
 * Finder på macOS. `openPath` väljer själv. Kärnlöftet är att ljudet stannar på datorn —
 * då ska användaren också kunna gå dit och se filerna, inte bara läsa en siffra i byte.
 *
 * Två vägar, i fallande ordning av hur bra resultatet blir:
 *
 *  1. `openPath` öppnar mappen direkt. Kräver BÅDE behörigheten `opener:allow-open-path`
 *     OCH en scope-post för sökvägen i capabilities — pluginets `open_path` validerar
 *     sökvägen mot ett scope och returnerar `ForbiddenPath` när tillåtelselistan är tom.
 *     Behörigheten ensam räcker alltså inte; det var exakt felet i v0.9.43.
 *  2. `revealItemInDir` som fallback. Den saknar scope-kontroll helt i pluginet och
 *     ingår i `opener:default`, så den kan inte nekas — men den öppnar FÖRÄLDERN med
 *     mappen markerad, alltså ett klick extra för användaren.
 *
 * Fallbacken finns för att scope-syntaxen ($APPDATA-upplösningen) bara går att verifiera
 * i ett signerat CI-bygge. Hellre en knapp som alltid gör något vettigt än en som är död
 * i ytterligare en releasecykel.
 */
export async function openRecordingsFolder(): Promise<void> {
    const dir = await invoke<string>("get_recordings_dir");
    const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
    try {
        await openPath(dir);
    } catch (e) {
        console.warn("openPath nekades (scope?) — faller tillbaka på revealItemInDir:", e);
        await revealItemInDir(dir);
    }
}

/** Svensk formatering av bytes: "850 MB", "3,2 GB". */
export function formatBytes(bytes: number): string {
    if (bytes >= GB) return `${(bytes / GB).toFixed(1).replace('.', ',')} GB`;
    const MB = 1024 ** 2;
    if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
    return `${bytes} B`;
}
