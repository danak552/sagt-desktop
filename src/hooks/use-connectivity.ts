import { useEffect } from 'react';
import { useSyncStore } from '@/store/sync-store';
import { useSettingsStore } from '@/store/settings-store';
import { toast } from 'sonner';

export function useConnectivity() {
    const { setIsOnline, setEffectiveMode } = useSyncStore();

    useEffect(() => {
        const handleOnline = () => {
            setIsOnline(true);
            const { recordingMode } = useSettingsStore.getState();
            setEffectiveMode(recordingMode);
            
            // Only toast if they are returning to a cloud mode they wanted
            if (recordingMode !== 'local') {
                toast.success('Anslutning återställd. Molnfunktioner är aktiverade igen.');
            }
        };

        const handleOffline = () => {
            setIsOnline(false);
            const { recordingMode } = useSettingsStore.getState();
            
            // Fallback to local if they were in a cloud mode
            if (recordingMode !== 'local') {
                setEffectiveMode('local');
                toast.warning('Ingen internetanslutning. Inspelningar kommer endast sparas lokalt.');
            } else {
                setEffectiveMode('local'); // Ensure it stays local just in case
            }
        };

        // Initialize state
        const isCurrentlyOnline = navigator.onLine;
        setIsOnline(isCurrentlyOnline);
        const initialRecordingMode = useSettingsStore.getState().recordingMode;
        setEffectiveMode(isCurrentlyOnline ? initialRecordingMode : 'local');

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, [setIsOnline, setEffectiveMode]);
}
