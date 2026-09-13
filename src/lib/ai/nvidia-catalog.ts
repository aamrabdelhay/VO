export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

export const NVIDIA_MODELS = {
  deepseekV4: "deepseek-ai/deepseek-v4-flash-0731",
  deepseekV4Pro: "deepseek-ai/deepseek-v4-pro-0813",
  glm52: "glm-5.2",
  nemotron35Lightning: "nvidia/nemotron-3.5-lightning-30b-a3b",
  omni: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  museGlimmer: "muse-glimmer-30b",
  cosmos3Nano: "nvidia/cosmos3-nano",
  voiceChat: "nvidia/nemotron-voicechat",
  magpieZeroShot: "nvidia/magpie-tts-zeroshot",
} as const;

export const NVIDIA_REQUESTED_MODELS = {
  qwenImage: "qwen-image",
  qwenImageEdit: "qwen-image-edit",
  parakeet: "parakeet-tdt-0.6b",
  nemotronParse: "nemotron-parse-2.0",
} as const;

export type NvidiaModelId = (typeof NVIDIA_MODELS)[keyof typeof NVIDIA_MODELS];
export type NvidiaPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } }
  | { type: "audio_url"; audio_url: { url: string } };
export type NvidiaCapability = "text" | "reasoning" | "coding" | "function-calling" | "structured-output" | "image-understanding" | "video-understanding" | "audio-understanding" | "ocr" | "image-only-understanding" | "video-generation" | "realtime-voice" | "text-to-speech";
export type NvidiaModelInfo = { id: NvidiaModelId; label: string; endpoint: string; freeEndpoint: boolean; chatCompletions: boolean; capabilities: readonly NvidiaCapability[]; maxInputMb?: number; note?: string };

export const NVIDIA_MODEL_CATALOG: readonly NvidiaModelInfo[] = [
  { id: NVIDIA_MODELS.deepseekV4, label: "DeepSeek V4 Flash", endpoint: `${NVIDIA_BASE_URL}/chat/completions`, freeEndpoint: true, chatCompletions: true, capabilities: ["text", "reasoning", "coding", "function-calling", "structured-output"] },
  { id: NVIDIA_MODELS.deepseekV4Pro, label: "DeepSeek V4 Pro", endpoint: `${NVIDIA_BASE_URL}/chat/completions`, freeEndpoint: true, chatCompletions: true, capabilities: ["text", "reasoning", "coding", "function-calling", "structured-output"] },
  { id: NVIDIA_MODELS.glm52, label: "GLM-5.2", endpoint: `${NVIDIA_BASE_URL}/chat/completions`, freeEndpoint: true, chatCompletions: true, capabilities: ["text", "reasoning", "coding", "function-calling"] },
  { id: NVIDIA_MODELS.nemotron35Lightning, label: "Nemotron 3.5 Lightning", endpoint: `${NVIDIA_BASE_URL}/chat/completions`, freeEndpoint: true, chatCompletions: true, capabilities: ["text", "reasoning", "coding", "function-calling"] },
  { id: NVIDIA_MODELS.omni, label: "Nemotron 3 Nano Omni", endpoint: `${NVIDIA_BASE_URL}/chat/completions`, freeEndpoint: true, chatCompletions: true, capabilities: ["text", "reasoning", "image-understanding", "video-understanding", "audio-understanding", "ocr"], maxInputMb: 20 },
  { id: NVIDIA_MODELS.museGlimmer, label: "Muse Glimmer 30B", endpoint: `${NVIDIA_BASE_URL}/chat/completions`, freeEndpoint: true, chatCompletions: true, capabilities: ["text", "image-only-understanding"], note: "Image understanding only; not an image generator." },
  { id: NVIDIA_MODELS.cosmos3Nano, label: "Cosmos 3 Nano", endpoint: "NVIDIA-hosted/specialized", freeEndpoint: true, chatCompletions: false, capabilities: ["video-generation"], note: "Free Endpoint exists, but its hosted generation contract is specialized and is not routed through the generic chat adapter." },
  { id: NVIDIA_MODELS.voiceChat, label: "Nemotron VoiceChat", endpoint: "NVIDIA-hosted/streaming", freeEndpoint: true, chatCompletions: false, capabilities: ["realtime-voice"], note: "Realtime/full-duplex streaming uses a specialized transport." },
  { id: NVIDIA_MODELS.magpieZeroShot, label: "Magpie TTS ZeroShot", endpoint: "NVIDIA-hosted/specialized", freeEndpoint: true, chatCompletions: false, capabilities: ["text-to-speech"], note: "Specialized TTS contract; not a generic chat model." },
] as const;

export function getNvidiaModelInfo(model: NvidiaModelId) { return NVIDIA_MODEL_CATALOG.find((item) => item.id === model) ?? null; }
export function isNvidiaModel(value: string): value is NvidiaModelId { return NVIDIA_MODEL_CATALOG.some((item) => item.id === value); }
export function isNvidiaChatModel(value: string): value is NvidiaModelId { return NVIDIA_MODEL_CATALOG.some((item) => item.id === value && item.chatCompletions && item.freeEndpoint); }
export function modelSupportsFile(model: NvidiaModelId, media: "image" | "video" | "audio") { if (model === NVIDIA_MODELS.omni) return true; if (model === NVIDIA_MODELS.museGlimmer) return media === "image"; return false; }

export const NVIDIA_UNAVAILABLE_REQUESTS = [
  { id: NVIDIA_REQUESTED_MODELS.qwenImage, capability: "image-generation", status: "not-free-endpoint", note: "Current NVIDIA catalog lists Qwen Image as downloadable rather than Free Endpoint." },
  { id: NVIDIA_REQUESTED_MODELS.qwenImageEdit, capability: "image-edit", status: "not-free-endpoint", note: "Current NVIDIA catalog lists Qwen Image Edit as downloadable rather than Free Endpoint." },
  { id: NVIDIA_REQUESTED_MODELS.parakeet, capability: "audio-transcription", status: "not-free-endpoint", note: "Current NVIDIA catalog lists the general Parakeet TDT model as downloadable rather than Free Endpoint." },
  { id: NVIDIA_REQUESTED_MODELS.nemotronParse, capability: "document-parse", status: "not-free-endpoint", note: "Current NVIDIA catalog lists Nemotron Parse as downloadable rather than Free Endpoint." },
] as const;
