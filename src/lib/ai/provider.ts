import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiConfigs, aiMessages } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { sql } from "drizzle-orm";

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

// Rough public list prices (cents per 1K tokens) used for budget accounting only.
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
    const res = await fetch(`${opts.baseUrl ?? this.defaultBase}/chat/completions`, {
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
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const tokensIn = data.usage?.prompt_tokens ?? 0;
    const tokensOut = data.usage?.completion_tokens ?? 0;
    return {
      text: data.choices[0]?.message?.content ?? "",
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

export function providerFor(name: string): AIProvider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAICompatibleProvider("openai", "https://api.openai.com/v1");
    case "gemini":
      return new GeminiProvider();
    default:
      return new OpenAICompatibleProvider(name, "https://api.openai.com/v1");
  }
}

export type ResolvedAIConfig = ProviderOptions & { provider: string; dailyBudgetCents: number };

/** BYOK resolution: org configuration first, platform env fallback. */
export async function resolveAIConfig(orgId: string): Promise<ResolvedAIConfig | null> {
  const [config] = await db.select().from(aiConfigs).where(eq(aiConfigs.orgId, orgId)).limit(1);
  if (config) {
    let apiKey: string | null = null;
    if (config.apiKeyCipher) {
      try {
        apiKey = decryptSecret(config.apiKeyCipher);
      } catch {
        apiKey = null;
      }
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
