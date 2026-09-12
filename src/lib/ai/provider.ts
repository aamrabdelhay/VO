import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiConfigs, aiMessages } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { getPlatformSecret } from "@/lib/platform-secrets";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type CompletionResult = {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  provider: string;
  model: string;
};

export interface AIProvider {
  readonly name: string;
  complete(messages: ChatMessage[], opts: ProviderOptions): Promise<CompletionResult>;
}

export type ProviderOptions = {
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  temperature: number;
  maxTokens: number;
};

export type AgentWorker = {
  provider: string;
  model: string;
  result: PromiseSettledResult<CompletionResult>;
};

// Rough public list prices (cents per 1K tokens) used only for budget accounting.
const PRICING: Record<string, { in: number; out: number }> = {
  default: { in: 0.03, out: 0.15 },
};

function estimateCost(tokensIn: number, tokensOut: number) {
  const p = PRICING.default;
  return (tokensIn / 1000) * p.in + (tokensOut / 1000) * p.out;
}

class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  async complete(messages: ChatMessage[], opts: ProviderOptions) {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const rest = messages.filter((m) => m.role !== "system");
    const res = await fetch(`${opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        system,
        messages: rest.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic request failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      content: { type: string; text?: string }[];
      usage?: { input_tokens: number; output_tokens: number };
    };
    const text = data.content.map((c) => c.text ?? "").join("");
    const tokensIn = data.usage?.input_tokens ?? 0;
    const tokensOut = data.usage?.output_tokens ?? 0;
    return {
      text,
      tokensIn,
      tokensOut,
      costCents: estimateCost(tokensIn, tokensOut),
      provider: this.name,
      model: opts.model,
    };
  }
}

class OpenAICompatibleProvider implements AIProvider {
  constructor(
    readonly name: string,
    private readonly defaultBase: string,
  ) {}
  async complete(messages: ChatMessage[], opts: ProviderOptions) {
    const res = await fetch(`${(opts.baseUrl ?? this.defaultBase).replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        messages,
      }),
    });
    if (!res.ok) throw new Error(`${this.name} request failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const tokensIn = data.usage?.prompt_tokens ?? 0;
    const tokensOut = data.usage?.completion_tokens ?? 0;
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      tokensIn,
      tokensOut,
      costCents: estimateCost(tokensIn, tokensOut),
      provider: this.name,
      model: opts.model,
    };
  }
}

class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  async complete(messages: ChatMessage[], opts: ProviderOptions) {
    const base = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const res = await fetch(`${base}/models/${opts.model}:generateContent?key=${opts.apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        systemInstruction: {
          parts: [{ text: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n") }],
        },
        generationConfig: { temperature: opts.temperature, maxOutputTokens: opts.maxTokens },
      }),
    });
    if (!res.ok) throw new Error(`Gemini request failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const tokensIn = data.usageMetadata?.promptTokenCount ?? 0;
    const tokensOut = data.usageMetadata?.candidatesTokenCount ?? 0;
    return {
      text,
      tokensIn,
      tokensOut,
      costCents: estimateCost(tokensIn, tokensOut),
      provider: this.name,
      model: opts.model,
    };
  }
}

class CohereProvider implements AIProvider {
  readonly name = "cohere";
  async complete(messages: ChatMessage[], opts: ProviderOptions) {
    const res = await fetch(`${opts.baseUrl ?? "https://api.cohere.com/v2"}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ model: opts.model, messages, temperature: opts.temperature, max_tokens: opts.maxTokens }),
    });
    if (!res.ok) throw new Error(`Cohere request failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      message?: { content?: { type: string; text?: string }[] };
      usage?: { tokens?: { input_tokens?: number; output_tokens?: number } };
    };
    const text = data.message?.content?.map((part) => part.text ?? "").join("") ?? "";
    const tokensIn = data.usage?.tokens?.input_tokens ?? 0;
    const tokensOut = data.usage?.tokens?.output_tokens ?? 0;
    return { text, tokensIn, tokensOut, costCents: estimateCost(tokensIn, tokensOut), provider: this.name, model: opts.model };
  }
}

export function providerFor(name: string): AIProvider {
  switch (name) {
    case "anthropic": return new AnthropicProvider();
    case "gemini": return new GeminiProvider();
    case "cohere": return new CohereProvider();
    case "openai": return new OpenAICompatibleProvider("openai", "https://api.openai.com/v1");
    case "nvidia": return new OpenAICompatibleProvider("nvidia", "https://integrate.api.nvidia.com/v1");
    case "openrouter": return new OpenAICompatibleProvider("openrouter", "https://openrouter.ai/api/v1");
    case "mistral": return new OpenAICompatibleProvider("mistral", "https://api.mistral.ai/v1");
    case "cerebras": return new OpenAICompatibleProvider("cerebras", "https://api.cerebras.ai/v1");
    case "groq": return new OpenAICompatibleProvider("groq", "https://api.groq.com/openai/v1");
    case "kilo": return new OpenAICompatibleProvider("kilo", "https://api.kilo.ai/api/gateway");
    default: return new OpenAICompatibleProvider(name, "https://api.openai.com/v1");
  }
}

export type ResolvedAIConfig = ProviderOptions & { provider: string; dailyBudgetCents: number };

export async function resolveAIConfig(orgId: string): Promise<ResolvedAIConfig | null> {
  const [config] = await db.select().from(aiConfigs).where(eq(aiConfigs.orgId, orgId)).limit(1);
  if (config) {
    let apiKey: string | null = null;
    if (config.apiKeyCipher) {
      try { apiKey = decryptSecret(config.apiKeyCipher); } catch { apiKey = null; }
    }
    apiKey = apiKey ?? envKeyFor(config.provider);
    if (!apiKey) return null;
    return {
      provider: config.provider,
      model: config.model,
      apiKey,
      baseUrl: config.baseUrl,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      dailyBudgetCents: config.dailyBudgetCents,
    };
  }
  const provider = process.env.AI_PROVIDER ?? "anthropic";
  const apiKey = envKeyFor(provider);
  if (!apiKey) return null;
  return {
    provider,
    model: process.env.AI_MODEL ?? defaultModel(provider),
    apiKey,
    baseUrl: process.env.AI_BASE_URL ?? null,
    temperature: 0.1,
    maxTokens: 4096,
    dailyBudgetCents: 500,
  };
}

function envKeyFor(provider: string) {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY ?? null;
  if (provider === "openai") return process.env.OPENAI_API_KEY ?? null;
  if (provider === "gemini") return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? null;
  return process.env.AI_API_KEY ?? null;
}

function defaultModel(provider: string) {
  if (provider === "anthropic") return "claude-sonnet-4-5";
  if (provider === "openai") return "gpt-4o-mini";
  if (provider === "gemini") return "gemini-2.0-flash";
  return "gpt-4o-mini";
}

export async function spentTodayCents(orgId: string): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    select coalesce(sum(m.cost_cents), 0) as total
    from ${aiMessages} m
    join ai_conversations c on c.id = m.conversation_id
    join projects p on p.id = c.project_id
    where p.org_id = ${orgId} and m.created_at > now() - interval '1 day';
  `);
  return Number(rows.rows?.[0]?.total ?? 0);
}

