import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Recording {
    id: string; // timestamp or uuid
    path: string;
    createdAt: string;
    durationSeconds: number;
    status: 'local' | 'uploaded';
    jobId?: string;
}

interface RecordingState {
    recordings: Recording[];
    addRecording: (recording: Recording) => void;
    updateRecordingStatus: (id: string, status: 'uploaded', jobId: string) => void;
    removeRecording: (id: string) => void;
}

export const useRecordingStore = create<RecordingState>()(
    persist(
        (set) => ({
            recordings: [],
            addRecording: (recording) => set((state) => ({
                recordings: [recording, ...state.recordings]
            })),
            updateRecordingStatus: (id, status, jobId) => set((state) => ({
                recordings: state.recordings.map(r =>
                    r.id === id ? { ...r, status, jobId } : r
                )
            })),
            removeRecording: (id) => set((state) => ({
                recordings: state.recordings.filter(r => r.id !== id)
            })),
        }),
        {
            name: 'recording-storage',
        }
    )
);
