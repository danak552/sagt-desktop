import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

const PROD_API_URL = import.meta.env.VITE_API_URL || "https://api.sagt.ai/api/v1"

export type TranscriptionLanguage = 'sv' | 'no' | 'en';

// Lokal gallringspolicy för ljudfiler (skild från retentionPolicy som styr molnlagring).
// Transkript/analys behålls alltid — endast ljudet gallras. Default 'keep_all':
// appen är offline-first och WAV:en är enda kopian av ljudet.
export type LocalAudioRetention = 'keep_all' | 'days_30' | 'days_90' | 'gb_10';

interface SettingsState {
    vadThreshold: number;
    silenceDuration: number;
    modelSize: 'small' | 'medium';
    retentionPolicy: '24h' | 'immediate_delete';
    localAudioRetention: LocalAudioRetention;
    backendUrl: string;
    apiKey: string;
    inputDevice: string | null;
    transcriptionLanguage: TranscriptionLanguage;
    cloudSync: boolean;   // opt-in: persistera molnresultat i kontot (dashboard). Default false (privacy-first).

    // PRO live-molnströmning: hur kanalerna hanteras.
    //  'structured' = Du/Mötet separat (~2× minuter, bäst "vem sa vad")
    //  'merged'     = mixad till ett stycke (1× minuter), styckesbryt vid pauser
    cloudDiarizationMode: 'structured' | 'merged';
    // Tröskel (ms) för visuellt styckesbryt vid längre talpaus. Justerbar; default 1500.
    pauseBreakMs: number;

    // New unified mode
    recordingMode: 'cloud_analysis' | 'cloud' | 'local';
    defaultProMode: 'cloud_analysis' | 'cloud' | 'local';
    modeExplicitlySet: boolean; // true = user has consciously picked a mode via dropdown

    // Legacy flags kept for compatibility, now derived from recordingMode
    autoTranscribeCloud: boolean;
    autoAnalyzeCloud: boolean;

    setRecordingMode: (mode: 'cloud_analysis' | 'cloud' | 'local') => void;
    setDefaultProMode: (mode: 'cloud_analysis' | 'cloud' | 'local') => void;

    setTranscriptionLanguage: (language: TranscriptionLanguage) => void;
    setVadThreshold: (threshold: number) => void;
    setSilenceDuration: (duration: number) => void;
    setModelSize: (size: 'small' | 'medium') => void;
    setRetentionPolicy: (policy: '24h' | 'immediate_delete') => void;
    setLocalAudioRetention: (policy: LocalAudioRetention) => void;
    setBackendUrl: (url: string) => void;
    setApiKey: (key: string) => void;
    setInputDevice: (device: string | null) => void;
    setCloudSync: (val: boolean) => void;
    setCloudDiarizationMode: (mode: 'structured' | 'merged') => void;
    setPauseBreakMs: (ms: number) => void;

    // Kept for backward compat, but calling them sets recordingMode under the hood
    setAutoTranscribeCloud: (val: boolean) => void;
    setAutoAnalyzeCloud: (val: boolean) => void;

