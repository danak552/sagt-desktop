import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Förklaringsbubbla bredvid en inställningsetikett.
 *
 * Textmönstret i Inställningar är tvådelat: varje inställning har EN kort synlig rad
 * som säger vad den gör, och konsekvenserna (kostnad, kvalitet, integritet, "På/Av"-
 * nyanser) ligger här bakom. Det håller sidan skannbar utan att gömma det som faktiskt
 * behövs för att välja.
 *
 * Öppnas på klick OCH på hover — hover ensamt är otillgängligt för tangentbord och
 * pekskärm, klick ensamt är osynligt för den som bara sveper förbi.
 *
 * Färgerna är medvetet paper/ink/line och inte shadcns popover-tokens: desktoptemat
 * definierar aldrig --popover, så en stock-shadcn-panel renderar genomskinlig här.
 */
export function InfoHint({ children, className }: { children: React.ReactNode; className?: string }) {
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef<HTMLSpanElement>(null);
    const hoverTimer = useRef<number | null>(null);
    const panelId = useId();

    const clearHoverTimer = () => {
        if (hoverTimer.current !== null) {
            window.clearTimeout(hoverTimer.current);
            hoverTimer.current = null;
        }
    };

    // Stäng vid Escape och vid klick utanför. Lyssnarna registreras bara när panelen är
    // öppen — annars betalar varje inställning på sidan för ett globalt event.
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        const onPointerDown = (e: PointerEvent) => {
            if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("pointerdown", onPointerDown);
        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("pointerdown", onPointerDown);
        };
    }, [open]);

    useEffect(() => clearHoverTimer, []);

    return (
        <span
            ref={wrapperRef}
            className="relative inline-flex align-middle"
            onMouseEnter={() => {
                clearHoverTimer();
                hoverTimer.current = window.setTimeout(() => setOpen(true), 150);
            }}
            onMouseLeave={() => {
                clearHoverTimer();
                setOpen(false);
            }}
        >
            <button
                type="button"
                aria-label="Mer information"
                aria-expanded={open}
                aria-describedby={open ? panelId : undefined}
                onClick={() => {
                    clearHoverTimer();
                    setOpen(o => !o);
                }}
                // Inget onFocus som öppnar. Ett klick på en ofokuserad knapp ger
                // focus FÖRE click: onFocus hade satt open=true, och onClicks
                // funktionella updater vänt tillbaka till false — första klicket
                // (och varje första tryck på pekskärm, där hover-timern aldrig
                // startar) hade varit dött. Tangentbordet når panelen ändå:
                // Enter/Space fyrar click.
                onBlur={() => setOpen(false)}
                className={cn(
                    "text-ink-muted hover:text-ink-soft focus-visible:text-ink-soft transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 rounded-full",
                    className
                )}
            >
                <Info className="w-3.5 h-3.5" />
            </button>

            {open && (
                <span
                    id={panelId}
                    role="tooltip"
                    className={cn(
                        "absolute left-0 top-full z-50 mt-1.5 w-64 rounded-md",
                        "border border-line bg-paper p-3 shadow-lg",
                        "text-xs leading-relaxed text-ink-soft font-normal normal-case tracking-normal"
                    )}
                >
                    {children}
                </span>
            )}
        </span>
    );
}
