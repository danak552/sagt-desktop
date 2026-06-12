import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Mic2, Minus, Square, Copy, X } from "lucide-react";

/**
 * Minimal custom title bar (decorations: false i tauri.conf.json).
 *
 * Renderas ALLTID — även utanför AppGuards blockerande lägen — så att
 * fönsterkontrollerna fungerar på varje skärm. Wordmarken bor här (inte i
 * sidofältet) för att undvika dubblering.
 */
export function TitleBar() {
    const appWindow = getCurrentWindow();
    const [isMaximized, setIsMaximized] = useState(false);

    useEffect(() => {
        appWindow.isMaximized().then(setIsMaximized);
        // onResized fångar maximera/återställ → uppdatera ikonen
        const unlistenPromise = appWindow.onResized(() => {
            appWindow.isMaximized().then(setIsMaximized);
        });
        return () => {
            unlistenPromise.then((unlisten) => unlisten());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div
            data-tauri-drag-region
            className="flex items-center justify-between h-9 shrink-0 bg-paper-dim border-b border-line select-none"
        >
            {/* Wordmark — flyttad hit från sidofältet (en plats, ingen dubblering) */}
            <div data-tauri-drag-region className="flex items-center gap-2 px-3">
                <Mic2 className="h-4 w-4 text-brand" />
                <span className="text-sm font-bold tracking-tight text-ink">
                    Sagt<span className="text-ochre">.ai</span>
                </span>
            </div>

            {/* Fönsterkontroller — Windows-stil, höger */}
            <div className="flex items-center h-full">
                <button
                    type="button"
                    onClick={() => appWindow.minimize()}
                    aria-label="Minimera"
                    className="inline-flex items-center justify-center h-full w-12 text-ink-soft hover:bg-line transition-colors"
                >
                    <Minus className="h-4 w-4" />
                </button>
                <button
                    type="button"
                    onClick={() => appWindow.toggleMaximize()}
                    aria-label={isMaximized ? "Återställ" : "Maximera"}
                    className="inline-flex items-center justify-center h-full w-12 text-ink-soft hover:bg-line transition-colors"
                >
                    {isMaximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                </button>
                <button
                    type="button"
                    onClick={() => appWindow.close()}
                    aria-label="Stäng"
                    className="inline-flex items-center justify-center h-full w-12 text-ink-soft hover:bg-red-600 hover:text-white transition-colors"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
        </div>
    );
}