    resetDefaults: () => void;
}

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set) => ({
            // Default matches backend defaults
            vadThreshold: 0.008,
            silenceDuration: 1200,
            modelSize: 'small',
            retentionPolicy: '24h',
            localAudioRetention: 'keep_all' as LocalAudioRetention,
            backendUrl: import.meta.env.PROD ? PROD_API_URL : 'http://localhost:8000',
            apiKey: '',
            inputDevice: null,
            transcriptionLanguage: 'sv' as TranscriptionLanguage,
            cloudSync: false,
            cloudDiarizationMode: 'structured' as 'structured' | 'merged',
            pauseBreakMs: 1500,

            // New unified mode — default 'local' så gratisanvändare inte möts av
            // molnläge-toast vid första inspelning
            recordingMode: 'local',
            defaultProMode: 'cloud',
            modeExplicitlySet: false,

            // Legacy
            autoTranscribeCloud: false,
            autoAnalyzeCloud: false,

            setRecordingMode: (mode) => set({
                recordingMode: mode,
                autoTranscribeCloud: mode === 'cloud_analysis' || mode === 'cloud',
                autoAnalyzeCloud: mode === 'cloud_analysis',
                modeExplicitlySet: true,
            }),

            setDefaultProMode: (mode) => set({ defaultProMode: mode }),

            setTranscriptionLanguage: (transcriptionLanguage) => set({ transcriptionLanguage }),
            setVadThreshold: (vadThreshold) => set({ vadThreshold }),
            setSilenceDuration: (silenceDuration) => set({ silenceDuration }),
            setModelSize: (modelSize) => set({ modelSize }),

            setRetentionPolicy: (retentionPolicy) => set({ retentionPolicy }),
            setLocalAudioRetention: (localAudioRetention) => set({ localAudioRetention }),
            setBackendUrl: (backendUrl) => set({ backendUrl }),
            setApiKey: (apiKey) => set({ apiKey }),
            setInputDevice: (inputDevice) => set({ inputDevice }),
            setCloudSync: (cloudSync) => set({ cloudSync }),
            setCloudDiarizationMode: (cloudDiarizationMode) => set({ cloudDiarizationMode }),
            setPauseBreakMs: (pauseBreakMs) => set({ pauseBreakMs }),

            // Legacy mapping
            setAutoTranscribeCloud: (val) => set((state) => {
                const newMode = val 
                    ? (state.autoAnalyzeCloud ? 'cloud_analysis' : 'cloud') 
                    : 'local';
                return { autoTranscribeCloud: val, recordingMode: newMode };
            }),
            setAutoAnalyzeCloud: (val) => set((state) => {
                const newMode = val ? 'cloud_analysis' : (state.autoTranscribeCloud ? 'cloud' : 'local');
                return { autoAnalyzeCloud: val, recordingMode: newMode };
            }),

            resetDefaults: () => set({
                vadThreshold: 0.008,
                silenceDuration: 1200,
                modelSize: 'small',
                retentionPolicy: '24h',
                localAudioRetention: 'keep_all',
                backendUrl: import.meta.env.PROD ? PROD_API_URL : 'http://localhost:8000',
                apiKey: '',
                inputDevice: null,
                transcriptionLanguage: 'sv' as TranscriptionLanguage,
                cloudSync: false,
                cloudDiarizationMode: 'structured',
                pauseBreakMs: 1500,
                recordingMode: 'local',
                defaultProMode: 'cloud',
                modeExplicitlySet: false,
                autoTranscribeCloud: false,
                autoAnalyzeCloud: false
            })
        }),
        {
            name: 'swedish-whisper-settings',
            storage: createJSONStorage(() => localStorage),
            version: 7,
            migrate: (state: any) => ({
                ...state,
                backendUrl: import.meta.env.PROD ? PROD_API_URL : 'http://localhost:8000',
                // Lägg till nytt fält — rör inte recordingMode (Pro-användare återställs
                // till defaultProMode av App.tsx:useEffect när de är inloggade)
                modeExplicitlySet: false,
                // "keep" (Spara alltid) borttagen — hedrades ej av infra + krockade med
                // GDPR-löftet. Migrera befintliga 'keep'-värden till '24h'.
                retentionPolicy: state.retentionPolicy === 'keep' ? '24h' : (state.retentionPolicy ?? '24h'),
                // Opt-in molnsynk — default av (privacy-first).
                cloudSync: state.cloudSync ?? false,
                // v6: PRO live-molnströmning — strukturerad (Du/Mötet) default; pausbryt 1.5s.
                cloudDiarizationMode: state.cloudDiarizationMode ?? 'structured',
                pauseBreakMs: state.pauseBreakMs ?? 1500,
                // v7: lokal gallringspolicy — default behåll allt (offline-first, ljudet är enda kopian)
                localAudioRetention: state.localAudioRetention ?? 'keep_all',
            }),
        }
    )
);
