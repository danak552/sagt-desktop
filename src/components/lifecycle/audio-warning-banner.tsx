import { useEffect } from "react"
import { X, VolumeX } from "lucide-react"
import { useSyncStore } from "@/store/sync-store"

// Persistent banner för ljudmotorns guardrail-varningar (tyst MÖTET-kanal m.m.).
// Kompletterar toasten i App.tsx: en toast försvinner efter 10 s, men det här är
// situationen där användaren måste agera INNAN mötet är över — bannern ligger kvar
// tills varningen släcks (audio-warning-cleared), inspelningen stoppas eller
// användaren stänger den.
export function AudioWarningBanner() {
    const audioWarning = useSyncStore((s) => s.audioWarning)
    const setAudioWarning = useSyncStore((s) => s.setAudioWarning)
    const isRecording = useSyncStore((s) => s.isRecording)

    // Varningen gäller den pågående inspelningen — rensa när den stoppas så att
    // en stale banner inte ligger kvar över uppspelning/nästa session.
    useEffect(() => {
        if (!isRecording) setAudioWarning(null)
    }, [isRecording, setAudioWarning])

    if (!audioWarning) return null

    return (
        <div className="flex items-center gap-3 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-sm">
            <VolumeX className="h-4 w-4 shrink-0 text-amber-500" />
            <span className="flex-1">{audioWarning}</span>
            <button
                onClick={() => setAudioWarning(null)}
                className="shrink-0 p-1 rounded hover:bg-amber-100 transition-colors"
                aria-label="Stäng"
            >
                <X className="h-3.5 w-3.5" />
            </button>
        </div>
    )
}
