import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';

interface AudioPayload {
    mic: number;
    system: number;
}

interface AmplitudeState {
    mic: number;
    system: number;
    isListening: boolean;
    initListener: () => Promise<void>;
    unlisten: () => void;
}

let unlistenFn: (() => void) | null = null;

export const useAmplitudeStore = create<AmplitudeState>((set, get) => ({
    mic: 0,
    system: 0,
    isListening: false,

    initListener: async () => {
        if (get().isListening) return;

        // Mark as listening immediately to prevent race conditions
        set({ isListening: true });

        unlistenFn = await listen<AudioPayload>("audio-amplitude", (event) => {
            set({
                mic: event.payload.mic,
                system: event.payload.system
            });
        });
    },

    unlisten: () => {
        if (unlistenFn) {
            unlistenFn();
            unlistenFn = null;
            set({ isListening: false });
        }
    }
}));
