import { describe, it, expect, afterEach } from "vitest";
import { isMacOS } from "./platform";

/**
 * Grinden styr om titelraden visar wordmark + egna fönsterknappar (Windows) eller en
 * tom dragremsa (macOS). Den har bara setts svara "macOS" på utvecklingsmaskinen, och
 * en kontroll som aldrig setts fela är inte verifierad — därför matas den här med båda
 * plattformarnas riktiga strängar, plus de två fällor som ligger nära.
 */

const setUA = (ua: string) => {
    Object.defineProperty(globalThis.navigator, "userAgent", {
        value: ua,
        configurable: true,
    });
};

// Uppmätt i en WKWebView på macOS 26.6.1 den 2026-08-25 — inte påhittad.
const MACOS_WKWEBVIEW =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

// WebView2 (Edge/Chromium) på Windows 11.
const WINDOWS_WEBVIEW2 =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

describe("isMacOS", () => {
    const original = navigator.userAgent;
    afterEach(() => setUA(original));

    it("känner igen macOS WKWebView", () => {
        setUA(MACOS_WKWEBVIEW);
        expect(isMacOS()).toBe(true);
    });

    it("FÄLLER på Windows WebView2 — det negativa fallet", () => {
        setUA(WINDOWS_WEBVIEW2);
        expect(isMacOS()).toBe(false);
    });

    it("matchar inte på 'AppleWebKit', som Windows WebView2 också innehåller", () => {
        // Fällan: WebView2:s UA innehåller både "AppleWebKit" och "Safari". Matchar
        // grinden på något av dem får Windows macOS-titelraden och blir helt utan
        // fönsterknappar — appen går då inte att stänga med musen.
        expect(WINDOWS_WEBVIEW2).toContain("AppleWebKit");
        expect(WINDOWS_WEBVIEW2).toContain("Safari");
        setUA(WINDOWS_WEBVIEW2);
        expect(isMacOS()).toBe(false);
    });

    it("matchar inte på 'Intel', som står i macOS-strängen även på Apple Silicon", () => {
        // Fällan åt andra hållet: "Intel Mac OS X 10_15_7" är en kompatibilitetsfrys.
        // Matchar grinden på "Intel" ser den ut att fungera på varje Mac vi äger, och
        // går sönder den dagen strängen ändras — utan att något test märker det.
        expect(MACOS_WKWEBVIEW).toContain("Intel");
        setUA("Mozilla/5.0 (X11; Intel Linux x86_64) AppleWebKit/605.1.15");
        expect(isMacOS()).toBe(false);
    });
});
