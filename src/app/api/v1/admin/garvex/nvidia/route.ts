import { handle, ok } from "@/lib/api";
import { assertCsrf, requirePlatformAdmin } from "@/lib/auth";
import { getPlatformSecret, listPlatformSecretMetadata } from "@/lib/platform-secrets";
import { isNvidiaChatModel, modelSupportsFile, NVIDIA_BASE_URL, NVIDIA_MODEL_CATALOG, NVIDIA_MODELS, type NvidiaModelId, type NvidiaPart } from "@/lib/ai/nvidia-catalog";
import { getCapabilityPlan, getGarvexCapabilityPlans } from "@/lib/ai/capabilities";

export const dynamic = "force-dynamic";

async function keyOrThrow() {
  const key = (await getPlatformSecret("NVIDIA_API_KEY")) ?? process.env.NVIDIA_API_KEY ?? null;
  if (key) return key;
  const stored = (await listPlatformSecretMetadata()).some((item) => item.key === "NVIDIA_API_KEY");
  throw new Error(stored ? "NVIDIA_API_KEY exists in VO Settings but cannot be decrypted in this deployment. Re-save the key once in Settings." : "NVIDIA_API_KEY is not configured in VO → Settings.");
}

function filePart(file: File): Promise<NvidiaPart> {
  return file.arrayBuffer().then((buffer) => {
    const url = `data:${file.type};base64,${Buffer.from(buffer).toString("base64")}`;
    if (file.type.startsWith("image/")) return { type: "image_url", image_url: { url } };
    if (file.type.startsWith("video/")) return { type: "video_url", video_url: { url } };
    if (file.type.startsWith("audio/")) return { type: "audio_url", audio_url: { url } };
    throw new Error("NVIDIA file input supports image, video, and audio files. PDF/DOCX/TXT require a document parser capability.");
  });
}

export async function GET() {
  return handle(async () => {
    await requirePlatformAdmin();
    return ok({
      baseUrl: NVIDIA_BASE_URL,
      models: NVIDIA_MODEL_CATALOG,
      capabilities: await getGarvexCapabilityPlans(),
    });
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    const form = await request.formData();
    const requested = String(form.get("model") ?? NVIDIA_MODELS.omni);
    if (!isNvidiaChatModel(requested)) {
      const unsupported = NVIDIA_MODEL_CATALOG.find((item) => item.id === requested);
      throw new Error(unsupported?.note ?? `NVIDIA model ${requested} is not available through the generic chat endpoint.`);
    }
    const model = requested as NvidiaModelId;
    const prompt = String(form.get("prompt") ?? "Analyze the provided input carefully and answer the user's request.").slice(0, 20000);
    const file = form.get("file");
    const parts: NvidiaPart[] = [{ type: "text", text: prompt }];
    if (file instanceof File && file.size > 0) {
      if (file.size > 20 * 1024 * 1024) throw new Error("File is too large (max 20 MB).");
      const media = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : null;
      if (!media || !modelSupportsFile(model, media)) throw new Error(`${model} does not support ${media ?? "this"} file input.`);
      parts.push(await filePart(file));
    }
    const key = await keyOrThrow();
    const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: parts }], max_tokens: model === NVIDIA_MODELS.deepseekV4 ? 16384 : 8192, temperature: model === NVIDIA_MODELS.deepseekV4 ? 0.8 : 0.3, top_p: 0.95, stream: false, ...(model === NVIDIA_MODELS.deepseekV4 ? { chat_template_kwargs: { thinking: true, reasoning_effort: "high" } } : {}) }), cache: "no-store" });
    if (!response.ok) throw new Error(`NVIDIA ${model} request failed (${response.status}): ${await response.text()}`);
    const data = await response.json() as { choices?: { message?: { content?: string } }[]; usage?: unknown };
    const plan = getCapabilityPlan("multimodal-understanding");
    return ok({ model, answer: data.choices?.[0]?.message?.content ?? "", usage: data.usage ?? null, fallback: plan.primary.model === model ? plan.fallbacks[0]?.model ?? null : null });
  });
}
