import { describe, it, expect } from "vitest";
import {
    selectUpsellView,
    shouldAutoClose,
    shouldCelebrate,
    type UpsellFlags,
    type UpsellView,
} from "./upsell-state";

const flags = (isPro: boolean, paymentAttempted: boolean, isWaiting: boolean): UpsellFlags =>
    ({ isPro, paymentAttempted, isWaiting });

/** Alla åtta flaggkombinationer — uttömmande, så inget fall kan glömmas bort. */
const ALL: Array<[UpsellFlags, UpsellView]> = [
    // isPro=false — kunden har inte Pro
    [flags(false, false, false), 'sales'],                  // orörd modal
    [flags(false, false, true), 'sales'],                   // polling utan betalförsök: kan inte inträffa, men får aldrig ge väntevy
    [flags(false, true, true), 'awaiting-confirmation'],    // betalning öppnad, pollar
    [flags(false, true, false), 'confirmation-stalled'],    // pollingen har gett upp
    // isPro=true — servern har bekräftat Pro
    [flags(true, false, false), 'sales'],                   // återvändande Pro-kund (stängs av shouldAutoClose)
    [flags(true, false, true), 'sales'],
    [flags(true, true, false), 'activated'],                // nyss aktiverad → kvitto, inte prislista
    [flags(true, true, true), 'activated'],
];

describe("selectUpsellView", () => {
    it.each(ALL)("%o → %s", (f, expected) => {
        expect(selectUpsellView(f)).toBe(expected);
    });

    it("väntevy kräver alltid ett påbörjat betalförsök", () => {
        for (const [f, view] of ALL) {
            if (view === 'awaiting-confirmation' || view === 'confirmation-stalled') {
                expect(f.paymentAttempted).toBe(true);
                expect(f.isPro).toBe(false);
            }
        }
    });

    it("isWaiting skiljer pollande från stillastående, aldrig något annat", () => {
        expect(selectUpsellView(flags(false, true, true))).toBe('awaiting-confirmation');
        expect(selectUpsellView(flags(false, true, false))).toBe('confirmation-stalled');
    });
});

describe("aktiveringsvyn", () => {
    // Regression. Före activated-vyn gav den här kombinationen 'sales', medan rubriken hade
    // ett EGET villkor som blev sant — så modalen visade "Pro aktiverat!" med grön bock
    // ovanför prislistan och "Uppgradera nu". Det hände vid varje lyckat köp, under de
    // sekunder modalen stod kvar innan den stängde, och i ett kantfall utan att stänga alls.
    // Rubriken läser nu 'activated' ur samma selectUpsellView som kroppen; konflikten är
    // därmed strukturellt omöjlig och behöver inget eget test.
    it("REGRESSION: bekräftad betalning ger kvitto, aldrig säljsida", () => {
        expect(selectUpsellView(flags(true, true, false))).toBe('activated');
        expect(selectUpsellView(flags(true, true, true))).toBe('activated');
    });

    it("återvändande Pro-kund utan betalförsök får inget kvitto", () => {
        expect(selectUpsellView(flags(true, false, false))).toBe('sales');
    });
});

describe("shouldAutoClose", () => {
    it("stänger för återvändande Pro-kund utan betalförsök", () => {
        expect(shouldAutoClose({ ...flags(true, false, false), isOpen: true })).toBe(true);
    });

    it("stänger inte mitt i ett firande", () => {
        expect(shouldAutoClose({ ...flags(true, true, false), isOpen: true })).toBe(false);
    });

    it("gör ingenting när modalen är stängd", () => {
        expect(shouldAutoClose({ ...flags(true, false, false), isOpen: false })).toBe(false);
    });

    it("stänger aldrig för en kund utan Pro", () => {
        for (const [f] of ALL) {
            if (!f.isPro) expect(shouldAutoClose({ ...f, isOpen: true })).toBe(false);
        }
    });
});

describe("shouldCelebrate", () => {
    it("firar en gång när betalningen bekräftats", () => {
        expect(shouldCelebrate({ ...flags(true, true, false), alreadyCelebrated: false })).toBe(true);
    });

    // Utan spärren fyrar varje omrendering av SplitView en ny toast och skjuter
    // stängningen framför sig, eftersom paymentAttempted inte självslocknar.
    it("firar inte om det redan skett", () => {
        expect(shouldCelebrate({ ...flags(true, true, false), alreadyCelebrated: true })).toBe(false);
    });

    it("firar inte för den som fick Pro utan att betala i appen", () => {
        expect(shouldCelebrate({ ...flags(true, false, false), alreadyCelebrated: false })).toBe(false);
    });

    it("firar inte innan servern bekräftat", () => {
        expect(shouldCelebrate({ ...flags(false, true, true), alreadyCelebrated: false })).toBe(false);
    });
});
