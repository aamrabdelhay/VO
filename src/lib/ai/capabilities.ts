import { getPlatformSecretValues } from "@/lib/platform-secrets";
import { NVIDIA_MODELS, NVIDIA_REQUESTED_MODELS } from "@/lib/ai/nvidia-catalog";

export type CapabilityKind =
  | "text"
  | "audio-transcription"
  | "multimodal-understanding"
  | "image-generation"
  | "image-edit"
  | "document-parse"
  | "video-generation"
  | "voice-realtime";

export type CapabilityState = "ready" | "fallback" | "unavailable";

export type CapabilityProvider = {
  provider: string;
  model: string;
  credential: string;
  available: boolean;
  state: CapabilityState;
  reason?: string;
};

export type CapabilityPlan = {
  capability: CapabilityKind;
  primary: CapabilityProvider;
  fallbacks: CapabilityProvider[];
};

const ENV_BY_PROVIDER: Record<string, string> = {
  nvidia: "NVIDIA_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  kilo: "KILO_API_KEY",
  cohere: "COHERE_API_KEY",
};

const PLANS: Record<CapabilityKind, Omit<CapabilityPlan, "primary" | "fallbacks"> & { primary: CapabilityProvider; fallbacks: CapabilityProvider[] }> = {
  text: {
    capability: "text",
    primary: { provider: "nvidia", model: NVIDIA_MODELS.deepseekV4, credential: "NVIDIA_API_KEY", available: true, state: "ready" },
    fallbacks: [
      { provider: "nvidia", model: NVIDIA_MODELS.deepseekV4Pro, credential: "NVIDIA_API_KEY", available: true, state: "ready" },
      { provider: "nvidia", model: NVIDIA_MODELS.nemotron35Lightning, credential: "NVIDIA_API_KEY", available: true, state: "ready" },
      { provider: "openrouter", model: "openrouter/free", credential: "OPENROUTER_API_KEY", available: true, state: "ready" },
      { provider: "mistral", model: "mistral-small-latest", credential: "MISTRAL_API_KEY", available: true, state: "ready" },
    ],
  },
  "audio-transcription": {
    capability: "audio-transcription",
    primary: { provider: "nvidia", model: NVIDIA_REQUESTED_MODELS.parakeet, credential: "NVIDIA_API_KEY", available: false, state: "unavailable", reason: "Current NVIDIA catalog does not list the general Parakeet TDT model as a Free Endpoint." },
    fallbacks: [{ provider: "groq", model: "whisper-large-v3-turbo", credential: "GROQ_API_KEY", available: true, state: "fallback", reason: "Current working STT fallback in VO." }],
  },
  "multimodal-understanding": {
    capability: "multimodal-understanding",
    primary: { provider: "nvidia", model: NVIDIA_MODELS.omni, credential: "NVIDIA_API_KEY", available: true, state: "ready" },
    fallbacks: [{ provider: "nvidia", model: "muse-glimmer-30b", credential: "NVIDIA_API_KEY", available: true, state: "fallback", reason: "Image-understanding fallback only; not equivalent for audio/video." }],
  },
  "image-generation": {
    capability: "image-generation",
    primary: { provider: "nvidia", model: "qwen-image", credential: "NVIDIA_API_KEY", available: false, state: "unavailable", reason: "Current NVIDIA catalog lists Qwen Image as downloadable, not Free Endpoint." },
    fallbacks: [{ provider: "openrouter", model: "google/gemini-3.1-flash-image-preview", credential: "OPENROUTER_API_KEY", available: true, state: "fallback", reason: "Existing VO image-generation path." }],
  },
  "image-edit": {
    capability: "image-edit",
    primary: { provider: "nvidia", model: "qwen-image-edit", credential: "NVIDIA_API_KEY", available: false, state: "unavailable", reason: "Current NVIDIA catalog lists Qwen Image Edit as downloadable, not Free Endpoint." },
    fallbacks: [{ provider: "openrouter", model: "google/gemini-3.1-flash-image-preview", credential: "OPENROUTER_API_KEY", available: true, state: "fallback", reason: "Existing VO image editing path." }],
  },
  "document-parse": {
    capability: "document-parse",
    primary: { provider: "nvidia", model: NVIDIA_REQUESTED_MODELS.nemotronParse, credential: "NVIDIA_API_KEY", available: false, state: "unavailable", reason: "Current NVIDIA catalog lists Nemotron Parse as downloadable, not Free Endpoint." },
    fallbacks: [{ provider: "nvidia", model: NVIDIA_MODELS.omni, credential: "NVIDIA_API_KEY", available: true, state: "fallback", reason: "Use only after document content is converted to supported image/audio/video/text inputs; this is not PDF parsing by itself." }],
  },
  "video-generation": {
    capability: "video-generation",
    primary: { provider: "nvidia", model: NVIDIA_MODELS.cosmos3Nano, credential: "NVIDIA_API_KEY", available: true, state: "ready", reason: "Free Endpoint exists, but the hosted API is specialized and is not routed through the generic chat adapter." },
    fallbacks: [{ provider: "openrouter", model: "google/veo-3.1-lite", credential: "OPENROUTER_API_KEY", available: true, state: "fallback", reason: "Existing VO video-generation path." }],
  },
  "voice-realtime": {
    capability: "voice-realtime",
    primary: { provider: "nvidia", model: NVIDIA_MODELS.voiceChat, credential: "NVIDIA_API_KEY", available: true, state: "ready", reason: "Free Endpoint with specialized realtime/full-duplex transport." },
    fallbacks: [{ provider: "groq", model: "whisper-large-v3-turbo", credential: "GROQ_API_KEY", available: true, state: "fallback", reason: "Batch voice path in VO; not equivalent to full-duplex voice." }],
  },
};

async function configured(credential: string) {
  const stored = await getPlatformSecretValues(credential);
  return stored.length > 0 || Boolean(process.env[credential]);
}

async function hydrateProvider(provider: CapabilityProvider): Promise<CapabilityProvider> {
  if (!provider.available) return provider;
  const configuredNow = await configured(provider.credential);
  if (configuredNow) return provider;
  const envName = ENV_BY_PROVIDER[provider.provider];
  const hasEnv = Boolean(envName && process.env[envName]);
  return hasEnv
    ? { ...provider, available: true }
    : { ...provider, available: false, state: "unavailable", reason: `Credential ${provider.credential} is not configured or cannot be decrypted.` };
}

export async function getGarvexCapabilityPlans(): Promise<CapabilityPlan[]> {
  return Promise.all(Object.values(PLANS).map(async (plan) => {
    const primary = await hydrateProvider(plan.primary);
    const fallbacks = await Promise.all(plan.fallbacks.map(hydrateProvider));
    const firstAvailable = [primary, ...fallbacks].find((item) => item.available);
    if (!firstAvailable) return { capability: plan.capability, primary, fallbacks };
    if (primary.available) return { capability: plan.capability, primary, fallbacks };
    const fallbackIndex = fallbacks.findIndex((item) => item.available);
    const promoted = fallbackIndex >= 0 ? { ...fallbacks[fallbackIndex], state: "fallback" as const } : primary;
    return { capability: plan.capability, primary: promoted, fallbacks };
  }));
}

export function getCapabilityPlan(capability: CapabilityKind): CapabilityPlan {
  const plan = PLANS[capability];
  return { capability: plan.capability, primary: plan.primary, fallbacks: [...plan.fallbacks] };
}
