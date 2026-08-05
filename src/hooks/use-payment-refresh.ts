import { useState, useRef, useCallback, useEffect } from "react"
import { useAuthStore } from "@/store/auth-store"
import { toast } from "sonner"

const _raw = (import.meta.env.VITE_API_URL || "https://api.sagt.ai/api/v1").replace(/\/$/, "")
const BASE_URL = _raw.endsWith("/api/v1") ? _raw : `${_raw}/api/v1`

const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 300_000 // 5 minutes

export function usePaymentRefresh() {
    const [isWaiting, setIsWaiting] = useState(false)
    const getToken = useAuthStore((s) => s.getToken)
    const setSession = useAuthStore((s) => s.setSession)
    const isPro = useAuthStore((s) => s.isPro())
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const stopPolling = useCallback(() => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
        setIsWaiting(false)
    }, [])

    // Auto-stop when any hook instance confirms payment
    useEffect(() => {
        if (isPro && isWaiting) stopPolling()
    }, [isPro, isWaiting, stopPolling])

    const doPoll = useCallback(async (): Promise<boolean> => {
        const token = getToken()
        if (!token) return false
        try {
            const res = await fetch(`${BASE_URL}/auth/desktop-refresh`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${token}` },
            })
            if (res.status === 401) {
                useAuthStore.getState().clearSession()
                toast.error("Ditt konto hittades inte. Du har loggats ut.")
                return false
            }
            if (!res.ok) return false
            const data = await res.json()
            setSession(data.token, data.user, data.expires_at)
            return data.user?.stripe_status === "active"
        } catch {
            return false
        }
    }, [getToken, setSession])

    const startPolling = useCallback(() => {
        setIsWaiting(true)
        pollRef.current = setInterval(async () => {
            const activated = await doPoll()
            if (activated) stopPolling()
        }, POLL_INTERVAL_MS)
        timeoutRef.current = setTimeout(stopPolling, POLL_TIMEOUT_MS)
    }, [doPoll, stopPolling])

    // One-shot refresh — for "Jag har betalat" button.
    // Returnerar om prenumerationen nu är aktiv, så anroparen kan skilja "inte klar än"
    // från "klart" och säga det till användaren. Utan returvärdet blir knappen tyst vid
    // misslyckande, vilket är exakt det läge där användaren behöver besked mest.
    const manualRefresh = useCallback(async (): Promise<boolean> => {
        return await doPoll()
    }, [doPoll])

    return { isWaiting, startPolling, stopPolling, manualRefresh }
}
