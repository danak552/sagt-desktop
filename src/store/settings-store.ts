import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

const PROD_API_URL = import.meta.env.VITE_API_URL || "https://api.sagt.ai/api/v1"

export type TranscriptionLanguage = 'sv' | 'no' | 'en';

interface SettingsState {
    vadThreshold: number;
    silenceDuration: number;
    modelSize: 'small' | 'medium';
    retentionPolicy: '24h' | 'immediate_delete' | 'keep';
    backendUrl: string;
    apiKey: string;
    inputDevice: string | null;
    transcriptionLanguage: TranscriptionLanguage;

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
    setRetentionPolicy: (policy: '24h' | 'immediate_delete' | 'keep') => void;
    setBackendUrl: (url: string) => void;
    setApiKey: (key: string) => void;
    setInputDevice: (device: string | null) => void;
    
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
            backendUrl: import.meta.env.PROD ? PROD_API_URL : 'http://localhost:8000',
            apiKey: '',
            inputDevice: null,
            transcriptionLanguage: 'sv' as TranscriptionLanguage,
            
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
            setBackendUrl: (backendUrl) => set({ backendUrl }),
            setApiKey: (apiKey) => set({ apiKey }),
            setInputDevice: (inputDevice) => set({ inputDevice }),
            
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
                backendUrl: import.meta.env.PROD ? PROD_API_URL : 'http://localhost:8000',
                apiKey: '',
                inputDevice: null,
                transcriptionLanguage: 'sv' as TranscriptionLanguage,
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
            version: 3,
            migrate: (state: any) => ({
                ...state,
                backendUrl: import.meta.env.PROD ? PROD_API_URL : 'http://localhost:8000',
                // Lägg till nytt fält — rör inte recordingMode (Pro-användare återställs
                // till defaultProMode av App.tsx:useEffect när de är inloggade)
                modeExplicitlySet: false,
            }),
        }
    )
);
