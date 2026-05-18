import { useEffect } from "react";
import { useAmplitudeStore } from "@/store/amplitude-store";

export function useAudioAmplitude() {
    const { mic, system, initListener } = useAmplitudeStore();

    useEffect(() => {
        // Ensure listener is running when any component uses this hook
        initListener();

        // We do NOT unlisten here. The store keeps listening.
        // This persists the listener across navigation, which is efficient.
        // If we want to stop listening when NO components use it, we'd need reference counting.
        // For now, "Always On" metering is fine since we have Rust throttling.
    }, [initListener]);

    return { mic, system };
}
