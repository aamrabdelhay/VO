export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

export const NVIDIA_MODELS = {
  omni: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  diffusionGemma: "google/diffusiongemma-26b-a4b-it",
  mistralNemotron: "mistralai/mistral-nemotron",
  deepseekV4: "deepseek-ai/deepseek-v4-flash-0731",
  cosmos3Nano: "nvidia/cosmos3-nano",
  voiceChat: "nvidia/nemotron-voicechat",
  magpieZeroShot: "nvidia/magpie-tts-zeroshot",
} as const;

export const NVIDIA_CAPABILITIES = {
  [NVIDIA_MODELS.omni]: ["text", "image", "audio", "video", "ocr", "reasoning", "function-calling"],
  [NVIDIA_MODELS.diffusionGemma]: ["text", "image", "video", "reasoning"],
  [NVIDIA_MODELS.mistralNemotron]: ["text", "coding", "function-calling", "agent"],
  [NVIDIA_MODELS.deepseekV4]: ["text", "reasoning", "coding", "function-calling", "structured-output"],
  [NVIDIA_MODELS.cosmos3Nano]: ["text-to-video", "image-to-video", "video-generation"],
  [NVIDIA_MODELS.voiceChat]: ["realtime-speech-to-speech", "full-duplex", "voice"],
  [NVIDIA_MODELS.magpieZeroShot]: ["text-to-speech", "voice-style"],
} as const;

export type NvidiaModelId = (typeof NVIDIA_MODELS)[keyof typeof NVIDIA_MODELS];
export type NvidiaPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } }
  | { type: "audio_url"; audio_url: { url: string } };

export function isNvidiaModel(value: string): value is NvidiaModelId {
  return Object.values(NVIDIA_MODELS).includes(value as NvidiaModelId);
}

export function modelSupportsFile(model: NvidiaModelId, media: "image" | "video" | "audio") {
  if (model === NVIDIA_MODELS.omni) return true;
  if (model === NVIDIA_MODELS.diffusionGemma) return media !== "audio";
  return false;
}
