import { format } from "date-fns";
import { sv } from "date-fns/locale";
import { Cloud, CloudUpload, Trash2, FileAudio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSyncStore } from "@/store/sync-store";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Recording {
    id: number;
    filename: string;
    file_path: string;
    duration_sec: number;
    created_at: string;
    sync_status: 'local' | 'synced' | 'uploaded';
    cloud_job_id?: string;
    analysis_json?: string;
}

export function RecordingsPage({ onViewChange }: { onViewChange: (view: 'dashboard' | 'settings' | 'recordings') => void }) {
    // Replace store with local state fetched from DB
    const [recordings, setRecordings] = useState<Recording[]>([]);
    const { setSession, setUploadedJobId, setActiveJob, setAnalysisData, setProcessingStatus } = useSyncStore();

    const loadRecordings = async () => {
        try {
            const data = await invoke<Recording[]>("get_recordings");
            setRecordings(data);
        } catch (error) {
            console.error("Failed to load recordings:", error);
        }
    };

    useEffect(() => {
        loadRecordings();

        const unlistenHistory = listen("history-updated", () => {
            console.log("RecordingsPage: History updated, reloading list...");
            loadRecordings();
        });
        const unlistenSynced = listen("recording-synced", () => {
            loadRecordings();
        });

        return () => {
            unlistenHistory.then(f => f());
            unlistenSynced.then(f => f());
        };
    }, []);

    const handleLoad = (recording: Recording) => {
        setSession(recording.file_path, recording.id.toString());
        setActiveJob(recording, true);
        setProcessingStatus('COMPLETED'); // Assume completed if we have analysis, or at least not uploading

        if (recording.analysis_json) {
            try {
                const analysisData = JSON.parse(recording.analysis_json);
                setAnalysisData(analysisData);
            } catch (e) {
                console.error("Failed to parse analysis_json:", e);
                setAnalysisData(null);
            }
        } else {
            setAnalysisData(null);
            // If no analysis but we have cloud ID, maybe we should fetch? 
            // Logic for now: if no local analysis, show empty context.
            setProcessingStatus(null);
        }

        if (recording.cloud_job_id) {
            setUploadedJobId(recording.cloud_job_id);
        } else {
            setUploadedJobId(null);
        }
        onViewChange('dashboard');
    };

    const handleDelete = async (id: number) => {
        if (confirm("Är du säker på att du vill radera denna inspelning? Detta tar bort filen permanent.")) {
            try {
                await invoke("delete_recording_db", { id });
                loadRecordings(); // Refresh list
            } catch (error) {
                console.error("Failed to delete recording:", error);
            }
        }
    };

    const formatDuration = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-y-auto">
            <header className="px-8 py-6 border-b bg-white">
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Inspelningar</h1>
                <p className="text-muted-foreground mt-1">Dina lokala inspelningar och deras synk-status (SQLite Persisted).</p>
            </header>

            <div className="p-8 max-w-5xl">
                <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
                    {recordings.length === 0 ? (
                        <div className="p-12 text-center text-muted-foreground">
                            <FileAudio className="w-12 h-12 mx-auto mb-4 opacity-20" />
                            <p>Inga inspelningar än.</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left">
                                <thead className="bg-slate-50 border-b text-slate-500 font-medium">
                                    <tr>
                                        <th className="px-6 py-3">Datum</th>
                                        <th className="px-6 py-3">Filnamn</th>
                                        <th className="px-6 py-3">Längd</th>
                                        <th className="px-6 py-3">Status</th>
                                        <th className="px-6 py-3 text-right">Åtgärd</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {recordings.map((rec) => (
                                        <tr
                                            key={rec.id}
                                            className="hover:bg-indigo-50/50 transition-colors group cursor-pointer"
                                            onClick={() => handleLoad(rec)}
                                        >
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                {format(new Date(rec.created_at), "d MMMM yyyy, HH:mm", { locale: sv })}
                                            </td>
                                            <td className="px-6 py-4 font-mono text-xs text-slate-600 truncate max-w-[200px]">
                                                {rec.filename}
                                            </td>
                                            <td className="px-6 py-4 font-mono text-slate-600">
                                                {formatDuration(rec.duration_sec)}
                                            </td>
                                            <td className="px-6 py-4">
                                                {rec.sync_status === 'uploaded' || rec.cloud_job_id ? (
                                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                                                        <Cloud className="w-3 h-3" />
                                                        Synkad
                                                    </span>
                                                ) : (
                                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-50 text-yellow-700 border border-yellow-200">
                                                        <CloudUpload className="w-3 h-3" />
                                                        Ej synkad
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDelete(rec.id);
                                                        }}
                                                        className="h-8 w-8 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                                                        title="Radera permanent"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
