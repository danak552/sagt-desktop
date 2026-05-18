import { create } from 'zustand';

export interface AnalysisData {
    summary: string;
    decisions: string[];
    actions: string[];
    template_used?: string;
}

interface SyncState {
    uploadStatus: 'idle' | 'uploading' | 'success' | 'error';
    uploadProgress: number;
    errorMessage: string | null;
    currentSessionPath: string | null;
    currentSessionId: string | null;
    uploadedJobId: string | null;
    processingStatus: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | null;
    analysisData: AnalysisData | null;
    activeJob: any | null; // Stores the full recording object when selected from history
    activeJobFromHistory: boolean; // true only when user explicitly opened from history list

    // Smart Recording Journey states
    effectiveMode: 'cloud_analysis' | 'cloud' | 'local';
    isOnline: boolean;

    setActiveJob: (job: any | null, fromHistory?: boolean) => void;
    setEffectiveMode: (mode: 'cloud_analysis' | 'cloud' | 'local') => void;
    setIsOnline: (status: boolean) => void;
    setUploadStatus: (status: 'idle' | 'uploading' | 'success' | 'error') => void;
    setUploadProgress: (progress: number) => void;
    setErrorMessage: (msg: string | null) => void;
    setSession: (path: string | null, id: string | null) => void;
    setUploadedJobId: (id: string | null) => void;
    setProcessingStatus: (status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | null) => void;
    setAnalysisData: (data: AnalysisData | null) => void;
    templateId: string;
    setTemplateId: (id: string) => void;
    isRecording: boolean;
    setIsRecording: (isRecording: boolean) => void;
    reset: () => void;
    resetToLive: () => void;
    resetSync: () => void;
}

export const useSyncStore = create<SyncState>((set) => ({
    uploadStatus: 'idle',
    uploadProgress: 0,
    errorMessage: null,
    currentSessionPath: null,
    currentSessionId: null,
    uploadedJobId: null,
    processingStatus: null,
    analysisData: null,
    activeJob: null,
    activeJobFromHistory: false,
    effectiveMode: 'local', // Default, updated on mount/settings change
    isOnline: true,

    setEffectiveMode: (mode) => set({ effectiveMode: mode }),
    setIsOnline: (status) => set({ isOnline: status }),
    
    setUploadStatus: (status) => set({ uploadStatus: status }),
    setUploadProgress: (progress) => set({ uploadProgress: progress }),
    setErrorMessage: (errorMessage) => set({ errorMessage }),
    setSession: (path, id) => set({ currentSessionPath: path, currentSessionId: id }),
    setUploadedJobId: (id) => set({ uploadedJobId: id }),
    setProcessingStatus: (status) => set({ processingStatus: status }),
    setAnalysisData: (data) => set({ analysisData: data }),
    templateId: "general",
    setTemplateId: (id) => set({ templateId: id }),
    isRecording: false,
    setIsRecording: (isRecording) => set({ isRecording }),
    setActiveJob: (job, fromHistory = false) => set({ activeJob: job, activeJobFromHistory: fromHistory }),
    reset: () => set({
        uploadedJobId: null,
        processingStatus: null,
        analysisData: null,
        uploadStatus: 'idle',
        uploadProgress: 0,
        errorMessage: null
    }),
    resetToLive: () => set({
        activeJob: null,
        activeJobFromHistory: false,
        analysisData: null,
        uploadedJobId: null,
        processingStatus: null,
        uploadStatus: 'idle',
        uploadProgress: 0,
        errorMessage: null
    }),
    resetSync: () => set({
        uploadStatus: 'idle',
        uploadProgress: 0,
        errorMessage: null,
        currentSessionPath: null,
        currentSessionId: null,
        uploadedJobId: null,
        analysisData: null,
        activeJob: null,
        activeJobFromHistory: false,
    }),
}));
