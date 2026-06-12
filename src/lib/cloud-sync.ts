import { invoke } from "@tauri-apps/api/core";
import { useSyncStore, AnalysisData } from "@/store/sync-store";
import { useTranscriptionStore, UISegment } from "@/store/transcription-store";
import type { Job } from "./api";

/**
 * Applicerar ett INLINE molnresultat (persist=false / cloudSync av) direkt i UI-storarna
 * UTAN polling. Speglar polling-COMPLETED-handlern i split-view, men eftersom backend
 * raderar moln-jobbet direkt finns inget att polla — resultatet kom inline i POST-svaret.
 *
 * Sparar resultatet i LOKAL sqlite (inget i molnet, inget cloud_job_id). Returnerar
 * ordantal för `events.cloudSyncCompleted`-analytics.
 */
export async function applyInlineCloudResult(job: Job, recordingDbId: number | null): Promise<number> {
    const sync = useSyncStore.getState();

    const analysis = job.analysis || {};
    const completedAnalysis: AnalysisData = {
        summary: analysis.summary || "",
        decisions: analysis.key_decisions || [],
        actions: analysis.action_items || [],
        template_used: analysis.template_used,
    };
    sync.setAnalysisData(completedAnalysis);
    sync.setProcessingStatus("COMPLETED");

    const cloudText: string | undefined = job.result?.text;
    let wordCount = 0;
    if (cloudText && cloudText.trim()) {
        wordCount = cloudText.trim().split(/\s+/).filter(Boolean).length;
        // Skriv ALDRIG över lokala/diariserade segment — molnresultatet lagras separat
        // (cloud_transcript) och visas via modellväxlaren i SplitView. Endast när inget
        // annat resultat finns (batch-only) sätts det direkt som segment.
        if (useTranscriptionStore.getState().segments.length === 0) {
            const cloudSegment: UISegment = {
                id: -1,
                start_time: 0,
                end_time: 0,
                text: cloudText.trim(),
                speaker: "MOLN",
                timestamp: Date.now(),
            };
            useTranscriptionStore.getState().setSegments([cloudSegment]);
        }
        // Persistera molnresultatet i lokal sqlite — modellväxlaren fungerar då även
        // efter omstart/återöppning från historiken.
        if (recordingDbId != null) {
            try {
                await invoke("save_cloud_transcript_to_db", {
                    id: recordingDbId,
                    transcript: cloudText.trim(),
                });
            } catch (e) {
                console.error("Local save (cloud transcript) failed:", e);
            }
        }
    }

    // Persist i LOKAL sqlite så resultatet överlever flikbyten — inget skickas/sparas i molnet.
    if (recordingDbId != null) {
        try {
            await invoke("save_analysis_to_db", {
                id: recordingDbId,
                analysis: JSON.stringify(completedAnalysis),
                template: completedAnalysis.template_used || "general",
            });
        } catch (e) {
            console.error("Local save (inline cloud result) failed:", e);
        }
    }

    // Uppdatera activeJob med cloud_transcript — men INGET cloud_job_id (ej synkat till moln).
    const activeJob = sync.activeJob;
    if (activeJob) {
        sync.setActiveJob({
            ...activeJob,
            analysis_json: JSON.stringify(completedAnalysis),
            cloud_transcript: cloudText || null,
        });
    }

    return wordCount;
}
