import { handle, ok, readJson } from "@/lib/api";
import { assertCsrf, requirePlatformAdmin } from "@/lib/auth";
import { getPlatformSecret, listPlatformSecretMetadata } from "@/lib/platform-secrets";

export const dynamic = "force-dynamic";
const OPENROUTER = "https://openrouter.ai/api/v1";
const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-image-preview";
const DEFAULT_VIDEO_MODEL = "google/veo-3.1-lite";

async function resolveSecret(name: "OPENROUTER_API_KEY") {
  return (await getPlatformSecret(name)) ?? process.env[name] ?? null;
}

async function requireOpenRouterKey() {
  const value = await resolveSecret("OPENROUTER_API_KEY");
  if (value) return value;
  const stored = (await listPlatformSecretMetadata()).some((item) => item.key === "OPENROUTER_API_KEY");
  throw new Error(stored ? "OPENROUTER_API_KEY exists in VO Settings but cannot be decrypted in this deployment. Re-save the key once in Settings." : "OPENROUTER_API_KEY is not configured in VO → Settings.");
}

export async function GET(request: Request) {
  return handle(async () => {
    await requirePlatformAdmin();
    const key = await resolveSecret("OPENROUTER_API_KEY");
    if (!key) return ok({ image: false, video: false, audio: false, reason: "OPENROUTER_API_KEY unavailable" });
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId");
    if (jobId) {
      const response = await fetch(`${OPENROUTER}/videos/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" });
      if (!response.ok) throw new Error(`OpenRouter video status failed (${response.status}): ${await response.text()}`);
      return ok({ video: await response.json() });
    }
    return ok({ image: true, video: true, audio: true, imageModel: DEFAULT_IMAGE_MODEL, videoModel: DEFAULT_VIDEO_MODEL });
  });
}

type Body = { kind?: "image" | "image-edit" | "video"; prompt?: string; model?: string; imageUrl?: string; duration?: number; resolution?: string; aspectRatio?: string; generateAudio?: boolean };

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    const body = await readJson<Body>(request);
    const kind = body.kind ?? "image";
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt && kind !== "image-edit") throw new Error("Prompt is required");
    const key = await requireOpenRouterKey();

    if (kind === "image" || kind === "image-edit") {
      const input: Record<string, unknown> = { model: body.model || DEFAULT_IMAGE_MODEL, prompt: prompt || "Edit the supplied image while preserving the subject and overall composition." };
      if (kind === "image-edit") {
        if (!body.imageUrl || !/^https:\/\//i.test(body.imageUrl)) throw new Error("imageUrl must be a public HTTPS image URL");
        input.input_references = [{ type: "image_url", image_url: { url: body.imageUrl } }];
      }
      const response = await fetch(`${OPENROUTER}/images`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(input), cache: "no-store" });
      if (!response.ok) throw new Error(`OpenRouter image generation failed (${response.status}): ${await response.text()}`);
      const data = await response.json() as { data?: { b64_json?: string; url?: string }[]; usage?: unknown };
      const image = data.data?.[0];
      if (!image?.b64_json && !image?.url) throw new Error("OpenRouter returned no image");
      return ok({ kind, image: image.b64_json ? `data:image/png;base64,${image.b64_json}` : image.url, usage: data.usage ?? null });
    }

    const response = await fetch(`${OPENROUTER}/videos`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: body.model || DEFAULT_VIDEO_MODEL, prompt, duration: body.duration ?? 4, resolution: body.resolution ?? "720p", aspect_ratio: body.aspectRatio ?? "16:9", generate_audio: body.generateAudio ?? true }), cache: "no-store" });
    if (!response.ok) throw new Error(`OpenRouter video generation failed (${response.status}): ${await response.text()}`);
    return ok({ kind: "video", job: await response.json() });
  });
}
