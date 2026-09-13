import { assertCsrf, requirePlatformAdmin } from "@/lib/auth";
import { getPlatformSecretValues } from "@/lib/platform-secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MODEL = "cohere/north-mini-code:free";
const event = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;

export async function POST(request: Request) {
  try {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    const body = (await request.json()) as { prompt?: string; history?: { role: "user" | "assistant"; content: string }[] };
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) return Response.json({ error: "Prompt is required" }, { status: 400 });
    const entries = await getPlatformSecretValues("OPENROUTER_API_KEY");
    const apiKey = entries[0]?.value ?? process.env.OPENROUTER_API_KEY ?? null;
    if (!apiKey) return Response.json({ error: "OpenRouter API key is not configured." }, { status: 503 });

    const messages = [
      { role: "system", content: "You are Garvex, a fast, natural multilingual AI voice assistant inside VO. Answer directly and conversationally. Never reveal hidden chain-of-thought or private reasoning." },
      ...(body.history ?? []).slice(-8).filter((m) => m.content?.trim()).map((m) => ({ role: m.role, content: m.content.slice(0, 10000) })),
      { role: "user", content: prompt },
    ];
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: ["Bearer", apiKey].join(" "), "http-referer": "https://vo-lilac.vercel.app", "x-title": "VO Garvex Live" },
      body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: 0.25, max_tokens: 2048, reasoning: { effort: "medium", exclude: true } }),
    });
    if (!upstream.ok || !upstream.body) return Response.json({ error: `OpenRouter live request failed (${upstream.status}).` }, { status: upstream.status || 502 });

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    let buffer = "";
    const output = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(event({ type: "stage", stage: "Generating" })));
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
                if (text) controller.enqueue(encoder.encode(event({ type: "delta", text })));
              } catch {}
            }
          }
          controller.enqueue(encoder.encode(event({ type: "done", model: MODEL })));
          controller.close();
        } catch (error) {
          controller.enqueue(encoder.encode(event({ type: "error", error: error instanceof Error ? error.message : String(error) })));
          controller.close();
        }
      },
      cancel() { void reader.cancel(); },
    });
    return new Response(output, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
