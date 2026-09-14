import { assertCsrf, requirePlatformAdmin } from "@/lib/auth";
import { getPlatformSecretValues } from "@/lib/platform-secrets";
import { multiAgentComplete, type ChatMessage } from "@/lib/ai/provider";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MODEL = "cohere/north-mini-code:free";
const NVIDIA_TTS_URL = "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize";
const event = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" };
type Source = { title?: string; url: string };

function messagesFor(prompt: string, history: { role: "user" | "assistant"; content: string }[] = [], voice = false): ChatMessage[] {
  return [
    { role: "system", content: `You are Garvex, a fast, natural multilingual AI assistant inside VO. Answer directly, smoothly and accurately. Preserve the user's language. Never wrap the entire answer in quotation marks. Do not emit raw Markdown heading syntax as decorative text; the interface renders Markdown. For factual or current claims, use the web evidence supplied by the tool and include concise source links when available. Never invent citations. Never reveal hidden chain-of-thought or private reasoning. ${voice ? "This is a real-time voice conversation: keep replies concise, conversational, and optimized for low latency." : ""}` },
    ...history.slice(-8).filter((m) => m.content?.trim()).map((m) => ({ role: m.role, content: m.content.slice(0, 10000) }) as ChatMessage),
    { role: "user", content: prompt },
  ];
}

function shouldUseWeb(prompt: string) {
  return /(latest|today|yesterday|current|news|price|weather|who is|what is|when is|how much|official|source|sources|cite|citation|verify|verification|fact|facts|research|law|legal|regulation|rule|president|government|company|stock|court|case|حديث|اليوم|أمس|حالي|حاليا|آخر|أخبار|سعر|طقس|من هو|ما هو|متى|كم سعر|مصدر|مصادر|تحقق|حقيقة|بحث|قانون|لائحة|قاعدة|حكم|محكمة|قضية)/i.test(prompt);
}

function cleanForSpeech(text: string) {
  return text.replace(/```[\s\S]*?```/g, "").replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/^#{1,6}\s+/gm, "").replace(/[*_>`]/g, "").replace(/\s+/g, " ").trim().slice(0, 600);
}