const COUNCIL: { provider: string; key: string; model: string }[] = [
  { provider: "nvidia", key: "NVIDIA_API_KEY", model: "deepseek-ai/deepseek-v4-flash-0731" },
  { provider: "openrouter", key: "OPENROUTER_API_KEY", model: "openrouter/free" },
  { provider: "mistral", key: "MISTRAL_API_KEY", model: "mistral-small-latest" },
  { provider: "cerebras", key: "CEREBRAS_API_KEY", model: "gpt-oss-120b" },
  { provider: "groq", key: "GROQ_API_KEY", model: "openai/gpt-oss-120b" },
  { provider: "kilo", key: "KILO_API_KEY", model: "kilo-auto/free" },
  { provider: "cohere", key: "COHERE_API_KEY", model: "command-a" },
];

async function configuredCouncil() {
  const ready = [] as { provider: string; model: string; apiKey: string }[];
  await Promise.all(COUNCIL.map(async (candidate) => {
    const apiKey = await getPlatformSecret(candidate.key);
    if (apiKey) ready.push({ provider: candidate.provider, model: candidate.model, apiKey });
  }));
  return ready;
}

export async function multiAgentComplete(messages: ChatMessage[], opts?: { maxWorkers?: number; timeoutMs?: number }) {
  const council = await configuredCouncil();
  if (!council.length) throw new Error("No Garvex provider keys are configured. Add provider API keys in Platform Settings.");
  const timeoutMs = opts?.timeoutMs ?? 18_000;
  const workers = council.slice(0, opts?.maxWorkers ?? council.length);
  const settled = await Promise.allSettled(workers.map(async (worker) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const originalFetch = globalThis.fetch;
      const provider = providerFor(worker.provider);
      // Provider implementations use the global fetch; temporarily enforce a hard timeout.
      const wrapped = async (...args: Parameters<typeof fetch>) => originalFetch(...args, { signal: controller.signal });
      globalThis.fetch = wrapped as typeof fetch;
      try {
        return await provider.complete(messages, { model: worker.model, apiKey: worker.apiKey, temperature: 0.1, maxTokens: 4096 });
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      clearTimeout(timeout);
    }
  }));
  const successful = settled.filter((item): item is PromiseFulfilledResult<CompletionResult> => item.status === "fulfilled" && Boolean(item.value.text?.trim())).map((item) => item.value);
  if (!successful.length) throw new Error("All configured Garvex providers failed or timed out.");

  const evidence = successful.map((result, index) => `===== AGENT ${index + 1} | ${result.provider} | ${result.model} =====\n${result.text.slice(0, 18_000)}`).join("\n\n");
  const judge = council.find((item) => item.provider === "nvidia") ?? council.find((item) => item.provider === "cerebras") ?? council[0];
  const judgePrompt: ChatMessage[] = [
    {
      role: "system",
      content: "You are Garvex's synthesis judge. Multiple independent agents answered the same request. Reconcile them instead of blindly majority-voting. Prefer statements supported by multiple agents, flag uncertainty, preserve useful implementation details, and never invent facts. For code tasks, produce a concrete, technically coherent answer. Return only the final answer to the user.",
    },
    ...messages.filter((m) => m.role !== "assistant"),
    { role: "user", content: `Independent agent outputs:\n${evidence}\n\nSynthesize the strongest correct result.` },
  ];
  const final = await providerFor(judge.provider).complete(judgePrompt, { model: judge.model, apiKey: judge.apiKey, temperature: 0.05, maxTokens: 8192 });
  return { ...final, workers: successful.map((item) => ({ provider: item.provider, model: item.model, tokensIn: item.tokensIn, tokensOut: item.tokensOut })), failedWorkers: settled.length - successful.length };
}
