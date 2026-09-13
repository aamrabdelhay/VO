import { handle, ok } from "@/lib/api";
import { assertCsrf, requirePlatformAdmin } from "@/lib/auth";
import { getPlatformSecret, listPlatformSecretMetadata } from "@/lib/platform-secrets";

export const dynamic = "force-dynamic";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";

async function getNvidiaKey() {
  const value = (await getPlatformSecret("NVIDIA_API_KEY")) ?? process.env.NVIDIA_API_KEY ?? null;
  if (value) return value;
  const stored = (await listPlatformSecretMetadata()).some((item) => item.key === "NVIDIA_API_KEY");
  throw new Error(stored ? "NVIDIA_API_KEY exists in VO Settings but cannot be decrypted in this deployment. Re-save the key once in Settings." : "NVIDIA_API_KEY is not configured in VO → Settings.");
}

function dataUrl(file: File) {
  if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type) && !/^video\/(mp4|webm|quicktime)$/.test(file.type) && !/^audio\/(wav|mpeg|mp3|webm)$/.test(file.type)) throw new Error("Supported files: PNG, JPG, JPEG, WEBP, MP4, MOV, WEBM, WAV, MP3.");
  return file.arrayBuffer().then((buffer) => `data:${file.type};base64,${Buffer.from(buffer).toString("base64")}`);
}

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    const form = await request.formData();
    const file = form.get("file");
    const prompt = String(form.get("prompt") ?? "Describe and analyze this file in detail, extract visible text, and point out important details.").slice(0, 12000);
    if (!(file instanceof File)) throw new Error("file is required");
    if (file.size > 20 * 1024 * 1024) throw new Error("File is too large (max 20 MB).");
    const key = await getNvidiaKey();
    const url = await dataUrl(file);
    let type: "image_url" | "video_url" | "audio_url" = "image_url";
    if (file.type.startsWith("video/")) type = "video_url";
    if (file.type.startsWith("audio/")) type = "audio_url";
    const content = [{ type: "text", text: prompt }, { type, ...(type === "image_url" ? { image_url: { url } } : type === "video_url" ? { video_url: { url } } : { audio_url: { url } }) }];
    const response = await fetch(NVIDIA_URL, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content }], max_tokens: 4096, temperature: 0.2, stream: false, chat_template_kwargs: { enable_thinking: false } }), cache: "no-store" });
    if (!response.ok) throw new Error(`NVIDIA vision request failed (${response.status}): ${await response.text()}`);
    const result = await response.json() as { choices?: { message?: { content?: string } }[] };
    return ok({ answer: result.choices?.[0]?.message?.content ?? "", fileName: file.name, model: MODEL });
  });
}
