import { handle, ok } from "@/lib/api";
import { assertCsrf, requirePlatformAdmin } from "@/lib/auth";
import { multiAgentComplete, type ChatMessage } from "@/lib/ai/provider";
import { getPlatformSecret } from "@/lib/platform-secrets";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    const form = await request.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) throw new Error("audio file is required");
    if (file.size > 25 * 1024 * 1024) throw new Error("Audio file is too large (max 25 MB)");

    const groqKey = await getPlatformSecret("GROQ_API_KEY");
    const openRouterKey = await getPlatformSecret("OPENROUTER_API_KEY");
    if (!groqKey) throw new Error("GROQ_API_KEY is not configured in VO → Settings.");
    if (!openRouterKey) throw new Error("OPENROUTER_API_KEY is not configured in VO → Settings.");

    const transcription = new FormData();
    transcription.append("file", file, file.name || "voice.webm");
    transcription.append("model", "whisper-large-v3-turbo");
    transcription.append("response_format", "json");
    const stt = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${groqKey}` }, body: transcription });
    if (!stt.ok) throw new Error(`Speech-to-text failed (${stt.status}): ${await stt.text()}`);
    const sttData = await stt.json() as { text?: string };
    const text = String(sttData.text ?? "").trim();
    if (!text) throw new Error("No speech was detected.");

    const messages: ChatMessage[] = [
      { role: "system", content: "You are Garvex Voice. Answer naturally and concisely. This voice channel is read-only unless the user explicitly asks for a supported Build & Fix operation. Never claim an action happened unless the system actually performed it." },
      { role: "user", content: text },
    ];
    const result = await multiAgentComplete(messages, { strategy: "complex", timeoutMs: 4500, maxWorkers: 12, quorum: 3 });

    const ttsModel = process.env.GARVEX_TTS_MODEL || "mistralai/voxtral-mini-tts-2603";
    const ttsVoice = process.env.GARVEX_TTS_VOICE || "en_paul_neutral";
    const tts = await fetch("https://openrouter.ai/api/v1/audio/speech", { method: "POST", headers: { Authorization: `Bearer ${openRouterKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: ttsModel, voice: ttsVoice, input: result.text.slice(0, 8000), response_format: "mp3" }) });
    if (!tts.ok) throw new Error(`Text-to-speech failed (${tts.status}): ${await tts.text()}`);
    const contentType = tts.headers.get("content-type")?.split(";")[0] ?? "audio/mpeg";
    if (!contentType.startsWith("audio/")) throw new Error(`Unexpected TTS response: ${contentType}`);
    const audioBase64 = Buffer.from(await tts.arrayBuffer()).toString("base64");
    return ok({ transcript: text, answer: result.text, provider: result.provider, model: result.model, workers: result.workers, audio: `data:${contentType};base64,${audioBase64}` });
  });
}
