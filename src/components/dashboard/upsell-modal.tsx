import { X, Check, CloudLightning, Shield, Loader2, CheckCircle2, Sparkles } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "@/store/auth-store";
import { useConfigStore } from "@/store/config-store";
import { usePaymentRefresh } from "@/hooks/use-payment-refresh";
import { useBrowserAuth } from "@/hooks/use-browser-auth";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface UpsellModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function UpsellModal({ isOpen, onClose }: UpsellModalProps) {
    const userId = useAuthStore((s) => s.userId);
    const isPro = useAuthStore((s) => s.isPro());
    const stripePaymentLink = useConfigStore((s) => s.stripePaymentLink);
    const { isWaiting, startPolling, stopPolling, manualRefresh } = usePaymentRefresh();
    const { startAuth, isAuthenticating } = useBrowserAuth();
    const [pendingUpgrade, setPendingUpgrade] = useState(false);

    // Öppna Stripe-checkout (kräver inloggad userId för kundreferens)
    const openCheckout = async () => {
        const uid = useAuthStore.getState().userId;
        if (!stripePaymentLink || !uid) {
            toast.error("Betalningslänk ej tillgänglig. Försök starta om appen.");
            return;
        }
        try {
            await invoke('plugin:shell|open', { path: `${stripePaymentLink}?client_reference_id=${uid}` });
            startPolling();
        } catch (err) {
            console.error("Failed to open payment link:", err);
        }
    };

    // Pro aktiverat efter betalning → fira och stäng
    useEffect(() => {
        if (isPro && isWaiting) {
            toast.success("Pro aktiverat! Välkommen till Sagt Pro.");
            const t = setTimeout(onClose, 1500);
            return () => clearTimeout(t);
        }
    }, [isPro, isWaiting, onClose]);

    // Återvändande Pro-kund som loggat in (utan pågående betalning) → inget att sälja, stäng
    useEffect(() => {
        if (isOpen && isPro && !isWaiting) onClose();
    }, [isOpen, isPro, isWaiting, onClose]);

    // Inloggning klar efter upgrade-intent → fortsätt automatiskt till Stripe
    useEffect(() => {
        if (pendingUpgrade && userId) {
            setPendingUpgrade(false);
            if (!isPro) openCheckout();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingUpgrade, userId, isPro]);

    // Städa polling när modalen stängs
    useEffect(() => {
        if (!isOpen) stopPolling();
    }, [isOpen, stopPolling]);

    if (!isOpen) return null;

    const handleUpgrade = async () => {
        // Ej inloggad → logga in först (konto krävs för Stripe-kundreferens),
        // fortsätt sedan automatiskt till checkout via pendingUpgrade-effekten.
        if (!userId) {
            setPendingUpgrade(true);
            startAuth();
            return;
        }
        openCheckout();
    };

    // "Har du redan Pro? Logga in" — ren inloggning utan köp-intent
    const handleLoginOnly = () => {
        if (!userId) startAuth();
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/30 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl w-[480px] max-w-[90vw] shadow-2xl border border-line overflow-hidden relative animate-in zoom-in-95 slide-in-from-bottom-4 duration-300">
                {/* Header — solid brand, no gradient */}
                <div className="h-32 bg-brand relative flex items-center justify-center p-6">
                    <button
                        onClick={() => { stopPolling(); onClose(); }}
                        className="absolute top-4 right-4 p-1.5 rounded-full bg-black/20 text-white/80 hover:bg-black/40 hover:text-white transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>

                    <div className="relative z-10 flex flex-col items-center text-white">
                        <div className="w-12 h-12 bg-white/20 backdrop-blur border border-white/30 rounded-full flex items-center justify-center mb-2 shadow-lg">
                            {isPro && isWaiting
                                ? <CheckCircle2 className="w-6 h-6 text-verified" />
                                : <CloudLightning className="w-6 h-6 text-white" />
                            }
                        </div>
                        <h2 className="text-xl font-display font-bold tracking-tight">
                            {isPro && isWaiting ? "Pro aktiverat!" : "Uppgradera till Sagt Pro"}
                        </h2>
                    </div>
                </div>

                <div className="p-8">
                    {isWaiting && !isPro ? (
                        /* Waiting for payment state */
                        <div className="flex flex-col items-center gap-5 py-2 text-center">
                            <div className="relative">
                                <div className="absolute inset-0 bg-brand/20 rounded-full animate-ping opacity-25"></div>
                                <div className="relative w-12 h-12 bg-brand/10 rounded-full flex items-center justify-center">
                                    <Loader2 className="w-6 h-6 animate-spin text-brand" />
                                </div>
                            </div>
                            <div className="space-y-1">
                                <p className="text-sm font-medium text-ink">Betalning öppnad i webbläsaren</p>
                                <p className="text-xs text-ink-muted">Väntar på bekräftelse från Stripe...</p>
                            </div>
                            <button
                                onClick={manualRefresh}
                                className="text-sm font-medium text-brand hover:text-brand-deep underline underline-offset-2"
                            >
                                Jag har betalat — uppdatera nu
                            </button>
                            <button
                                onClick={() => { stopPolling(); onClose(); }}
                                className="text-xs text-ink-muted hover:text-ink-soft"
                            >
                                Avbryt
                            </button>
                        </div>
                    ) : (
                        /* Default / success state */
                        <>
                            <p className="text-sm text-ink-soft text-center mb-6">
                                Marknadens bästa svenska precision + färdiga mötesprotokoll.
                            </p>

                            <div className="bg-paper-dim border border-line rounded-xl p-5 mb-6">
                                <div className="flex items-center justify-between font-semibold text-ink mb-4 pb-4 border-b border-line">
                                    <span>Sagt.ai Pro</span>
                                    <span className="text-brand">199 kr<span className="text-xs text-ink-muted font-normal"> / mån ex. moms</span></span>
                                </div>
                                <ul className="space-y-3">
                                    {/* Ledargument — större modell = högre kvalitet (ryms inte lokalt → moln) */}
                                    <li className="flex items-start gap-3 text-sm text-ink-soft">
                                        <div className="mt-0.5 w-4 h-4 rounded-full bg-verified/10 text-verified flex items-center justify-center flex-shrink-0">
                                            <Sparkles className="w-2.5 h-2.5" />
                                        </div>
                                        KB-Whisper Large — högre precision än vad som ryms lokalt
                                    </li>
                                    <li className="flex items-start gap-3 text-sm text-ink-soft">
                                        <div className="mt-0.5 w-4 h-4 rounded-full bg-verified/10 text-verified flex items-center justify-center flex-shrink-0">
                                            <Check className="w-2.5 h-2.5" />
                                        </div>
                                        AI-mötesprotokoll — sammanfattning, beslut & åtgärder
                                    </li>
                                    <li className="flex items-start gap-3 text-sm text-ink-soft">
                                        <div className="mt-0.5 w-4 h-4 rounded-full bg-verified/10 text-verified flex items-center justify-center flex-shrink-0">
                                            <Check className="w-2.5 h-2.5" />
                                        </div>
                                        Synk mellan enheter
                                    </li>
                                    <li className="flex items-start gap-3 text-sm text-ink-soft">
                                        <div className="mt-0.5 w-4 h-4 rounded-full bg-verified/10 text-verified flex items-center justify-center flex-shrink-0">
                                            <Check className="w-2.5 h-2.5" />
                                        </div>
                                        Avbryt när du vill
                                    </li>
                                </ul>
                                <p className="text-[11px] text-ink-muted text-center mt-4 flex items-center justify-center gap-1.5">
                                    <Shield className="w-3 h-3 flex-shrink-0" />
                                    Körs på EU-servrar i Sverige. Ljud raderas automatiskt inom 24 h.
                                </p>
                            </div>

                            <div className="flex gap-3">
                                <button
                                    onClick={() => { stopPolling(); onClose(); }}
                                    className="flex-1 py-2.5 px-4 rounded-lg bg-white border border-line text-sm font-medium text-ink-soft hover:bg-paper-dim transition-colors"
                                >
                                    Avbryt
                                </button>
                                <button
                                    onClick={handleUpgrade}
                                    disabled={isAuthenticating}
                                    className="flex-[2] py-2.5 px-4 rounded-lg bg-brand border border-brand text-sm font-semibold text-paper hover:bg-brand-deep hover:border-brand-deep shadow-sm transition-colors disabled:opacity-70 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                >
                                    {isAuthenticating ? (
                                        <><Loader2 className="w-4 h-4 animate-spin" /> Loggar in...</>
                                    ) : (
                                        "Uppgradera nu"
                                    )}
                                </button>
                            </div>

                            {!userId && (
                                <button
                                    onClick={handleLoginOnly}
                                    disabled={isAuthenticating}
                                    className="mt-3 w-full text-center text-xs text-ink-muted hover:text-ink-soft transition-colors disabled:opacity-50"
                                >
                                    Har du redan Pro? Logga in
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
