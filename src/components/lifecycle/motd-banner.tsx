import { useState } from "react"
import { X, Info } from "lucide-react"
import { useConfigStore } from "@/store/config-store"

const STORAGE_KEY = "sagt_motd_ack"

export function MotdBanner() {
    const motd = useConfigStore((s) => s.motd)
    const [dismissed, setDismissed] = useState(
        () => !!motd && localStorage.getItem(STORAGE_KEY) === motd
    )

    if (!motd || dismissed) return null

    const handleDismiss = () => {
        localStorage.setItem(STORAGE_KEY, motd)
        setDismissed(true)
    }

    return (
        <div className="flex items-center gap-3 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-sm">
            <Info className="h-4 w-4 shrink-0 text-amber-500" />
            <span className="flex-1">{motd}</span>
            <button
                onClick={handleDismiss}
                className="shrink-0 p-1 rounded hover:bg-amber-100 transition-colors"
                aria-label="Stäng"
            >
                <X className="h-3.5 w-3.5" />
            </button>
        </div>
    )
}
