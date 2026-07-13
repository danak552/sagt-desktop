import { useEffect, useState } from "react";
import { CURRENT_VERSION } from "@/lib/version";
import { Slider } from "@/components/ui/slider";
import { useSettingsStore, TranscriptionLanguage, LocalAudioRetention } from "@/store/settings-store";
import { getStorageUsage, runStorageCleanup, formatBytes, type StorageUsage } from "@/lib/storage";
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
        cloudSync,
        setCloudSync,
        transcriptionLanguage,
        setTranscriptionLanguage,
        cloudDiarizationMode,
        setCloudDiarizationMode,
        pauseBreakMs,
        setPauseBreakMs,
        micIsSingleSpeaker,
        setMicIsSingleSpeaker,
        autoDiarize,
        setAutoDiarize,
        autoAnalyze,
        setAutoAnalyze,
        localAudioRetention,
        setLocalAudioRetention,
    } = useSettingsStore();

    const isPro = useAuthStore((s) => s.isPro());
    const monthlyLimit = useAuthStore((s) => s.monthlyMinutesLimit);
    const userId = useAuthStore((s) => s.userId);
    const stripePaymentLink = useConfigStore((s) => s.stripePaymentLink);

    const [availableDevices, setAvailableDevices] = useState<{ name: string, is_default: boolean }[]>([]);
    const [showAdvancedVad, setShowAdvancedVad] = useState(false);
    const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);

    useEffect(() => {
        invoke<{ name: string, is_default: boolean }[]>("get_audio_devices")
            .then(setAvailableDevices)
            .catch(console.error);
        getStorageUsage().then(setStorageUsage).catch(console.error);
    }, []);

    // Vid val av raderande policy: bekräfta, gallra direkt och visa frigjort utrymme.
    const handleLocalRetentionChange = async (policy: LocalAudioRetention) => {
        if (policy !== 'keep_all' && policy !== localAudioRetention) {
            const description: Record<Exclude<LocalAudioRetention, 'keep_all'>, string> = {
                days_30: "ljudfiler äldre än 30 dagar raderas",
                days_90: "ljudfiler äldre än 90 dagar raderas",
                gb_10: "de äldsta ljudfilerna raderas när totalen överstiger 10 GB",
            };
            const ok = confirm(
                `Med denna gallringspolicy ${description[policy]} — nu och automatiskt framöver. ` +
                `Transkript och analyser behålls alltid. Vill du fortsätta?`
            );
            if (!ok) return;
        }
        setLocalAudioRetention(policy);
        if (policy === 'keep_all') return;
        try {
            const result = await runStorageCleanup();
            if (result && result.deleted_count > 0) {
                toast.success(`Frigjorde ${formatBytes(result.freed_bytes)} (${result.deleted_count} ljudfiler).`);
            } else {
                toast.info("Inga ljudfiler behövde gallras.");
            }
            setStorageUsage(await getStorageUsage());
        } catch (error) {
            console.error("Gallring misslyckades:", error);
            toast.error("Gallringen misslyckades: " + String(error));
        }
    };

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
        <div className="flex flex-col h-full bg-paper-dim overflow-y-auto">
            <header className="px-8 py-6 border-b bg-white">
                <h1 className="text-2xl font-display font-bold tracking-tight text-ink">Inställningar</h1>
                <p className="text-muted-foreground mt-1">Konfigurera ljud, modeller och beteende.</p>
            </header>

            <div className="p-8 max-w-2xl space-y-10">

                {/* Audio Engine Settings */}
                <section className="space-y-6">
                    <div className="flex items-center gap-2 mb-4">
                        <Mic className="text-primary w-5 h-5" />
                        <h2 className="text-lg font-display font-semibold text-ink">Ljud</h2>
                    </div>

                    {/* Device Selection */}
                    <div className="bg-white p-6 rounded-lg border shadow-sm space-y-4">
                        <div className="space-y-3">
                            <label className="text-sm font-medium text-ink-soft">Mikrofon</label>
                            <select
                                value={inputDevice || ""}
                                onChange={(e) => {
                                    setInputDevice(e.target.value || null);
                                    invoke("init_audio_engine", { device: e.target.value || null }).catch(console.error);
                                }}
                                className="flex h-10 w-full items-center justify-between rounded-md border border-line bg-white px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <option value="">Standardenhet (system)</option>
                                {availableDevices.map((d) => (
                                    <option key={d.name} value={d.name}>
                                        {d.name} {d.is_default ? "(Standard)" : ""}
                                    </option>
                                ))}
                            </select>
                            <p className="text-xs text-muted-foreground">
                                Välj rätt mikrofon för att undvika tystnad. Bytet tar effekt inom ett par sekunder.
                            </p>
                        </div>

                        {/* Visualizer */}
                        <div className="space-y-3 pt-2 border-t">
                            <div className="flex justify-between items-center">
                                <label className="text-sm font-medium text-ink-soft">Mikrofontest</label>
                                <span className="text-xs font-mono text-muted-foreground">
                                    Nivå: {(amplitude.mic * 100).toFixed(1)}%
                                </span>
                            </div>
                            <div className="relative h-6 bg-paper-dim rounded-full overflow-hidden w-full">
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
                            <label className="text-sm font-medium text-ink-soft">Mikrofonkänslighet</label>
                            <div className="grid grid-cols-3 gap-3">
                                {VAD_PRESETS.map((preset) => (
                                    <button
                                        key={preset.label}
                                        onClick={() => { setVadThreshold(preset.threshold); setSilenceDuration(preset.silence); }}
                                        className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${
                                            activePreset?.label === preset.label
                                                ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                                : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
                                        }`}
                                    >
                                        {preset.label === "Tyst rum" ? "🔇" : preset.label === "Normal" ? "🗣️" : "🔊"} {preset.label}
                                    </button>
                                ))}
                            </div>

                            {/* Advanced toggle */}
                            <button
                                onClick={() => setShowAdvancedVad(v => !v)}
                                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-ink-soft transition-colors mt-1"
                            >
                                {showAdvancedVad ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                Avancerade inställningar
                            </button>

                            {showAdvancedVad && (
                                <div className="grid gap-6 pt-2">
                                    <div className="space-y-3">
                                        <div className="flex justify-between">
                                            <label className="text-sm font-medium">Känslighet (tröskel)</label>
                                            <span className="text-sm font-mono bg-paper-dim px-2 py-0.5 rounded">
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
                                            <label className="text-sm font-medium">Paustolerans</label>
                                            <span className="text-sm font-mono bg-paper-dim px-2 py-0.5 rounded">
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
                        <h2 className="text-lg font-display font-semibold text-ink">AI-modell</h2>
                    </div>

                    <div className="bg-white p-6 rounded-lg border shadow-sm space-y-4">
                        {/* Lokal Modell */}
                        <div className="p-4 bg-paper-dim border border-line rounded-lg flex gap-4 items-center">
                            <div className="p-2 bg-white rounded-full h-fit border border-line shadow-sm flex-shrink-0">
                                <Cpu className="w-5 h-5 text-ink-soft" />
                            </div>
                            <div className="space-y-0.5">
                                <h3 className="font-semibold text-ink">Lokal (Gratis)</h3>
                                <p className="text-sm text-ink-soft leading-relaxed">
                                    Snabb transkribering direkt på din dator. Fungerar offline.
                                </p>
                            </div>
                        </div>

                        {/* Moln Modell */}
                        <div className={`p-4 border rounded-lg flex gap-4 items-center ${isPro ? 'bg-brand/5 border-brand/10' : 'bg-paper-dim border-line opacity-70'}`}>
                            <div className={`p-2 rounded-full h-fit border shadow-sm flex-shrink-0 ${isPro ? 'bg-white border-brand/10' : 'bg-white border-line'}`}>
                                {isPro ? <Cloud className="w-5 h-5 text-brand" /> : <Lock className="w-5 h-5 text-ink-muted" />}
                            </div>
                            <div className="space-y-0.5 flex-1">
                                <h3 className={`font-semibold ${isPro ? 'text-brand' : 'text-ink-soft'}`}>Moln (Pro)</h3>
                                <p className={`text-sm leading-relaxed ${isPro ? 'text-brand/80' : 'text-ink-muted'}`}>
                                    Högre noggrannhet via molnet. Bäst för möten och intervjuer.
                                </p>
                            </div>
                            {isPro && (
                                <div className="text-right flex-shrink-0">
                                    <div className="text-xs text-brand font-medium">{monthlyLimit} min/mån</div>
                                    <div className="text-xs text-ink-muted">ingår i Pro</div>
                                </div>
                            )}
                        </div>

                        {/* Molntranskribering — struktur (endast Pro, styr live-strömning) */}
                        {isPro && (
                            <div className="border-t pt-4 space-y-4">
                                <div className="space-y-1">
                                    <label className="text-sm font-medium text-ink-soft">Molntranskribering — struktur</label>
                                    <p className="text-xs text-muted-foreground">
                                        Hur talare visas under livetranskribering i molnet.
                                    </p>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <button
                                        onClick={() => setCloudDiarizationMode('structured')}
                                        className={`px-3 py-3 rounded-lg border text-left transition-all ${
                                            cloudDiarizationMode === 'structured'
                                                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                                : 'border-line bg-white hover:bg-paper-dim'
                                        }`}
                                    >
                                        <div className="text-sm font-medium text-ink">🗣️ Du / Mötet</div>
                                        <div className="text-xs text-ink-muted mt-0.5">Separata talare. ~2× minuter. Bäst "vem sa vad".</div>
                                    </button>
                                    <button
                                        onClick={() => setCloudDiarizationMode('merged')}
                                        className={`px-3 py-3 rounded-lg border text-left transition-all ${
                                            cloudDiarizationMode === 'merged'
                                                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                                : 'border-line bg-white hover:bg-paper-dim'
                                        }`}
                                    >
                                        <div className="text-sm font-medium text-ink">📄 Sammanhängande</div>
                                        <div className="text-xs text-ink-muted mt-0.5">Ett stycke, styckesbryt vid pauser. 1× minuter.</div>
                                    </button>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    Du/Mötet transkriberar båda kanalerna separat (räknas dubbelt mot din månadsgräns) och är robustare vid överhörning. Sammanhängande mixar till ett spår (1×).
                                </p>

                                {/* Pausbryt-tröskel — gäller båda lägena, härleds ur talpaus */}
                                <div className="space-y-3 pt-1">
                                    <div className="flex justify-between">
                                        <label className="text-sm font-medium text-ink-soft">Styckesbryt vid paus</label>
                                        <span className="text-sm font-mono bg-paper-dim px-2 py-0.5 rounded">
                                            {(pauseBreakMs / 1000).toFixed(1)} s
                                        </span>
                                    </div>
                                    <Slider
                                        value={[pauseBreakMs]}
                                        min={silenceDuration}
                                        max={5000}
                                        step={100}
                                        onValueChange={(val) => setPauseBreakMs(val[0])}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        En talpaus längre än detta ger ett nytt stycke (och extra luft i Du/Mötet-vyn).
                                    </p>
                                </div>

                                {/* §13.4 mic-kanal-hint — en talare vid mikrofonen (default på) */}
                                <div className="space-y-3 pt-1">
                                    <div>
                                        <label className="text-sm font-medium text-ink-soft">Bara jag talar i mikrofonen</label>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            <strong>På</strong> (standard): din mikrofonkanal behandlas som en enda talare — hindrar att du delas upp i "Du 1" och "Du 2".
                                            <strong> Av</strong>: slå av om ni är flera som delar samma mikrofon.
                                        </p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        {([
                                            { value: true, label: '👤 På — en talare' },
                                            { value: false, label: '👥 Av — flera talare' },
                                        ] as { value: boolean; label: string }[]).map(({ value, label }) => (
                                            <button
                                                key={String(value)}
                                                onClick={() => setMicIsSingleSpeaker(value)}
                                                className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${micIsSingleSpeaker === value
                                                    ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                                    : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
                                                }`}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* §steg 5 — automatik efter möte (opt-out, default på) */}
                                <div className="space-y-3 pt-1">
                                    <div>
                                        <label className="text-sm font-medium text-ink-soft">Automatisk talarseparering efter möte</label>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            <strong>På</strong> (standard): Mötet-kanalen delas i Talare 1/2/3 automatiskt när du stoppar inspelningen.
                                            <strong> Av</strong>: kör talarsepareringen manuellt via knappen i transkriptet.
                                        </p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        {([
                                            { value: true, label: '✅ På — automatiskt' },
                                            { value: false, label: '✋ Av — manuellt' },
                                        ] as { value: boolean; label: string }[]).map(({ value, label }) => (
                                            <button
                                                key={String(value)}
                                                onClick={() => setAutoDiarize(value)}
                                                className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${autoDiarize === value
                                                    ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                                    : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
                                                }`}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="space-y-3 pt-1">
                                    <div>
                                        <label className="text-sm font-medium text-ink-soft">Automatisk analys efter möte</label>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            <strong>På</strong> (standard): AI-analysen (sammanfattning, beslut, åtgärder) startar automatiskt när du stoppar inspelningen i molnläge.
                                            <strong> Av</strong>: starta analysen manuellt i transkriptet.
                                        </p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        {([
                                            { value: true, label: '✅ På — automatiskt' },
                                            { value: false, label: '✋ Av — manuellt' },
                                        ] as { value: boolean; label: string }[]).map(({ value, label }) => (
                                            <button
                                                key={String(value)}
                                                onClick={() => setAutoAnalyze(value)}
                                                className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${autoAnalyze === value
                                                    ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                                    : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
                                                }`}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Language Selection */}
                        <div className="border-t pt-4 space-y-3">
                            <div className="flex items-center gap-2">
                                <Languages className="w-4 h-4 text-ink-muted" />
                                <label className="text-sm font-medium text-ink-soft">Inspelningsspråk</label>
                            </div>
                            <div className="grid grid-cols-3 gap-3">
                                {([
                                    { value: 'sv', flag: '🇸🇪', label: 'Svenska',  desc: 'Optimerad för svenska' },
                                    { value: 'no', flag: '🇳🇴', label: 'Norska',   desc: 'Optimerad för norska' },
                                    { value: 'en', flag: '🇬🇧', label: 'Engelska', desc: 'Flerspråkig' },
                                ] as { value: TranscriptionLanguage; flag: string; label: string; desc: string }[]).map(({ value, flag, label, desc }) => (
                                    <button
                                        key={value}
                                        onClick={() => setTranscriptionLanguage(value)}
                                        className={`px-3 py-3 rounded-lg border text-left transition-all ${
                                            transcriptionLanguage === value
                                                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                                : 'border-line bg-white hover:bg-paper-dim'
                                        }`}
                                    >
                                        <div className="text-sm font-medium text-ink">{flag} {label}</div>
                                        <div className="text-xs text-ink-muted mt-0.5">{desc}</div>
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
                        <h2 className="text-lg font-display font-semibold text-ink">Moln & synk</h2>
                    </div>

                    <div className="bg-white p-6 rounded-lg border shadow-sm space-y-6">

                        {/* Standard Inspelningsläge */}
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <div>
                                    <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                                        Standardläge för inspelning
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
                                        : 'border-line bg-white hover:border-blue-300 hover:bg-paper-dim'
                                    } ${!isPro ? 'opacity-70 grayscale cursor-not-allowed' : ''}`}
                                >
                                    <div className={`p-2 rounded-full mb-3 ${(recordingMode === 'cloud' || recordingMode === 'cloud_analysis') ? 'bg-blue-100 text-blue-600' : 'bg-paper-dim text-ink-muted'}`}>
                                        <Cloud className="w-5 h-5" />
                                    </div>
                                    <h4 className={`text-sm font-bold mb-1 text-center ${(recordingMode === 'cloud' || recordingMode === 'cloud_analysis') ? 'text-blue-900' : 'text-ink'}`}>
                                        Moln
                                    </h4>
                                    <p className="text-xs text-center text-ink-muted line-clamp-2">Perfekt transkription. Ingen automatisk sammanfattning.</p>
                                    {!isPro && <Lock className="absolute top-3 right-3 w-4 h-4 text-ink-muted" />}
                                </button>

                                <button
                                    onClick={() => setRecordingMode('local')}
                                    className={`relative p-4 rounded-xl border text-left flex flex-col items-center justify-center transition-all ${recordingMode === 'local'
                                        ? 'border-ink-soft bg-paper-dim shadow-sm ring-1 ring-ink-soft'
                                        : 'border-line bg-white hover:border-line hover:bg-paper-dim'
                                    }`}
                                >
                                    <div className={`p-2 rounded-full mb-3 ${recordingMode === 'local' ? 'bg-line text-ink-soft' : 'bg-paper-dim text-ink-muted'}`}>
                                        <HardDrive className="w-5 h-5" />
                                    </div>
                                    <h4 className={`text-sm font-bold mb-1 text-center ${recordingMode === 'local' ? 'text-ink' : 'text-ink'}`}>
                                        Lokal
                                    </h4>
                                    <p className="text-xs text-center text-ink-muted line-clamp-2">Ljudet lämnar aldrig din dator. Extremt säkert.</p>
                                </button>
                            </div>
                        </div>

                        {/* Molnsynk (opt-in, default av — privacy-first) */}
                        <div className="border-t pt-6 space-y-3">
                            <div>
                                <label className="text-sm font-medium text-ink">Synka resultat till mitt konto</label>
                                <p className="text-xs text-muted-foreground mt-1">
                                    <strong>Av</strong> (standard): molntranskriberingen visas bara här på datorn — inget sparas i molnet.
                                    <strong> På</strong>: resultatet sparas i ditt konto och visas i dashboarden på sagt.ai (synk mellan enheter).
                                    Styr inte om ljud laddas upp för transkribering — det avgörs av inspelningsläget ovan.
                                </p>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                {([
                                    { value: false, label: '🔒 Av — endast lokalt' },
                                    { value: true, label: '☁ På — synka till konto' },
                                ] as { value: boolean; label: string }[]).map(({ value, label }) => (
                                    <button
                                        key={String(value)}
                                        onClick={() => setCloudSync(value)}
                                        className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${cloudSync === value
                                            ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                            : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
                                        }`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Lagring (moln) */}
                        <div className="border-t pt-6 space-y-3">
                            <div>
                                <label className="text-sm font-medium text-ink">Lagring av ljudfiler i molnet</label>
                                <p className="text-xs text-muted-foreground">Hur länge ljudfiler sparas i molnet efter analys.</p>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                {([
                                    { value: '24h',              label: '24 timmar' },
                                    { value: 'immediate_delete', label: 'Radera efter analys' },
                                ] as { value: typeof retentionPolicy; label: string }[]).map(({ value, label }) => (
                                    <button
                                        key={value}
                                        onClick={() => setRetentionPolicy(value)}
                                        className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${retentionPolicy === value
                                            ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                            : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
                                        }`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Lokal lagring — diskanvändning + gallringspolicy */}
                        <div className="border-t pt-6 space-y-3">
                            <div>
                                <label className="text-sm font-medium text-ink">Lokal lagring</label>
                                <p className="text-xs text-muted-foreground">
                                    Gäller ljudfiler på den här datorn. Transkript och analyser behålls alltid — endast ljudet raderas.
                                </p>
                            </div>

                            <div className="flex items-center gap-2 text-xs text-ink-soft bg-paper-dim rounded-md px-3 py-2">
                                <HardDrive className="w-4 h-4 text-ink-muted shrink-0" />
                                {storageUsage ? (
                                    <span>
                                        Inspelningar: <strong>{formatBytes(storageUsage.recordings_bytes)}</strong> ({storageUsage.file_count} ljudfiler)
                                        {' · '}Databas: {formatBytes(storageUsage.db_bytes)}
                                    </span>
                                ) : (
                                    <span>Beräknar diskanvändning…</span>
                                )}
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                {([
                                    { value: 'keep_all', label: 'Behåll allt' },
                                    { value: 'days_30',  label: 'Radera ljud äldre än 30 dagar' },
                                    { value: 'days_90',  label: 'Radera ljud äldre än 90 dagar' },
                                    { value: 'gb_10',    label: 'Max 10 GB ljudfiler' },
                                ] as { value: LocalAudioRetention; label: string }[]).map(({ value, label }) => (
                                    <button
                                        key={value}
                                        onClick={() => handleLocalRetentionChange(value)}
                                        className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${localAudioRetention === value
                                            ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                            : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
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
                    <span className="text-xs text-ink-muted">Sagt.ai v{CURRENT_VERSION}</span>
                    <Button variant="outline" onClick={resetDefaults} className="text-red-600 hover:text-red-700 hover:bg-red-50">
                        Återställ till standardvärden
                    </Button>
                </div>
            </div>
        </div>
    );
}
