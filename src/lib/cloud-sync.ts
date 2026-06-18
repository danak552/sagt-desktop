import { invoke } from "@tauri-apps/api/core";
import { useSyncStore, AnalysisData } from "@/store/sync-store";
import { useTranscriptionStore, UISegment } from "@/store/transcription-store";
import type { Job } from "./api";

/**
 * Fas 1c: extrahera strukturerade DU/MÖTET-turer ur ett molnresultat (stereo-omtranskribering)
 * som JSON för persistens i `cloud_segments`. Returnerar null när segmenten saknar riktiga
 * talare (mono-resultat) — då behålls den flata `cloud_transcript`-blobben i molnvyn.
 * Backend-segmenten bär `{start, end, text, speaker}`; vi normaliserar till lagringsformen
 * `{start_time, end_time, text, speaker}` som split-view:s render läser direkt.
 */
export function cloudSegmentsJsonFromJob(job: Job): string | null {
    const raw: any[] = Array.isArray(job.result?.segments) ? job.result.segments : [];
    const hasSpeakers = raw.some(s => s?.speaker === "DU" || s?.speaker === "MÖTET");
    if (!hasSpeakers) return null;
    const mapped = raw
        .filter(s => (s?.text ?? "").toString().trim())
        .map(s => ({
            start_time: typeof s.start === "number" ? s.start : 0,
            end_time: typeof s.end === "number" ? s.end : 0,
            text: String(s.text).trim(),
            speaker: s.speaker || "MÖTET",
        }));
    return mapped.length > 0 ? JSON.stringify(mapped) : null;
}

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
    // Fas 1c: strukturerade DU/MÖTET-turer (stereo) → rendera turer i molnvyn i stället för
    // den flata blobben. Null för mono (inga talare) → flat blob behålls.
    const cloudSegmentsJson = cloudSegmentsJsonFromJob(job);
    let wordCount = 0;
    if (cloudText && cloudText.trim()) {
        wordCount = cloudText.trim().split(/\s+/).filter(Boolean).length;
        // Skriv ALDRIG över lokala/diariserade segment — molnresultatet lagras separat
        // (cloud_transcript/cloud_segments) och visas via modellväxlaren i SplitView. Endast
        // när inget annat resultat finns (batch-only) OCH molnet saknar strukturerade turer
        // sätts den flata blobben direkt som segment; med strukturerade turer renderar molnvyn
        // dem via activeJob.cloud_segments (ingen falsk "lokal"-flik med samma text).
        if (useTranscriptionStore.getState().segments.length === 0 && !cloudSegmentsJson) {
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
            // Skriv ALLTID cloud_segments (tom sträng = rensa) så DB och in-memory aldrig
            // divergerar — annars skulle en stereo→mono-omtranskribering lämna kvar gamla
            // turer i DB medan activeJob nollställs → stale turer vid återöppning.
            await invoke("save_cloud_segments_to_db", {
                id: recordingDbId,
                cloudSegments: cloudSegmentsJson || "",
            });
        } catch (e) {
            console.error("Local save (inline cloud result) failed:", e);
        }
    }

    // Uppdatera activeJob med cloud_transcript + cloud_segments — men INGET cloud_job_id (ej synkat till moln).
    const activeJob = sync.activeJob;
    if (activeJob) {
        sync.setActiveJob({
            ...activeJob,
            analysis_json: JSON.stringify(completedAnalysis),
            cloud_transcript: cloudText || null,
            cloud_segments: cloudSegmentsJson,
        });
    }

    return wordCount;
}
