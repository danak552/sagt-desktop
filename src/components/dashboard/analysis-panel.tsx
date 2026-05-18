import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import {
    CheckCircle2,
    ListTodo,
    Sparkles,
    Copy,
} from "lucide-react"
import { toast } from "sonner"

interface AnalysisPanelProps {
    analysis?: {
        summary: string
        key_decisions: string[]
        action_items: string[]
    } | null
    status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | null
}

export function AnalysisPanel({ analysis, status }: AnalysisPanelProps) {
    const copyToClipboard = (text: string, label: string) => {
        navigator.clipboard.writeText(text)
        toast.success(`${label} kopierat till urklipp`)
    }

    if (status === "PROCESSING" || status === "PENDING") {
        return (
            <Card className="h-full border-indigo-100 dark:border-indigo-900/30 shadow-sm">
                <CardHeader className="pb-2">
                    <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400">
                        <Sparkles className="h-5 w-5 animate-pulse" />
                        <CardTitle>AI Insikter</CardTitle>
                    </div>
                    <CardDescription>Analyserar transkribering...</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6 pt-4">
                    <div className="space-y-2">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-5/6" />
                    </div>
                    <Separator />
                    <div className="space-y-2">
                        <Skeleton className="h-5 w-1/3 mb-4" />
                        <div className="flex gap-2">
                            <Skeleton className="h-4 w-4 rounded-full" />
                            <Skeleton className="h-4 w-full" />
                        </div>
                        <div className="flex gap-2">
                            <Skeleton className="h-4 w-4 rounded-full" />
                            <Skeleton className="h-4 w-5/6" />
                        </div>
                    </div>
                </CardContent>
            </Card>
        )
    }

    if (!analysis && status === "COMPLETED") {
        return (
            <Card className="h-full bg-muted/20 border-dashed">
                <CardContent className="flex flex-col items-center justify-center h-full min-h-[300px] text-muted-foreground p-6">
                    <Sparkles className="h-12 w-12 text-muted mb-4 opacity-50" />
                    <p className="text-center font-medium">Ingen AI-analys tillgänglig</p>
                    <p className="text-sm text-center mt-2 opacity-70">
                        Detta jobb har inte analyserats än.
                    </p>
                </CardContent>
            </Card>
        )
    }

    if (!analysis) return null

    return (
        <Card className="h-full border-indigo-100 dark:border-indigo-900/30 shadow-sm overflow-hidden flex flex-col">
            <CardHeader className="bg-gradient-to-r from-indigo-50/50 to-transparent dark:from-indigo-950/10 pb-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-indigo-700 dark:text-indigo-400">
                        <Sparkles className="h-5 w-5" />
                        <CardTitle className="text-lg">AI Insikter</CardTitle>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="space-y-6 pt-6 flex-1 overflow-auto">
                {/* Summary Section */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-foreground/90 flex items-center gap-2">
                            Sammanfattning
                        </h3>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            onClick={() => copyToClipboard(analysis.summary, "Sammanfattning")}
                        >
                            <Copy className="h-3 w-3" />
                        </Button>
                    </div>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                        {analysis.summary}
                    </p>
                </div>

                <Separator />

                {/* Key Decisions */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-foreground/90 flex items-center gap-2">
                            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                            Beslut
                        </h3>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            onClick={() => copyToClipboard(analysis.key_decisions.join("\n"), "Beslut")}
                        >
                            <Copy className="h-3 w-3" />
                        </Button>
                    </div>
                    {analysis.key_decisions.length > 0 ? (
                        <ul className="space-y-2">
                            {analysis.key_decisions.map((decision, i) => (
                                <li key={i} className="text-sm text-muted-foreground flex gap-3 items-start p-2 rounded-md hover:bg-muted/50 transition-colors">
                                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                                    <span>{decision}</span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-muted-foreground italic pl-7">Inga beslut noterade.</p>
                    )}
                </div>

                <Separator />

                {/* Action Items */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-foreground/90 flex items-center gap-2">
                            <ListTodo className="h-4 w-4 text-blue-500" />
                            Åtgärder
                        </h3>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            onClick={() => copyToClipboard(analysis.action_items.join("\n"), "Åtgärder")}
                        >
                            <Copy className="h-3 w-3" />
                        </Button>
                    </div>
                    {analysis.action_items.length > 0 ? (
                        <ul className="space-y-2">
                            {analysis.action_items.map((item, i) => (
                                <li key={i} className="text-sm text-muted-foreground flex gap-3 items-start p-2 rounded-md hover:bg-muted/50 transition-colors">
                                    <div className="mt-0.5 border-2 border-primary/20 h-4 w-4 rounded-sm shrink-0" />
                                    <span>{item}</span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-muted-foreground italic pl-7">Inga åtgärder noterade.</p>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}
