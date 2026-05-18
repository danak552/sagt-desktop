import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Segment {
    id?: number;
    recording_id?: number;
    start_time: number;
    end_time: number;
    text: string;
    speaker: string;
    // timestamp is deprecated in favor of start_time/end_time for DB compatibility, 
    // but we can keep it for UI if needed or map it.
    // Let's align with DB schema:
    // DB: start_time, end_time, text, speaker
}

// UI specific segment which might have extra props if needed
export interface UISegment extends Segment {
    timestamp: number; // For backward compat with existing UI code if needed
}

interface TranscriptionState {
    segments: UISegment[];
    isProcessing: boolean;

    addSegment: (segment: UISegment) => void;
    setSegments: (segments: UISegment[]) => void;
    clearSegments: () => void;
    setIsProcessing: (status: boolean) => void;
}

export const useTranscriptionStore = create<TranscriptionState>()(
    persist(
        (set) => ({
            segments: [],
            isProcessing: false,

            addSegment: (segment) => set((state) => ({
                segments: [...state.segments, segment]
            })),

            setSegments: (segments) => set({ segments }),

            clearSegments: () => set({ segments: [] }),

            setIsProcessing: (isProcessing) => set({ isProcessing }),
        }),
        {
            name: 'sagt-transcription-session',
            // Only persist segments, not transient processing state
            partialize: (state) => ({ segments: state.segments }),
        }
    )
);