async function nvidiaTts(text: string, key: string) {
  const clean = cleanForSpeech(text);
  if (!clean) return null;
  const arabic = /[\u0600-\u06FF]/.test(clean);
  const form = new FormData();
  form.append("text", clean);
  form.append("language", arabic ? "ar-XA" : "en-US");
  form.append("voice", arabic ? "Magpie-Multilingual.AR-XA.Sofia" : "Magpie-Multilingual.EN-US.Aria");
  form.append("encoding", "LINEAR_PCM");
  form.append("sample_rate_hz", "24000");
  const response = await fetch(NVIDIA_TTS_URL, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, cache: "no-store" });
  if (!response.ok) throw new Error(`NVIDIA TTS failed (${response.status})`);
  return `data:audio/wav;base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
}

async function fallbackResponse(encoder: TextEncoder, fallback: { text: string; provider: string; model: string }, voice: boolean, nvidiaKey: string | null, reason?: string) {
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(event({ type: "stage", stage: "Fallback", provider: fallback.provider, model: fallback.model, ...(reason ? { reason } : {}) })));
      controller.enqueue(encoder.encode(event({ type: "delta", text: fallback.text })));
      if (voice && nvidiaKey) {
        try {
          const audio = await nvidiaTts(fallback.text, nvidiaKey);
          if (audio) controller.enqueue(encoder.encode(event({ type: "audio", audio, sequence: 0, text: cleanForSpeech(fallback.text) })));
        } catch {}
      }
      controller.enqueue(encoder.encode(event({ type: "done", model: fallback.model, provider: fallback.provider, fallback: true })));
      controller.close();
    },
  }), { headers });
}

export async function POST(request: Request) {
  try {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    const body = (await request.json()) as { prompt?: string; history?: { role: "user" | "assistant"; content: string }[]; voice?: boolean };
    const prompt = String(body.prompt ?? "").trim();
    const voice = body.voice === true;
    if (!prompt) return Response.json({ error: "Prompt is required" }, { status: 400 });

    const messages = messagesFor(prompt, body.history ?? [], voice);
    const openRouterEntries = await getPlatformSecretValues("OPENROUTER_API_KEY");
    const nvidiaEntries = await getPlatformSecretValues("NVIDIA_API_KEY");
    const apiKey = openRouterEntries[0]?.value ?? process.env.OPENROUTER_API_KEY ?? null;
    const nvidiaKey = nvidiaEntries[0]?.value ?? process.env.NVIDIA_API_KEY ?? null;
    const useWeb = shouldUseWeb(prompt);
    const encoder = new TextEncoder();
    const getFallback = () => multiAgentComplete(messages, { strategy: "single", timeoutMs: voice ? 4500 : 6000 }).catch(() => null);

    if (!apiKey) {
      const fallback = await getFallback();
      if (!fallback?.text) return Response.json({ error: "No working Garvex AI provider is available." }, { status: 503 });
      return fallbackResponse(encoder, fallback, voice, nvidiaKey, "OpenRouter key unavailable");
    }

    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: ["Bearer", apiKey].join(" "), "http-referer": "https://vo-lilac.vercel.app", "x-title": "VO Garvex Live" },
      body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: voice ? 0.15 : 0.25, max_tokens: voice ? 768 : 1536, reasoning: { effort: voice ? "low" : "medium", exclude: true }, ...(useWeb ? { plugins: [{ id: "web", engine: "exa", mode: "instant", max_results: 2 }] } : {}) }),
    });

    if (!upstream.ok || !upstream.body) {
      const fallback = await getFallback();
      if (!fallback?.text) return Response.json({ error: `OpenRouter failed (${upstream.status}) and no fallback provider is available.` }, { status: 502 });
      return fallbackResponse(encoder, fallback, voice, nvidiaKey, `OpenRouter ${upstream.status}`);
    }

    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    let buffer = "";
    let sentenceBuffer = "";
    let audioSequence = 0;
    let full = "";
    let closed = false;
    const audioPromises: Promise<void>[] = [];
    const sources = new Map<string, Source>();
    const safeEnqueue = (controller: ReadableStreamDefaultController<Uint8Array>, payload: Record<string, unknown>) => { if (!closed) controller.enqueue(encoder.encode(event(payload))); };
    const queueAudio = (controller: ReadableStreamDefaultController<Uint8Array>, text: string, sequence: number) => {
      if (!voice || !nvidiaKey) return;
      const clean = cleanForSpeech(text);
      if (!clean) return;
      audioPromises.push(nvidiaTts(clean, nvidiaKey).then((audio) => { if (audio) safeEnqueue(controller, { type: "audio", audio, sequence, text: clean }); }).catch(() => undefined));
    };

    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          safeEnqueue(controller, { type: "stage", stage: "Analyzing request" });
          safeEnqueue(controller, { type: "stage", stage: "Checking context" });
          if (useWeb) safeEnqueue(controller, { type: "stage", stage: "Checking sources" });
          safeEnqueue(controller, { type: "stage", stage: "Generating answer", provider: "OpenRouter", model: MODEL });
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const chunks = buffer.split("\n\n");
              buffer = chunks.pop() ?? "";
              for (const chunk of chunks) {
                const line = chunk.split("\n").find((item) => item.startsWith("data:"));
                if (!line) continue;
                const raw = line.slice(5).trim();
                if (!raw || raw === "[DONE]") continue;
                try {
                  const json = JSON.parse(raw) as { choices?: { delta?: { content?: string | null; annotations?: Array<{ url_citation?: { url?: string; title?: string } }> } }[] };
                  const delta = json.choices?.[0]?.delta;
                  for (const annotation of delta?.annotations ?? []) {
                    const url = annotation.url_citation?.url;
                    if (url && /^https?:\/\//i.test(url)) sources.set(url, { url, title: annotation.url_citation?.title });
                  }
                  const text = delta?.content;
                  if (!text) continue;
                  full += text;
                  safeEnqueue(controller, { type: "delta", text });
                  sentenceBuffer += text;
                  if (voice) {
                    let match = sentenceBuffer.match(/^([\s\S]{36,420}?[.!?。！？])\s*/);
                    while (match) {
                      const sentence = match[1].trim();
                      sentenceBuffer = sentenceBuffer.slice(match[0].length);
                      queueAudio(controller, sentence, audioSequence++);
                      match = sentenceBuffer.match(/^([\s\S]{36,420}?[.!?。！？])\s*/);
                    }
                  }
                } catch {}
              }
            }
            if (voice && sentenceBuffer.trim()) queueAudio(controller, sentenceBuffer.trim(), audioSequence++);
            await Promise.all(audioPromises);
            if (!voice && useWeb && sources.size) {
              const sourceLinks = Array.from(sources.values()).map((source) => `[${source.title || new URL(source.url).hostname}](${source.url})`).join("\n");
              if (sourceLinks && !full.includes(sourceLinks)) safeEnqueue(controller, { type: "delta", text: `\n\n### Sources\n${sourceLinks}` });
            }
            safeEnqueue(controller, { type: "stage", stage: "Finalizing" });
            safeEnqueue(controller, { type: "sources", sources: Array.from(sources.values()) });
            safeEnqueue(controller, { type: "done", model: MODEL, provider: "OpenRouter", tts: Boolean(voice && nvidiaKey), sources: Array.from(sources.values()), web: useWeb });
            closed = true;
            controller.close();
          } catch (error) {
            const fallback = await getFallback();
            if (fallback?.text) {
              safeEnqueue(controller, { type: "stage", stage: "Fallback", provider: fallback.provider, model: fallback.model });
              safeEnqueue(controller, { type: "delta", text: fallback.text });
              if (voice && nvidiaKey) {
                try {
                  const audio = await nvidiaTts(fallback.text, nvidiaKey);
                  if (audio) safeEnqueue(controller, { type: "audio", audio, sequence: 0, text: cleanForSpeech(fallback.text) });
                } catch {}
              }
              safeEnqueue(controller, { type: "done", model: fallback.model, provider: fallback.provider, fallback: true });
            } else {
              safeEnqueue(controller, { type: "error", error: error instanceof Error ? error.message : String(error) });
            }
            closed = true;
            controller.close();
          }
        })();
      },
      cancel() { closed = true; void reader.cancel(); },
    });
    return new Response(output, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
