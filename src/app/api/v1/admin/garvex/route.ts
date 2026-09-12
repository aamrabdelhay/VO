import { handle, ok, readJson, requireFields } from "@/lib/api";
import { assertCsrf, requirePlatformAdmin } from "@/lib/auth";
import { getGarvexProviderStatus, multiAgentComplete } from "@/lib/ai/provider";
import type { ChatMessage } from "@/lib/ai/provider";

export const dynamic = "force-dynamic";

type Body = {
  mode?: "chat" | "architect" | "research";
  prompt?: string;
  context?: string;
  history?: { role: "user" | "assistant"; content: string }[];
};

export async function GET() {
  return handle(async () => ok({ providers: await getGarvexProviderStatus() }));
}

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    const body = await readJson<Body>(request);
    requireFields(body, ["prompt"]);
    const prompt = String(body.prompt).trim();
    if (!prompt) throw new Error("Prompt is required");
    const mode = body.mode ?? "chat";
    const system = mode === "architect"
      ? "You are Garvex, the in-site autonomous engineering architect. Understand the task, reason carefully, propose an executable plan, identify concrete files/tools, and never claim a tool ran unless it actually did. When the user asks to edit the connected project, the UI may hand the request to the coding agent for real repository changes."
      : mode === "research"
        ? "You are Garvex in research mode. Separate known facts from uncertainty. Prefer claims that can be independently verified, and explicitly flag anything that needs a real web/source lookup before being treated as fact."
        : "You are Garvex, a powerful multilingual AI control center inside VO. Be concise but technically precise. When the user asks for an action on VO, explain the concrete action and never claim completion until the system actually completes it.";
    const history: ChatMessage[] = (body.history ?? []).slice(-10).filter((item) => item.content?.trim()).map((item) => ({ role: item.role, content: item.content.slice(0, 12000) }));
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: `${prompt}${body.context ? `\n\nContext:\n${body.context.slice(0, 30000)}` : ""}` },
    ];
    const result = await multiAgentComplete(messages, { timeoutMs: 4500, maxWorkers: 7, quorum: 3 });
    return ok({
      answer: result.text,
      provider: result.provider,
      model: result.model,
      workers: result.workers,
      failedWorkers: result.failedWorkers,
      steps: [
        { id: "dispatch", label: "Dispatch agents", status: "complete", detail: `${result.workers.length} agent(s) responded` },
        { id: "reconcile", label: "Reconcile evidence", status: "complete", detail: "Independent outputs compared" },
        { id: "synthesize", label: "Synthesize answer", status: "complete", detail: `${result.provider} judge` },
      ],
    });
  });
}
