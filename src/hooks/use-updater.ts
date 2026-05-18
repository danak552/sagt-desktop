import { useEffect } from "react"
import { toast } from "sonner"

export function useUpdater() {
    useEffect(() => {
        // Dynamic import — plugin only available in Tauri context, not in browser dev mode
        import("@tauri-apps/plugin-updater").then(({ check }) =>
            check().then(async (update) => {
                if (!update?.available) return
                toast("Ny version av Sagt.ai tillgänglig", {
                    description: `v${update.version} är klar att installera`,
                    action: {
                        label: "Uppdatera nu",
                        onClick: async () => {
                            await update.downloadAndInstall()
                            const { relaunch } = await import("@tauri-apps/plugin-process")
                            await relaunch()
                        },
                    },
                    duration: Infinity,
                })
            })
        ).catch(() => {})
    }, [])
}
