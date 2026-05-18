import { useState, useRef, useCallback } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useAuthStore } from "@/store/auth-store"

const API_URL = import.meta.env.VITE_API_URL || "https://api.sagt.ai/api/v1"
const FRONTEND_URL = import.meta.env.VITE_FRONTEND_URL || "https://sagt.ai"
const POLL_INTERVAL_MS = 2500
const POLL_TIMEOUT_MS = 300_000 // 5 minutes

export function useBrowserAuth() {
    const [isAuthenticating, setIsAuthenticating] = useState(false)
    const setSession = useAuthStore((s) => s.setSession)
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const stopPolling = useCallback(() => {
        if (pollRef.current) {
            clearInterval(pollRef.current)
            pollRef.current = null
        }
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current)
            timeoutRef.current = null
        }
        setIsAuthenticating(false)
    }, [])

    const startAuth = useCallback(async () => {
        const nonce = crypto.randomUUID()
        setIsAuthenticating(true)

        // Open browser to frontend desktop-auth page
        try {
            await invoke("plugin:shell|open", {
                path: `${FRONTEND_URL}/desktop-auth?nonce=${nonce}`,
            })
        } catch (err) {
            console.error("Failed to open browser:", err)
            setIsAuthenticating(false)
            return
        }

        // Ensure base URL ends with /api/v1
        let baseUrl = API_URL.replace(/\/$/, "")
        if (!baseUrl.endsWith("/api/v1")) {
            baseUrl = `${baseUrl}/api/v1`
        }

        // Poll for token
        pollRef.current = setInterval(async () => {
            try {
                const res = await fetch(`${baseUrl}/auth/desktop-poll?nonce=${nonce}`)
                if (res.ok) {
                    const data = await res.json()
                    setSession(data.token, data.user, data.expires_at)
                    stopPolling()
                } else if (res.status === 410) {
                    // Nonce expired
                    stopPolling()
                }
                // 404 = not ready yet, keep polling
            } catch {
                // Network error, keep retrying
            }
        }, POLL_INTERVAL_MS)

        // Timeout after 5 minutes
        timeoutRef.current = setTimeout(stopPolling, POLL_TIMEOUT_MS)
    }, [setSession, stopPolling])

    return { startAuth, stopPolling, isAuthenticating }
}
