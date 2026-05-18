import { X, Check, CloudLightning, Shield, Loader2, CheckCircle2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "@/store/auth-store";
import { useConfigStore } from "@/store/config-store";
import { usePaymentRefresh } from "@/hooks/use-payment-refresh";
import { useEffect } from "react";
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

    // Auto-close and toast when Pro is activated
    useEffect(() => {
        if (isPro && isWaiting) {
            toast.success("Pro aktiverat! Välkommen till Sagt Pro.");
            const t = setTimeout(onClose, 1500);
            return () => clearTimeout(t);
        }
    }, [isPro, isWaiting, onClose]);

    // Clean up polling when modal closes
    useEffect(() => {
        if (!isOpen) stopPolling();
    }, [isOpen, stopPolling]);

    if (!isOpen) return null;

    const handleUpgrade = async () => {
        try {
            if (stripePaymentLink && userId) {
                await invoke('plugin:shell|open', { path: `${stripePaymentLink}?client_reference_id=${userId}` });
                startPolling();
            } else {
                toast.error("Betalningslänk ej tillgänglig. Försök starta om appen.");
            }
        } catch (err) {
            console.error("Failed to open payment link:", err);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl w-[480px] max-w-[90vw] shadow-2xl border border-slate-100 overflow-hidden relative animate-in zoom-in-95 slide-in-from-bottom-4 duration-300">
                {/* Header Graphic */}
                <div className="h-32 bg-gradient-to-br from-indigo-500 to-purple-600 relative flex items-center justify-center p-6 overflow-hidden">
                    <div className="absolute top-0 right-0 -translate-y-1/2 translate-x-1/3 w-48 h-48 bg-white/10 rounded-full blur-2xl"></div>
                    <div className="absolute bottom-0 left-0 translate-y-1/3 -translate-x-1/4 w-32 h-32 bg-white/10 rounded-full blur-xl"></div>

                    <button
                        onClick={() => { stopPolling(); onClose(); }}
                        className="absolute top-4 right-4 p-1.5 rounded-full bg-black/20 text-white/80 hover:bg-black/40 hover:text-white transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>

                    <div className="relative z-10 flex flex-col items-center text-white">
                        <div className="w-12 h-12 bg-white/20 backdrop-blur border border-white/30 rounded-full flex items-center justify-center mb-2 shadow-lg">
                            {isPro && isWaiting
                                ? <CheckCircle2 className="w-6 h-6 text-emerald-300" />
                                : <CloudLightning className="w-6 h-6 text-white" />
                            }
                        </div>
                        <h2 className="text-xl font-bold tracking-tight">
                            {isPro && isWaiting ? "Pro aktiverat!" : "Uppgradera till Pro"}
                        </h2>
                    </div>
                </div>

                <div className="p-8">
                    {isWaiting && !isPro ? (
                        /* Waiting for payment state */
                        <div className="flex flex-col items-center gap-5 py-2 text-center">
                            <div className="relative">
                                <div className="absolute inset-0 bg-indigo-200 rounded-full animate-ping opacity-25"></div>
                                <div className="relative w-12 h-12 bg-indigo-50 rounded-full flex items-center justify-center">
                                    <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
                                </div>
                            </div>
                            <div className="space-y-1">
                                <p className="text-sm font-medium text-slate-900">Betalning öppnad i webbläsaren</p>
                                <p className="text-xs text-slate-500">Väntar på bekräftelse från Stripe...</p>
                            </div>
                            <button
                                onClick={manualRefresh}
                                className="text-sm font-medium text-indigo-600 hover:text-indigo-800 underline underline-offset-2"
                            >
                                Jag har betalat — uppdatera nu
                            </button>
                            <button
                                onClick={() => { stopPolling(); onClose(); }}
                                className="text-xs text-slate-400 hover:text-slate-600"
                            >
                                Avbryt
                            </button>
                        </div>
                    ) : (
                        /* Default / success state */
                        <>
                            <p className="text-sm text-slate-600 text-center mb-6">
                                Molnbearbetning med Berget.ai (Whisper Large) kräver ett Pro-konto. Få överlägsen precision och automatisk sammanfattning.
                            </p>

                            <div className="bg-slate-50 border border-slate-100 rounded-xl p-5 mb-6">
                                <div className="flex items-center justify-between font-semibold text-slate-900 mb-4 pb-4 border-b border-slate-200/60">
                                    <span>Sagt.ai Pro</span>
                                    <span className="text-indigo-600">199 kr<span className="text-xs text-slate-500 font-normal"> / mån</span></span>
                                </div>
                                <ul className="space-y-3">
                                    <li className="flex items-start gap-3 text-sm text-slate-700">
                                        <div className="mt-0.5 w-4 h-4 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center flex-shrink-0">
                                            <Check className="w-2.5 h-2.5" />
                                        </div>
                                        Berget.ai Whisper Large (Svensk tränad AI)
                                    </li>
                                    <li className="flex items-start gap-3 text-sm text-slate-700">
                                        <div className="mt-0.5 w-4 h-4 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center flex-shrink-0">
                                            <Check className="w-2.5 h-2.5" />
                                        </div>
                                        Automatiska insikter (Sammanfattning, Beslut, Åtgärder)
                                    </li>
                                    <li className="flex items-start gap-3 text-sm text-slate-700">
                                        <div className="mt-0.5 w-4 h-4 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center flex-shrink-0">
                                            <Check className="w-2.5 h-2.5" />
                                        </div>
                                        Synk av dina inspelningar till molnet
                                    </li>
                                    <li className="flex items-start gap-3 text-sm text-slate-700">
                                        <div className="mt-0.5 w-4 h-4 rounded-full bg-slate-200 text-slate-500 flex items-center justify-center flex-shrink-0">
                                            <Shield className="w-2.5 h-2.5" />
                                        </div>
                                        100% Data Sovereignty inom EU
                                    </li>
                                </ul>
                            </div>

                            <div className="flex gap-3">
                                <button
                                    onClick={() => { stopPolling(); onClose(); }}
                                    className="flex-1 py-2.5 px-4 rounded-lg bg-white border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                                >
                                    Avbryt
                                </button>
                                <button
                                    onClick={handleUpgrade}
                                    className="flex-[2] py-2.5 px-4 rounded-lg bg-indigo-600 border border-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 hover:border-indigo-700 shadow-sm transition-colors"
                                >
                                    Uppgradera nu
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
