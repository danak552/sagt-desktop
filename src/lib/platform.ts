/**
 * Plattformsdetektering i frontenden.
 *
 * 🔴 Verifierat genom KÖRNING 2026-08-25, inte antaget: `navigator.userAgent` i en
 * WKWebView på macOS 26.6.1 ger
 *
 *     Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)
 *
 * Två saker att veta om den strängen. Den säger "Intel" även på Apple Silicon — det är
 * en kompatibilitetsfrys som Apple aldrig tänker tina, så matcha ALDRIG på "Intel" eller
 * på versionsnumret 10_15_7. "Macintosh" är den stabila delen.
 *
 * Valdes framför `@tauri-apps/plugin-os` av ett skäl som inte är bekvämlighet: svaret
 * måste finnas SYNKRONT vid första renderingen. Plugin-ets `platform()` är async, och
 * en titelrad som hinner rita Windows-varianten en bildruta innan macOS-layouten slår
 * till är precis den sortens flimmer som inte går att felsöka i efterhand.
 */
export const isMacOS = (): boolean =>
    typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
