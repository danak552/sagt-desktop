import { useState } from "react";

/**
 * Delad hook för mönstret "avfärda ett kort och kom ihåg valet över omstarter".
 *
 * Avfärdandet persisteras i localStorage under `key` (redan namespacead med
 * `sagt_`-prefix av anroparen). Returnerar `{ dismissed, dismiss }`.
 *
 * `token` styr *vad* som avfärdas — och därmed när kortet får visas igen:
 *   - utelämnad → boolean-läge. Nyckeln sätts till "1"; `dismissed` = nyckeln finns.
 *     (Pro-hinten: en gång avfärdad, för alltid dold.)
 *   - satt      → värde-läge. Nyckeln sätts till `token`; `dismissed` = lagrat === token.
 *     (MOTD-bannern: ett *nytt* meddelande = ny token = kortet visas igen trots
 *     att en tidigare version avfärdats.)
 *
 * `dismissed` läses en gång vid mount — inte reaktivt — precis som kopiorna
 * hooken ersätter. Avfärdan sker via `dismiss()`, som även uppdaterar state så
 * att UI:t döljs direkt utan omläsning.
 */
export function useDismissible(key: string, token?: string | null) {
    // null/undefined token faller tillbaka på "1", så boolean-läget och ett
    // ännu-inte-laddat värde (t.ex. motd === null) beter sig identiskt med
    // originalen: lagrat === "1" är falskt när bara värde-tokens skrivits.
    const resolved = token ?? "1";
    const [dismissed, setDismissed] = useState(
        () => localStorage.getItem(key) === resolved
    );

    const dismiss = () => {
        localStorage.setItem(key, resolved);
        setDismissed(true);
    };

    return { dismissed, dismiss };
}
