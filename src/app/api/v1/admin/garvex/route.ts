import { handle, ok, readJson, requireFields } from "@/lib/api";
import { assertCsrf, requirePlatformAdmin } from "@/lib/auth";
import { getGarvexProviderStatus, multiAgentComplete } from "@/lib/ai/provider";
import type { ChatMessage } from "@/lib/ai/provider";

export const dynamic = "force-dynamic";
type Body = { mode?: "chat" | "architect" | "research"; prompt?: string; context?: string; history?: { role: "user" | "assistant"; content: string }[]; complex?: boolean };
export async function GET() { return handle(async () => ok({ providers: await getGarvexProviderStatus() })); }
export async function POST(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin(); await assertCsrf(user); const body = await readJson<Body>(request); requireFields(body, ["prompt"]);
    const prompt = String(body.prompt).trim(); if (!prompt) throw new Error("Prompt is required"); const mode = body.mode ?? "chat";
    const system = mode === "architect" ? "You are Garvex, the in-site autonomous engineering architect. Understand the task, reason carefully, propose a concrete executable plan, identify files/tools, and never claim a tool ran unless it actually did. Mutate nothing in architect/chat/research mode." : mode === "research" ? "You are Garvex in research mode. Separate known facts from uncertainty and flag claims that need verification. This mode is strictly read-only." : "You are Garvex, a powerful multilingual AI control center inside VO. Be concise and technically precise. Never claim an action completed until the system actually completes it. Chat is strictly read-only: do not mutate files, repositories, deployments, settings, or data.";
    const history: ChatMessage[] = (body.history ?? []).slice(-10).filter((item) => item.content?.trim()).map((item) => ({ role: item.role, content: item.content.slice(0, 12000) }));
    const messages: ChatMessage[] = [{ role: "system", content: system }, ...history, { role: "user", content: `${prompt}${body.context ? `\n\nSelected project context (read-only):\n${body.context.slice(0, 30000)}` : ""}` }];
    const strategy = body.complex === false ? "single" : "complex";
    const result = await multiAgentComplete(messages, strategy === "complex" ? { timeoutMs: 4500, maxWorkers: 12, quorum: 3, strategy } : { timeoutMs: 4500, strategy });
    return ok({ answer: result.text, provider: result.provider, model: result.model, workers: result.workers, failedWorkers: result.failedWorkers, strategy: result.strategy, steps: [{ id: "dispatch", label: strategy === "complex" ? "Dispatch multiple agents" : "Dispatch one agent", status: "complete", detail: `${result.workers.length} agent(s) responded` }, ...(strategy === "complex" ? [{ id: "reconcile", label: "Reconcile evidence", status: "complete", detail: "Independent outputs compared" }] : []), { id: "synthesize", label: strategy === "complex" ? "Synthesize answer" : "Return response", status: "complete", detail: result.strategy === "complex" && result.workers.length > 1 ? "Multi-agent result" : `${result.provider} · ${result.model}` }] });
  });
}
