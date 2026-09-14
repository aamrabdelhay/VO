import { assertCsrf, requirePlatformAdmin } from "@/lib/auth";
import { getPlatformSecretValues } from "@/lib/platform-secrets";
import { multiAgentComplete, type ChatMessage } from "@/lib/ai/provider";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MODEL = "cohere/north-mini-code:free";
const NVIDIA_TTS_URL = "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize";
const event = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" };

function messagesFor(prompt: string, history: { role: "user" | "assistant"; content: string }[] = []): ChatMessage[] {
  return [
    { role: "system", content: "You are Garvex, a fast, natural multilingual AI assistant inside VO. Answer directly, conversationally, and concisely. Preserve the user's language. Never reveal hidden chain-of-thought or private reasoning." },
    ...history.slice(-8).filter((m) => m.content?.trim()).map((m) => ({ role: m.role, content: m.content.slice(0, 10000) }) as ChatMessage),
    { role: "user", content: prompt },
  ];
}

async function nvidiaTts(text: string, key: string) {
  const arabic = /[\u0600-\u06FF]/.test(text);
  const form = new FormData();
  form.append("text", text.slice(0, 600));
  form.append("language", arabic ? "ar-XA" : "en-US");
  form.append("voice", arabic ? "Magpie-Multilingual.AR-XA.Sofia" : "Magpie-Multilingual.EN-US.Aria");
  form.append("encoding", "LINEAR_PCM");
  form.append("sample_rate_hz", "24000");
  const response = await fetch(NVIDIA_TTS_URL, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, cache: "no-store" });
  if (!response.ok) throw new Error(`NVIDIA TTS failed (${response.status})`);
  return `data:audio/wav;base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
}

function fallbackResponse(encoder: TextEncoder, fallback: { text: string; provider: string; model: string }, reason?: string) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(event({ type: "stage", stage: "Fallback", provider: fallback.provider, model: fallback.model, ...(reason ? { reason } : {}) })));
      controller.enqueue(encoder.encode(event({ type: "delta", text: fallback.text })));
      controller.enqueue(encoder.encode(event({ type: "done", model: fallback.model, provider: fallback.provider, fallback: true })));
      controller.close();
    },
  }), { headers });
}

export async function POST(request: Request) {
  try {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    const body = (await request.json()) as { prompt?: string; history?: { role: "user" | "assistant"; content: string }[] };
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) return Response.json({ error: "Prompt is required" }, { status: 400 });

    const messages = messagesFor(prompt, body.history ?? []);
    const entries = await getPlatformSecretValues("OPENROUTER_API_KEY");
    const apiKey = entries[0]?.value ?? process.env.OPENROUTER_API_KEY ?? null;
    const nvidiaEntries = await getPlatformSecretValues("NVIDIA_API_KEY");
    const nvidiaKey = nvidiaEntries[0]?.value ?? process.env.NVIDIA_API_KEY ?? null;
    const encoder = new TextEncoder();
    const getFallback = () => multiAgentComplete(messages, { strategy: "single", timeoutMs: 6000 }).catch(() => null);

    if (!apiKey) {
      const fallback = await getFallback();
      if (!fallback?.text) return Response.json({ error: "No working Garvex AI provider is available." }, { status: 503 });
      return fallbackResponse(encoder, fallback, "OpenRouter key unavailable");
    }

    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: ["Bearer", apiKey].join(" "), "http-referer": "https://vo-lilac.vercel.app", "x-title": "VO Garvex Live" },
      body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: 0.25, max_tokens: 1536, reasoning: { effort: "medium", exclude: true } }),
    });

    if (!upstream.ok || !upstream.body) {
      const fallback = await getFallback();
      if (!fallback?.text) return Response.json({ error: `OpenRouter failed (${upstream.status}) and no fallback provider is available.` }, { status: 502 });
      return fallbackResponse(encoder, fallback, `OpenRouter ${upstream.status}`);
    }

    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    let buffer = "";
    let sentenceBuffer = "";
    let audioSequence = 0;
    const audioPromises: Promise<void>[] = [];
    const queueAudio = (controller: ReadableStreamDefaultController<Uint8Array>, text: string, sequence: number) => {
      if (!nvidiaKey) return;
      const clean = text.trim();
      if (!clean) return;
      const job = nvidiaTts(clean, nvidiaKey).then((audio) => {
        controller.enqueue(encoder.encode(event({ type: "audio", audio, sequence })));
      }).catch(() => undefined);
      audioPromises.push(job);
    };

    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          controller.enqueue(encoder.encode(event({ type: "stage", stage: "Generating", provider: "OpenRouter", model: MODEL })));
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
                  const json = JSON.parse(raw) as { choices?: { delta?: { content?: string | null } }[] };
                  const text = json.choices?.[0]?.delta?.content;
                  if (!text) continue;
                  controller.enqueue(encoder.encode(event({ type: "delta", text })));
                  sentenceBuffer += text;
                  let match = sentenceBuffer.match(/^([\s\S]{1,600}?[.!?。！？\n])\s*/);
                  while (match) {
                    const sentence = match[1].trim();
                    sentenceBuffer = sentenceBuffer.slice(match[0].length);
                    queueAudio(controller, sentence, audioSequence++);
                    match = sentenceBuffer.match(/^([\s\S]{1,600}?[.!?。！？\n])\s*/);
                  }
                } catch {}
              }
            }
            if (sentenceBuffer.trim()) queueAudio(controller, sentenceBuffer.trim(), audioSequence++);
            await Promise.all(audioPromises);
            controller.enqueue(encoder.encode(event({ type: "done", model: MODEL, provider: "OpenRouter", tts: Boolean(nvidiaKey) })));
            controller.close();
          } catch (error) {
            const fallback = await getFallback();
            if (fallback?.text) {
              controller.enqueue(encoder.encode(event({ type: "stage", stage: "Fallback", provider: fallback.provider, model: fallback.model })));
              controller.enqueue(encoder.encode(event({ type: "delta", text: fallback.text })));
              controller.enqueue(encoder.encode(event({ type: "done", model: fallback.model, provider: fallback.provider, fallback: true })));
            } else {
              controller.enqueue(encoder.encode(event({ type: "error", error: error instanceof Error ? error.message : String(error) })));
            }
            controller.close();
          }
        })();
      },
      cancel() { void reader.cancel(); },
    });
    return new Response(output, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
