import { getPlatformSecretValues } from "@/lib/platform-secrets";
import { NVIDIA_MODELS, NVIDIA_REQUESTED_MODELS } from "@/lib/ai/nvidia-catalog";

export type CapabilityKind = "text" | "audio-transcription" | "multimodal-understanding" | "image-generation" | "image-edit" | "document-parse" | "video-generation" | "voice-realtime";
export type CapabilityState = "ready" | "fallback" | "unavailable";
export type CapabilityProvider = { provider: string; model: string; credential: string; available: boolean; state: CapabilityState; reason?: string };
export type CapabilityPlan = { capability: CapabilityKind; primary: CapabilityProvider; fallbacks: CapabilityProvider[] };

const ENV_BY_PROVIDER: Record<string, string> = { nvidia: "NVIDIA_API_KEY", groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY", mistral: "MISTRAL_API_KEY", cerebras: "CEREBRAS_API_KEY", kilo: "KILO_API_KEY", cohere: "COHERE_API_KEY" };

const PLANS: Record<CapabilityKind, CapabilityPlan> = {
  text: {
    capability: "text",
    primary: { provider: "nvidia", model: NVIDIA_MODELS.deepseekV4, credential: "NVIDIA_API_KEY", available: true, state: "ready" },
    fallbacks: [
      { provider: "nvidia", model: NVIDIA_MODELS.deepseekV4Pro, credential: "NVIDIA_API_KEY", available: true, state: "fallback" },
      { provider: "nvidia", model: NVIDIA_MODELS.glm52, credential: "NVIDIA_API_KEY", available: true, state: "fallback" },
      { provider: "nvidia", model: NVIDIA_MODELS.nemotron35Lightning, credential: "NVIDIA_API_KEY", available: true, state: "fallback" },
      { provider: "openrouter", model: "openrouter/free", credential: "OPENROUTER_API_KEY", available: true, state: "fallback", reason: "Existing cross-provider fallback." },
      { provider: "mistral", model: "mistral-small-latest", credential: "MISTRAL_API_KEY", available: true, state: "fallback", reason: "Existing cross-provider fallback." },
    ],
  },
  "audio-transcription": {
    capability: "audio-transcription",
    primary: { provider: "nvidia", model: NVIDIA_REQUESTED_MODELS.parakeet, credential: "NVIDIA_API_KEY", available: false, state: "unavailable", reason: "Current NVIDIA catalog lists the general Parakeet TDT model as downloadable, not Free Endpoint." },
    fallbacks: [{ provider: "groq", model: "whisper-large-v3-turbo", credential: "GROQ_API_KEY", available: true, state: "fallback", reason: "Current VO batch STT implementation." }],
  },
  "multimodal-understanding": {
    capability: "multimodal-understanding",
    primary: { provider: "nvidia", model: NVIDIA_MODELS.omni, credential: "NVIDIA_API_KEY", available: true, state: "ready" },
    fallbacks: [{ provider: "nvidia", model: NVIDIA_MODELS.museGlimmer, credential: "NVIDIA_API_KEY", available: true, state: "fallback", reason: "Image understanding only; not an audio/video equivalent." }],
  },
  "image-generation": {
    capability: "image-generation",
    primary: { provider: "nvidia", model: NVIDIA_REQUESTED_MODELS.qwenImage, credential: "NVIDIA_API_KEY", available: false, state: "unavailable", reason: "Qwen Image is currently listed as Downloadable, not Free Endpoint." },
    fallbacks: [{ provider: "openrouter", model: "google/gemini-3.1-flash-image-preview", credential: "OPENROUTER_API_KEY", available: true, state: "fallback", reason: "Existing VO image-generation path." }],
  },
  "image-edit": {
    capability: "image-edit",
    primary: { provider: "nvidia", model: NVIDIA_REQUESTED_MODELS.qwenImageEdit, credential: "NVIDIA_API_KEY", available: false, state: "unavailable", reason: "Qwen Image Edit is currently listed as Downloadable, not Free Endpoint." },
    fallbacks: [{ provider: "openrouter", model: "google/gemini-3.1-flash-image-preview", credential: "OPENROUTER_API_KEY", available: true, state: "fallback", reason: "Existing VO image editing path." }],
  },
  "document-parse": {
    capability: "document-parse",
    primary: { provider: "nvidia", model: NVIDIA_REQUESTED_MODELS.nemotronParse, credential: "NVIDIA_API_KEY", available: false, state: "unavailable", reason: "Nemotron Parse 2.0 is currently listed as Downloadable, not Free Endpoint." },
    fallbacks: [{ provider: "nvidia", model: NVIDIA_MODELS.omni, credential: "NVIDIA_API_KEY", available: true, state: "fallback", reason: "Use only after the document is converted to supported image/text inputs; it is not a native PDF parser." }],
  },
  "video-generation": {
    capability: "video-generation",
    primary: { provider: "nvidia", model: NVIDIA_MODELS.cosmos3Nano, credential: "NVIDIA_API_KEY", available: true, state: "ready", reason: "Free Endpoint exists; hosted generation contract is specialized." },
    fallbacks: [{ provider: "openrouter", model: "google/veo-3.1-lite", credential: "OPENROUTER_API_KEY", available: true, state: "fallback", reason: "Existing VO video-generation path." }],
  },
  "voice-realtime": {
    capability: "voice-realtime",
    primary: { provider: "nvidia", model: NVIDIA_MODELS.voiceChat, credential: "NVIDIA_API_KEY", available: true, state: "ready", reason: "Free Endpoint with specialized realtime/full-duplex transport." },
    fallbacks: [{ provider: "groq", model: "whisper-large-v3-turbo", credential: "GROQ_API_KEY", available: true, state: "fallback", reason: "VO batch voice fallback; not equivalent to full-duplex speech-to-speech." }],
  },
};

async function hydrateProvider(provider: CapabilityProvider): Promise<CapabilityProvider> {
  if (!provider.available) return provider;
  const stored = await getPlatformSecretValues(provider.credential);
  const configured = stored.length > 0 || Boolean(process.env[provider.credential]);
  if (configured) return provider;
  const envName = ENV_BY_PROVIDER[provider.provider];
  if (envName && process.env[envName]) return provider;
  return { ...provider, available: false, state: "unavailable", reason: `Credential ${provider.credential} is not configured or cannot be decrypted.` };
}

export async function getGarvexCapabilityPlans(): Promise<CapabilityPlan[]> {
  return Promise.all(Object.values(PLANS).map(async (plan) => {
    const primary = await hydrateProvider(plan.primary);
    const fallbacks = await Promise.all(plan.fallbacks.map(hydrateProvider));
    if (primary.available) return { capability: plan.capability, primary, fallbacks };
    const replacement = fallbacks.find((candidate) => candidate.available);
    return replacement
      ? { capability: plan.capability, primary: { ...replacement, state: "fallback" as const }, fallbacks }
      : { capability: plan.capability, primary, fallbacks };
  }));
}

export function getCapabilityPlan(capability: CapabilityKind): CapabilityPlan {
  const plan = PLANS[capability];
  return { capability: plan.capability, primary: plan.primary, fallbacks: [...plan.fallbacks] };
}
