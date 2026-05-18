import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ShieldAlert, Mail, SmartphoneNfc, WifiOff, Loader2 } from "lucide-react"
import { useConfigStore } from "@/store/config-store"
import { CURRENT_VERSION } from "@/lib/version"

function compareSemver(a: string, b: string): number {
    const pa = a.split(".").map(Number)
    const pb = b.split(".").map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] ?? 0
        const nb = pb[i] ?? 0
        if (na < nb) return -1
        if (na > nb) return 1
    }
    return 0
}
const API_URL = import.meta.env.VITE_API_URL || "https://api.sagt.ai/api/v1"

type GuardState = 'CHECKING' | 'UPDATE_REQUIRED' | 'REGISTRATION_REQUIRED' | 'READY' | 'OFFLINE_BLOCKED'

export function AppGuard({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<GuardState>('CHECKING')
    const [email, setEmail] = useState("")
    const [isRegistering, setIsRegistering] = useState(false)
    const [maintenanceMessage, setMaintenanceMessage] = useState("")
    // Hämtas från /system/config så att vi kan byta CDN-URL utan ny release.
    // Faller tillbaka på sagt.ai/downloads om backend inte returnerar fältet.
    const [downloadUrl, setDownloadUrl] = useState("https://sagt.ai/downloads")
    const setStripePaymentLink = useConfigStore((s) => s.setStripePaymentLink)
    const setMotd = useConfigStore((s) => s.setMotd)
    const setLatestVersion = useConfigStore((s) => s.setLatestVersion)
    const setDownloadUrlStore = useConfigStore((s) => s.setDownloadUrl)

    useEffect(() => {
        validateAccess()
    }, [])

    const validateAccess = async () => {
        try {
            const res = await fetch(`${API_URL}/system/config`, {
                headers: { "Cache-Control": "no-cache" }
            })

            // Backend is unreachable or returned non-200. Assume offline/network error.
            if (!res.ok) throw new Error("Network response was not ok")

            const data = await res.json()

            if (data.download_url) {
                setDownloadUrl(data.download_url)
                setDownloadUrlStore(data.download_url)
            }
            if (data.stripe_payment_link) {
                setStripePaymentLink(data.stripe_payment_link)
            }
            if (data.motd) {
                setMotd(data.motd)
            }
            if (data.latest_version) {
                setLatestVersion(data.latest_version)
            }

            if (data.maintenance_mode) {
                setMaintenanceMessage(data.message || "Sagt.ai genomgår tillfälligt underhåll.")
                // Maintain CHECKING state to block UI, or create a MAINTENANCE state. 
                // Since instructions don't specify a MAINTENANCE state, we'll force Update_Required UI to show the message.
                setState('UPDATE_REQUIRED')
                return
            }

            // Semantic version check
            if (compareSemver(data.min_version, CURRENT_VERSION) > 0) {
                setState('UPDATE_REQUIRED')
                return
            }

            // Version is OK. Check license.
            verifyLicense()

        } catch (error) {
            console.error("AppGuard: Network check failed, applying Offline Tolerance...", error)
            // OFFLINE TOLERANCE RULE 
            const hasLicense = localStorage.getItem("sagt_beta_license")
            if (hasLicense) {
                // Allow offline usage
                setState('READY')
            } else {
                // Prevent first-time usage without establishing a license
                setState('OFFLINE_BLOCKED')
            }
        }
    }

    const verifyLicense = () => {
        const hasLicense = localStorage.getItem("sagt_beta_license")
        if (hasLicense) {
            setState('READY')
        } else {
            setState('REGISTRATION_REQUIRED')
        }
    }

    const handleRegister = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!email.includes("@")) return

        setIsRegistering(true)
        try {
            const res = await fetch(`${API_URL}/system/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            })

            if (res.ok) {
                const data = await res.json()
                localStorage.setItem("sagt_beta_license", data.license_key)
                setState('READY')
            }
        } catch (error) {
            console.error("Registration failed:", error)
            // It might fail if they drop offline during registration
            alert("Kunde inte ansluta till servern. Kontrollera din uppkoppling.")
        } finally {
            setIsRegistering(false)
        }
    }

    if (state === 'CHECKING') {
        return (
            <div className="h-screen w-screen flex items-center justify-center bg-slate-950 text-slate-50">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
                    <p className="text-slate-400 font-medium">Ansluter till Sagt.ai...</p>
                </div>
            </div>
        )
    }

    if (state === 'UPDATE_REQUIRED') {
        return (
            <div className="h-screen w-screen flex items-center justify-center bg-slate-950 text-slate-50 p-6 selection:bg-indigo-500/30">
                <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl">
                    <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center mx-auto mb-6">
                        <ShieldAlert className="h-8 w-8 text-red-400" />
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight mb-3">Uppdatering krävs</h1>
                    <p className="text-slate-400 mb-8 leading-relaxed">
                        {maintenanceMessage || "En kritisk uppdatering finns tillgänglig. Vänligen ladda ner den senaste versionen av Sagt.ai för att fortsätta."}
                    </p>
                    <Button
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
                        onClick={() => window.open(downloadUrl, "_blank")}
                    >
                        Ladda ner senaste versionen
                    </Button>
                </div>
            </div>
        )
    }

    if (state === 'OFFLINE_BLOCKED') {
        return (
            <div className="h-screen w-screen flex items-center justify-center bg-slate-950 text-slate-50 p-6 selection:bg-indigo-500/30">
                <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl">
                    <div className="w-16 h-16 bg-amber-500/10 rounded-2xl flex items-center justify-center mx-auto mb-6">
                        <WifiOff className="h-8 w-8 text-amber-400" />
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight mb-3">Ingen anslutning</h1>
                    <p className="text-slate-400 mb-8 leading-relaxed">
                        Ingen internetanslutning. Du måste vara uppkopplad första gången du startar Sagt.ai för att registrera dig på plattformen.
                    </p>
                    <Button
                        variant="outline"
                        className="w-full bg-slate-800 hover:bg-slate-700 border-0"
                        onClick={validateAccess}
                    >
                        Försök igen
                    </Button>
                </div>
            </div>
        )
    }

    if (state === 'REGISTRATION_REQUIRED') {
        return (
            <div className="h-screen w-screen flex items-center justify-center bg-slate-950 text-slate-50 p-4 sm:p-6 selection:bg-indigo-500/30">
                <div className="max-w-md w-full relative">
                    {/* Visual glowing backdrop */}
                    <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 to-cyan-500 rounded-2xl blur opacity-20" />

                    <div className="relative bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl">
                        <div className="w-12 h-12 bg-indigo-500/10 rounded-xl flex items-center justify-center mb-6 border border-indigo-500/20">
                            <SmartphoneNfc className="h-6 w-6 text-indigo-400" />
                        </div>

                        <h1 className="text-2xl font-bold tracking-tight mb-2">Välkommen till Sagt.ai Beta</h1>
                        <p className="text-slate-400 mb-8">
                            Ange din e-postadress för att aktivera programmet och få early-access uppdateringar.
                        </p>

                        <form onSubmit={handleRegister} className="space-y-4">
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-slate-300 ml-1">
                                    E-postadress
                                </label>
                                <div className="relative">
                                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-500" />
                                    <Input
                                        type="email"
                                        required
                                        placeholder="namn@företag.se"
                                        value={email}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                                        className="pl-10 h-12 bg-slate-950 border-slate-800 placeholder:text-slate-600 focus-visible:ring-indigo-500"
                                        disabled={isRegistering}
                                    />
                                </div>
                            </div>
                            <Button
                                type="submit"
                                className="w-full h-12 bg-indigo-600 hover:bg-indigo-700 text-white font-medium mt-4"
                                disabled={isRegistering || !email}
                            >
                                {isRegistering ? (
                                    <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Registrerar...
                                    </>
                                ) : (
                                    "Kom igång"
                                )}
                            </Button>
                        </form>
                    </div>
                </div>
            </div>
        )
    }

    // READY state
    return <>{children}</>
}
