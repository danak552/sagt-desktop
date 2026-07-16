import { useEffect } from 'react'
import posthog from 'posthog-js'
import { useAuthStore } from '@/store/auth-store'
import { captureEvent } from '@/hooks/use-posthog-events'
import { CURRENT_VERSION } from '@/lib/version'

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://eu.i.posthog.com'

if (KEY) {
    posthog.init(KEY, {
        api_host: HOST,
        persistence: 'localStorage',
        capture_pageview: false,
        capture_pageleave: false,
        autocapture: false,
        disable_session_recording: true,
        loaded: (ph) => {
            ph.register({ platform: 'desktop', app_version: CURRENT_VERSION })
            ph.capture('app_opened')
        },
    })
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
    useEffect(() => {
        if (!KEY) return

        // Identify immediately if session is already persisted on startup
        const { isSignedIn, userId, email, isPro } = useAuthStore.getState()
        if (isSignedIn && userId) {
            posthog.identify(userId, {
                email: email ?? undefined,
                plan: isPro() ? 'pro' : 'free',
            })
        }

        // Keep identify/reset in sync with auth state changes
        return useAuthStore.subscribe((state, prev) => {
            if (state.isSignedIn && !prev.isSignedIn && state.userId) {
                posthog.identify(state.userId, {
                    email: state.email ?? undefined,
                    plan: state.isPro() ? 'pro' : 'free',
                })
                captureEvent('sign_in_completed')
            } else if (!state.isSignedIn && prev.isSignedIn) {
                captureEvent('sign_out')
                posthog.reset()
                // Re-register device super properties — reset() clears them
                posthog.register({ platform: 'desktop', app_version: CURRENT_VERSION })
            }
        })
    }, [])

    return <>{children}</>
}
