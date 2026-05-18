import { useEffect, useState } from "react";
import { CURRENT_VERSION } from "@/lib/version";
import { Slider } from "@/components/ui/slider";
import { useSettingsStore, TranscriptionLanguage } from "@/store/settings-store";
import { useAudioAmplitude } from "@/hooks/use-audio-amplitude";
import { Cpu, Cloud, Sparkles, HardDrive, Lock, Mic, Languages, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "@/store/auth-store";
import { useConfigStore } from "@/store/config-store";
import { toast } from "sonner";


const VAD_PRESETS = [
    { label: "Tyst rum",   threshold: 0.005, silence: 1000 },
    { label: "Normal",     threshold: 0.008, silence: 1200 },
    { label: "Bullrig",    threshold: 0.020, silence: 1500 },
] as const;

export function SettingsPage() {
    const {
        vadThreshold,
        silenceDuration,
        retentionPolicy,
        setVadThreshold,
        setSilenceDuration,
        setRetentionPolicy,
        resetDefaults,
        inputDevice,
        setInputDevice,
        recordingMode,
        setRecordingMode,
        transcriptionLanguage,
        setTranscriptionLanguage,
    } = useSettingsStore();

    const isPro = useAuthStore((s) => s.isPro());
    const monthlyLimit = useAuthStore((s) => s.monthlyMinutesLimit);
    const userId = useAuthStore((s) => s.userId);
    const stripePaymentLink = useConfigStore((s) => s.stripePaymentLink);

    const [availableDevices, setAvailableDevices] = useState<{ name: string, is_default: boolean }[]>([]);
    const [showAdvancedVad, setShowAdvancedVad] = useState(false);

    useEffect(() => {
        invoke<{ name: string, is_default: boolean }[]>("get_audio_devices")
            .then(setAvailableDevices)
            .catch(console.error);
    }, []);

    const amplitude = useAudioAmplitude();

    useEffect(() => {
        const timer = setTimeout(() => {
            invoke("update_audio_settings", {
                threshold: vadThreshold,
                silenceMs: silenceDuration,
                language: transcriptionLanguage,
            }).catch(console.error);
        }, 200);
        return () => clearTimeout(timer);
    }, [vadThreshold, silenceDuration, transcriptionLanguage]);

    const activePreset = VAD_PRESETS.find(
        p => p.threshold === vadThreshold && p.silence === silenceDuration
    );

    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-y-auto">
            <header className="px-8 py-6 border-b bg-white">
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Inställningar</h1>
                <p className="text-muted-foreground mt-1">Konfigurera ljud, modeller och beteende.</p>
            </header>

            <div className="p-8 max-w-2xl space-y-10">

                {/* Audio Engine Settings */}
                <section className="space-y-6">
                    <div className="flex items-center gap-2 mb-4">
                        <Mic className="text-primary w-5 h-5" />
                        <h2 className="text-lg font-semibold text-slate-800">Ljud</h2>
                    </div>

                    {/* Device Selection */}
                    <div className="bg-white p-6 rounded-lg border shadow-sm space-y-4">
                        <div className="space-y-3">
                            <label className="text-sm font-medium text-slate-700">Mikrofon</label>
                            <select
                                value={inputDevice || ""}
                                onChange={(e) => {
                                    setInputDevice(e.target.value || null);
                                    invoke("init_audio_engine", { device: e.target.value || null }).catch(console.error);
                                }}
                                className="flex h-10 w-full items-center justify-between rounded-md border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <option value="">Standardenhet (System)</option>
                                {availableDevices.map((d) => (
                                    <option key={d.name} value={d.name}>
                                        {d.name} {d.is_default ? "(Standard)" : ""}
                                    </option>
                                ))}
                            </select>
                            <p className="text-xs text-muted-foreground">
                                Välj rätt mikrofon för att undvika tystnad. Ändring startar om ljudmotorn.
                            </p>
                        </div>

                        {/* Visualizer */}
                        <div className="space-y-3 pt-2 border-t">
                            <div className="flex justify-between items-center">
                                <label className="text-sm font-medium text-slate-700">Mikrofon-test</label>
                                <span className="text-xs font-mono text-muted-foreground">
                                    Nivå: {(amplitude.mic * 100).toFixed(1)}%
                                </span>
                            </div>
                            <div className="relative h-6 bg-slate-100 rounded-full overflow-hidden w-full">
                                <div
                                    className="absolute top-0 bottom-0 left-0 bg-green-500 transition-all duration-75 ease-out"
                                    style={{ width: `${Math.min(amplitude.mic * 500, 100)}%` }}
                                />
                                <div
                                    className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10"
                                    style={{ left: `${Math.min(vadThreshold * 500, 100)}%` }}
                                    title="Nuvarande tröskel"
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Den röda linjen visar din tröskel. Prata normalt — stapeln ska gå över linjen. Tyst — stapeln ska vara under.
                            </p>
                        </div>

                        {/* VAD Presets */}
                        <div className="space-y-3 pt-2 border-t">
                            <label className="text-sm font-medium text-slate-700">Mikrofon-känslighet</label>
                            <div className="grid grid-cols-3 gap-3">
                                {VAD_PRESETS.map((preset) => (
                                    <button
                                        key={preset.label}
                                        onClick={() => { setVadThreshold(preset.threshold); setSilenceDuration(preset.silence); }}
                                        className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${
                                            activePreset?.label === preset.label
                                                ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                                        }`}
                                    >
                                        {preset.label === "Tyst rum" ? "🔇" : preset.label === "Normal" ? "🗣️" : "🔊"} {preset.label}
                                    </button>
                                ))}
                            </div>

                            {/* Advanced toggle */}
                            <button
                                onClick={() => setShowAdvancedVad(v => !v)}
                                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-slate-700 transition-colors mt-1"
                            >
                                {showAdvancedVad ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                Avancerade inställningar
                            </button>

                            {showAdvancedVad && (
                                <div className="grid gap-6 pt-2">
                                    <div className="space-y-3">
                                        <div className="flex justify-between">
                                            <label className="text-sm font-medium">Känslighet (Threshold)</label>
                                            <span className="text-sm font-mono bg-slate-100 px-2 py-0.5 rounded">
                                                {vadThreshold.toFixed(4)}
                                            </span>
                                        </div>
                                        <Slider
                                            value={[vadThreshold]}
                                            min={0.001}
                                            max={0.1}
                                            step={0.001}
                                            onValueChange={(val) => setVadThreshold(val[0])}
                                        />
                                    </div>
                                    <div className="space-y-3">
                                        <div className="flex justify-between">
                                            <label className="text-sm font-medium">Paus-tolerans</label>
                                            <span className="text-sm font-mono bg-slate-100 px-2 py-0.5 rounded">
                                                {silenceDuration} ms
                                            </span>
                                        </div>
                                        <Slider
                                            value={[silenceDuration]}
                                            min={500}
                                            max={3000}
                                            step={100}
                                            onValueChange={(val) => setSilenceDuration(val[0])}
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </section>

                {/* Model Settings */}
                <section className="space-y-6">
                    <div className="flex items-center gap-2 mb-4">
                        <Cpu className="text-primary w-5 h-5" />
                        <h2 className="text-lg font-semibold text-slate-800">AI Modell</h2>
                    </div>

                    <div className="bg-white p-6 rounded-lg border shadow-sm space-y-4">
                        {/* Lokal Modell */}
                        <div className="p-4 bg-slate-50 border border-slate-100 rounded-lg flex gap-4 items-center">
                            <div className="p-2 bg-white rounded-full h-fit border border-slate-200 shadow-sm flex-shrink-0">
                                <Cpu className="w-5 h-5 text-slate-600" />
                            </div>
                            <div className="space-y-0.5">
                                <h3 className="font-semibold text-slate-900">Lokal (Gratis)</h3>
                                <p className="text-sm text-slate-600 leading-relaxed">
                                    Snabb transkribering direkt på din dator. Fungerar offline.
                                </p>
                            </div>
                        </div>

                        {/* Moln Modell */}
                        <div className={`p-4 border rounded-lg flex gap-4 items-center ${isPro ? 'bg-indigo-50 border-indigo-100' : 'bg-slate-50 border-slate-200 opacity-70'}`}>
                            <div className={`p-2 rounded-full h-fit border shadow-sm flex-shrink-0 ${isPro ? 'bg-white border-indigo-100' : 'bg-white border-slate-200'}`}>
                                {isPro ? <Cloud className="w-5 h-5 text-indigo-600" /> : <Lock className="w-5 h-5 text-slate-400" />}
                            </div>
                            <div className="space-y-0.5 flex-1">
                                <h3 className={`font-semibold ${isPro ? 'text-indigo-900' : 'text-slate-700'}`}>Moln (Pro)</h3>
                                <p className={`text-sm leading-relaxed ${isPro ? 'text-indigo-700' : 'text-slate-500'}`}>
                                    Högre noggrannhet via molnet. Bäst för möten och intervjuer.
                                </p>
                            </div>
                            {isPro && (
                                <div className="text-right flex-shrink-0">
                                    <div className="text-xs text-indigo-600 font-medium">{monthlyLimit} min/mån</div>
                                    <div className="text-xs text-slate-400">ingår i Pro</div>
                                </div>
                            )}
                        </div>

                        {/* Language Selection */}
                        <div className="border-t pt-4 space-y-3">
                            <div className="flex items-center gap-2">
                                <Languages className="w-4 h-4 text-slate-500" />
                                <label className="text-sm font-medium text-slate-700">Inspelningsspråk</label>
                            </div>
                            <div className="grid grid-cols-3 gap-3">
                                {([
                                    { value: 'sv', flag: '🇸🇪', label: 'Svenska',  desc: 'Optimerad för svenska' },
                                    { value: 'no', flag: '🇳🇴', label: 'Norska',   desc: 'Optimerad för norska' },
                                    { value: 'en', flag: '🇬🇧', label: 'Engelska', desc: 'Flerspråkig (OpenAI)' },
                                ] as { value: TranscriptionLanguage; flag: string; label: string; desc: string }[]).map(({ value, flag, label, desc }) => (
                                    <button
                                        key={value}
                                        onClick={() => setTranscriptionLanguage(value)}
                                        className={`px-3 py-3 rounded-lg border text-left transition-all ${
                                            transcriptionLanguage === value
                                                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                                : 'border-slate-200 bg-white hover:bg-slate-50'
                                        }`}
                                    >
                                        <div className="text-sm font-medium text-slate-800">{flag} {label}</div>
                                        <div className="text-xs text-slate-400 mt-0.5">{desc}</div>
                                    </button>
                                ))}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Välj språket du spelar in på. Påverkar vilken AI-modell som används i molnet.
                            </p>
                        </div>
                    </div>
                </section>

                {/* Cloud & Sync Settings */}
                <section className="space-y-6">
                    <div className="flex items-center gap-2 mb-4">
                        <Cloud className="text-primary w-5 h-5" />
                        <h2 className="text-lg font-semibold text-slate-800">Cloud & Sync</h2>
                    </div>

                    <div className="bg-white p-6 rounded-lg border shadow-sm space-y-6">

                        {/* Standard Inspelningsläge */}
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <div>
                                    <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                                        Standard Inspelningsläge
                                        {!isPro && <Lock className="w-3.5 h-3.5 text-amber-500" />}
                                    </h3>
                                    <p className="text-xs text-muted-foreground mt-1">Välj hur dina inspelningar hanteras som standard.</p>
                                </div>
                                {!isPro && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 text-xs text-primary border-primary/20 bg-primary/5 hover:bg-primary/10"
                                        onClick={async () => {
                                            if (stripePaymentLink && userId) {
                                                const { invoke } = await import('@tauri-apps/api/core');
                                                invoke('plugin:shell|open', { path: `${stripePaymentLink}?client_reference_id=${userId}` });
                                            } else {
                                                toast.error("Betalningslänk ej tillgänglig. Försök starta om appen.");
                                            }
                                        }}
                                    >
                                        <Sparkles className="w-3 h-3 mr-1" />
                                        Uppgradera till Pro
                                    </Button>
                                )}
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                                <button
                                    onClick={() => setRecordingMode('cloud')}
                                    disabled={!isPro}
                                    className={`relative p-4 rounded-xl border text-left flex flex-col items-center justify-center transition-all ${(recordingMode === 'cloud' || recordingMode === 'cloud_analysis')
                                        ? 'border-blue-600 bg-blue-50/50 shadow-sm ring-1 ring-blue-600'
                                        : 'border-slate-200 bg-white hover:border-blue-300 hover:bg-slate-50'
                                    } ${!isPro ? 'opacity-70 grayscale cursor-not-allowed' : ''}`}
                                >
                                    <div className={`p-2 rounded-full mb-3 ${(recordingMode === 'cloud' || recordingMode === 'cloud_analysis') ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>
                                        <Cloud className="w-5 h-5" />
                                    </div>
                                    <h4 className={`text-sm font-bold mb-1 text-center ${(recordingMode === 'cloud' || recordingMode === 'cloud_analysis') ? 'text-blue-900' : 'text-slate-800'}`}>
                                        Moln
                                    </h4>
                                    <p className="text-xs text-center text-slate-500 line-clamp-2">Perfekt transkription. Ingen automatisk sammanfattning.</p>
                                    {!isPro && <Lock className="absolute top-3 right-3 w-4 h-4 text-slate-400" />}
                                </button>

                                <button
                                    onClick={() => setRecordingMode('local')}
                                    className={`relative p-4 rounded-xl border text-left flex flex-col items-center justify-center transition-all ${recordingMode === 'local'
                                        ? 'border-slate-600 bg-slate-100 shadow-sm ring-1 ring-slate-600'
                                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                                    }`}
                                >
                                    <div className={`p-2 rounded-full mb-3 ${recordingMode === 'local' ? 'bg-slate-200 text-slate-700' : 'bg-slate-100 text-slate-500'}`}>
                                        <HardDrive className="w-5 h-5" />
                                    </div>
                                    <h4 className={`text-sm font-bold mb-1 text-center ${recordingMode === 'local' ? 'text-slate-900' : 'text-slate-800'}`}>
                                        Lokal
                                    </h4>
                                    <p className="text-xs text-center text-slate-500 line-clamp-2">Ljudet lämnar aldrig din dator. Extremt säkert.</p>
                                </button>
                            </div>
                        </div>

                        {/* Lagring */}
                        <div className="border-t pt-6 space-y-3">
                            <div>
                                <label className="text-sm font-medium text-slate-900">Lagring av ljudfiler</label>
                                <p className="text-xs text-muted-foreground">Hur länge ljudfiler sparas i molnet efter analys.</p>
                            </div>

                            <div className="grid grid-cols-3 gap-3">
                                {([
                                    { value: '24h',              label: '24 timmar' },
                                    { value: 'immediate_delete', label: 'Radera efter analys' },
                                    { value: 'keep',             label: 'Spara alltid' },
                                ] as { value: typeof retentionPolicy; label: string }[]).map(({ value, label }) => (
                                    <button
                                        key={value}
                                        onClick={() => setRetentionPolicy(value)}
                                        className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${retentionPolicy === value
                                            ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                                        }`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </section>

                <div className="flex items-center justify-between pt-4">
                    <span className="text-xs text-slate-400">Sagt.ai v{CURRENT_VERSION}</span>
                    <Button variant="outline" onClick={resetDefaults} className="text-red-600 hover:text-red-700 hover:bg-red-50">
                        Återställ till standardvärden
                    </Button>
                </div>
            </div>
        </div>
    );
}
