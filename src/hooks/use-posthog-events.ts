import posthog from 'posthog-js'

const enabled = !!import.meta.env.VITE_POSTHOG_KEY

export function captureEvent(event: string, props?: Record<string, unknown>) {
    if (enabled) posthog.capture(event, props)
}

export function usePostHogEvents() {
    return {
        recordingStarted: () =>
            captureEvent('recording_started'),

        recordingStopped: (durationSeconds: number) =>
            captureEvent('recording_stopped', { duration_seconds: durationSeconds }),

        transcriptionCompleted: (wordCount: number) =>
            captureEvent('transcription_completed', { word_count: wordCount }),

        analysisRequested: () =>
            captureEvent('analysis_requested'),

        analysisCompleted: () =>
            captureEvent('analysis_completed'),

        analysisFailed: (error: string) =>
            captureEvent('analysis_failed', { error }),

        // Klient-intent; backend emitterar auktoritativa 'speakers_identified' vid lyckat svar.
        speakersIdentifyRequested: () =>
            captureEvent('speakers_identify_requested'),

        upsellShown: (trigger: string) =>
            captureEvent('upsell_shown', { trigger }),

        upgradeClicked: () =>
            captureEvent('upgrade_clicked'),

        cloudSyncStarted: () =>
            captureEvent('cloud_sync_started'),

        cloudSyncCompleted: (wordCount: number) =>
            captureEvent('cloud_sync_completed', { word_count: wordCount }),

        cloudSyncFailed: (errorCode: string) =>
            captureEvent('cloud_sync_failed', { error_code: errorCode }),

        transcriptCopied: () =>
            captureEvent('transcript_copied'),

        settingsOpened: () =>
            captureEvent('settings_opened'),
    }
}
