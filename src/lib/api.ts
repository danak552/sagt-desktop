import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/store/settings-store";

export interface Job {
    id: string;
    filename: string;
    status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
    created_at: string;
    retention_policy: string;
    // Analysis fields - returned as a nested object from backend
    analysis?: {
        summary?: string;
        key_decisions?: string[];
        action_items?: string[];
        template_used?: string;
    };
    result?: any;
    error_message?: string;
}

export async function uploadJob(filePath: string, templateId: string = "general", token: string, performAnalysis: boolean = true): Promise<Job> {
    const { backendUrl, retentionPolicy, transcriptionLanguage } = useSettingsStore.getState();

    // TODO: Replace localhost with https://api.sagt.ai for production builds. (We will inject this variable during the actual build command).

    // 1. Read file content from Tauri backend
    let fileBytes: number[];
    try {
        fileBytes = await invoke<number[]>("read_audio_file", { path: filePath });
    } catch (error) {
        console.error("Failed to read audio file:", error);
        throw new Error(`Could not read file at ${filePath}: ${error}`);
    }

    // 2. Create Blob/File
    const uint8Array = new Uint8Array(fileBytes);
    const blob = new Blob([uint8Array], { type: "audio/wav" });
    const filename = filePath.split(/[/\\]/).pop() || "session.wav";
    const file = new File([blob], filename, { type: "audio/wav" });

    // 3. Prepare FormData
    const formData = new FormData();
    formData.append("file", file);
    formData.append("retention_policy", retentionPolicy);
    formData.append("template_id", templateId);
    formData.append("perform_analysis", String(performAnalysis));
    formData.append("language", transcriptionLanguage ?? "sv");

    // 4. Upload
    // Ensure backendUrl doesn't have trailing slash if we add one, or handle it
    let baseUrl = backendUrl.replace(/\/$/, "");

    // STRICTLY ensure /api/v1 suffix
    if (!baseUrl.endsWith("/api/v1")) {
        // If the user already pasted /api/v1 just ensure we don't double it (handled by check above)
        // Check if it ends with /api (without v1) logic? No, just straightforward append if missing.
        // User might have entered "backend.com/api" -> "backend.com/api/api/v1" - hopefully not often.
        // Let's assume user enters base domain or full api path.
        // But the requirement is explicit: "strictly verify that the resulting string is [BASE_URL]/api/v1"
        baseUrl = `${baseUrl}/api/v1`;
    }

    const url = `${baseUrl}/jobs`;

    console.log(`[Upload] Uploading to: ${url}`);
    console.debug(`[Upload] Backend URL determined as: ${baseUrl}`);

    const headers: HeadersInit = {
        "Authorization": `Bearer ${token}`
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: formData,
        });

        if (!response.ok) {
            const errorText = await response.text();
            let parsedError = errorText;
            try {
                const parsed = JSON.parse(errorText);
                if (parsed.detail) parsedError = parsed.detail;
            } catch (e) { }

            if (response.status === 401) {
                throw new Error(`Unauthorized: ${parsedError}`);
            }
            if (response.status === 402) {
                throw new Error(`Payment Required: Denna funktion kräver Pro. Vänligen uppgradera via webbportalen.`);
            }
            throw new Error(`Kunde inte ladda upp: ${parsedError}`);
        }

        return await response.json();
    } catch (error: any) {
        console.error("🔥 API Upload Error:", error);
        if (error.response) {
            console.error("Response data:", error.response.data);
        }

        if (error instanceof Error && error.message.startsWith("Unauthorized")) {
            throw error;
        }
        if (error instanceof Error && error.message.includes("Payment Required")) {
            throw error;
        }

        if (error instanceof TypeError && error.message.includes("Failed to fetch")) {
            throw new Error(`Kunde inte nå servern på "${baseUrl}". Kontrollera att servern är igång och att URL:en i inställningar är korrekt.`);
        }

        throw new Error(`Upload failed: ${error?.name} - ${error?.message}`);
    }
}

export async function getJob(jobId: string, token: string): Promise<Job> {
    const { backendUrl } = useSettingsStore.getState();

    // Ensure URL construction matches uploadJob logic
    let baseUrl = backendUrl.replace(/\/$/, "");
    if (!baseUrl.endsWith("/api/v1")) {
        baseUrl = `${baseUrl}/api/v1`;
    }

    const url = `${baseUrl}/jobs/${jobId}`;

    const headers: HeadersInit = {
        "Authorization": `Bearer ${token}`
    };

    try {
        const response = await fetch(url, {
            method: "GET",
            headers,
        });

        if (!response.ok) {
            const errorText = await response.text();
            let parsedError = errorText;
            try {
                const parsed = JSON.parse(errorText);
                if (parsed.detail) parsedError = parsed.detail;
            } catch (e) { }

            if (response.status === 402) {
                throw new Error(`Payment Required: Denna funktion kräver Pro. Vänligen uppgradera via webbportalen.`);
            }
            throw new Error(`Misslyckades att hämta jobb: ${parsedError}`);
        }

        return await response.json();
    } catch (error) {
        console.error("Failed to fetch job:", error);
        throw error;
    }
}

export async function reanalyzeTranscript(text: string, templateId: string = "general", token: string): Promise<any> {
    const { backendUrl } = useSettingsStore.getState();

    let baseUrl = backendUrl.replace(/\/$/, "");
    if (!baseUrl.endsWith("/api/v1")) {
        baseUrl = `${baseUrl}/api/v1`;
    }
    const url = `${baseUrl}/analyze`;

    const headers: HeadersInit = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ text, template_id: templateId }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            let parsedError = errorText;
            try {
                const parsed = JSON.parse(errorText);
                if (parsed.detail) parsedError = parsed.detail;
            } catch (e) { }

            if (response.status === 401) {
                throw new Error(`Unauthorized: ${parsedError}`);
            }
            if (response.status === 402) {
                throw new Error(`Payment Required: Denna funktion kräver Pro. Vänligen uppgradera via webbportalen.`);
            }
            throw new Error(`Re-analys misslyckades: ${parsedError}`);
        }

        return await response.json();
    } catch (error: any) {
        console.error("🔥 API Reanalyze Error:", error);
        if (error.response) {
            console.error("Response data:", error.response.data);
        }

        if (error instanceof Error && error.message.startsWith("Unauthorized")) {
            throw error;
        }
        if (error instanceof Error && error.message.includes("Payment Required")) {
            throw error;
        }

        throw error;
    }
}
