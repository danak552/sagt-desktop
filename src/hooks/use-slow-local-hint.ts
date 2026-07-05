import { useEffect, useState } from "react";
import { usePostHogEvents } from "./use-posthog-events";

// Pro-hint vid långsam lokal transkribering. Triggern är medvetet enkel (v1):
// "Slutför transkribering"-läget som kvarstår >= 15 s efter stopp är en direkt
// proxy för realtidsfaktor > ~1 på användarens CPU — helt utan Rust-ändringar.
// Budskapskärnan i kortet: GPU krävs (fysik) -> därför liten modell + långsamt
// lokalt -> Pro = dedikerade GPU:er + största KB-Whisper-modellen.
const SLOW_THRESHOLD_MS = 15_000;
const DISMISS_KEY = "sagt_slow_hint_dismissed";

// Modulnivå: PostHog-eventet fyras max en gång per appsession även om
// SplitView avmonteras vid flikbyte (komponent-state överlever inte det).
let upsellEventSent = false;

/**
 * `eligible` = slutför-läget pågår OCH användaren är i målgruppen (ej Pro,
 * ej moln — anroparen äger det villkoret). Hinten visas efter 15 s
 * sammanhängande väntan, försvinner när läget bryts, och kan avfärdas
 * permanent (localStorage) via `dismiss`.
 */
export function useSlowLocalHint(eligible: boolean) {
    const events = usePostHogEvents();
    const [show, setShow] = useState(false);
    // Läses en gång per visningsbeslut — inte reaktivt, men avfärdan går via
    // dismiss() som också sätter state, så UI:t är alltid konsistent.
    const [dismissed, setDismissed] = useState(
        () => !!localStorage.getItem(DISMISS_KEY)
    );

    useEffect(() => {
        if (!eligible || dismissed) {
            setShow(false);
            return;
        }
        // Timer med avbrott: bryts slutför-läget (klart/avbrutet/ny inspelning)
        // före tröskeln städar cleanupen bort timern och ingen hint visas.
        const timer = setTimeout(() => {
            setShow(true);
            if (!upsellEventSent) {
                upsellEventSent = true;
                events.upsellShown("slow_local_processing");
            }
        }, SLOW_THRESHOLD_MS);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [eligible, dismissed]);

    const dismiss = () => {
        localStorage.setItem(DISMISS_KEY, "1");
        setDismissed(true);
        setShow(false);
    };

    return { showSlowHint: show, dismissSlowHint: dismiss };
}
