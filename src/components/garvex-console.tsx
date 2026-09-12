"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type Provider = { provider: string; model: string; configured: boolean };
type Worker = { provider: string; model: string; tokensIn: number; tokensOut: number };

const labels: Record<string, string> = { nvidia: "NVIDIA", openrouter: "OpenRouter", mistral: "Mistral", cerebras: "Cerebras", groq: "Groq", kilo: "Kilo", cohere: "Cohere" };

export function GarvexConsole({ csrf, providers, isPlatformAdmin }: { csrf: string; providers: Provider[]; isPlatformAdmin: boolean }) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"chat" | "architect" | "research">("chat");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [failed, setFailed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState("Ready");

  const configuredCount = useMemo(() => providers.filter((provider) => provider.configured).length, [providers]);

  const run = async () => {
    if (!prompt.trim() || !isPlatformAdmin) return;
    setBusy(true); setError(null); setAnswer(null); setWorkers([]); setFailed(0);
    setPhase("Dispatching parallel agents…");
    try {
      const res = await fetch("/api/v1/admin/garvex", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ prompt: prompt.trim(), mode }) });
      setPhase("Collecting independent answers…");
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
      setWorkers(data.data?.workers ?? []); setFailed(data.data?.failedWorkers ?? 0); setAnswer(data.data?.answer ?? ""); setPhase("Judge synthesized the result");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setPhase("Stopped with an error"); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className="overflow-hidden rounded-xl border" style={{ background: "var(--color-bg-subtle)" }}>
        <div className="border-b px-4 py-4">
          <div className="flex items-center gap-3">
            <div className={busy ? "garvex-orb garvex-orb-live" : "garvex-orb"}><span /></div>
            <div><h1 className="text-[17px] font-semibold">Garvex</h1><p className="hint">Multi-agent intelligence and engineering control center</p></div>
            <div className="ml-auto rounded-full border px-2 py-1 text-[10px]">{configuredCount}/{providers.length} providers ready</div>
          </div>
        </div>
        <div className="min-h-[420px] p-4">
          {answer ? <div className="max-w-3xl whitespace-pre-wrap text-[12.5px] leading-6">{answer}</div> : <div className="flex h-[360px] items-center justify-center"><div className="max-w-md text-center"><div className="text-[14px] font-medium">Tell Garvex what you need.</div><div className="hint mt-2">Ask a question, architect a system, investigate a problem, or use the project AI Editor for repository modifications.</div></div></div>}
          {error ? <div className="mt-4 rounded-md border p-3 text-[11.5px]" style={{ color: "var(--color-danger)" }}>{error}</div> : null}
        </div>
        <div className="border-t p-3">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {(["chat", "architect", "research"] as const).map((item) => <button key={item} className={mode === item ? "btn btn-primary" : "btn"} onClick={() => setMode(item)}>{item === "chat" ? "Chat" : item === "architect" ? "Architect" : "Research"}</button>)}
            <Link href="/admin/settings" className="btn ml-auto">Provider settings</Link>
          </div>
          <textarea className="input min-h-28 resize-y" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Example: Analyze my deployment architecture and propose a safer way to run build workers without changing existing behavior." />
          <div className="mt-2 flex items-center gap-2"><button className="btn btn-primary" onClick={() => void run()} disabled={busy || !prompt.trim() || !isPlatformAdmin}>{busy ? "Garvex is working…" : "Ask Garvex"}</button>{phase ? <span className="hint">{phase}</span> : null}</div>
        </div>
      </section>

      <aside className="rounded-xl border p-4" style={{ background: "var(--color-bg-subtle)" }}>
        <div className="text-[12px] font-semibold">Live execution</div>
        <div className="hint mt-1">Operational telemetry only — not hidden chain-of-thought.</div>
        <div className="mt-4 space-y-2">
          {providers.map((provider) => {
            const worker = workers.find((item) => item.provider === provider.provider);
            return <div key={provider.provider} className="rounded-lg border px-3 py-2"><div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: worker ? "var(--color-success)" : provider.configured ? "#c9a227" : "var(--color-border)" }} /><span className="text-[11.5px] font-medium">{labels[provider.provider] ?? provider.provider}</span><span className="ml-auto text-[9.5px]" style={{ color: "var(--color-fg-muted)" }}>{worker ? "answered" : provider.configured ? "ready" : "no key"}</span></div><div className="mono mt-1 text-[9.5px]" style={{ color: "var(--color-fg-muted)" }}>{worker?.model ?? provider.model}</div></div>;
          })}
        </div>
        <div className="mt-4 border-t pt-3"><div className="flex justify-between text-[11px]"><span>Successful agents</span><span>{workers.length}</span></div><div className="mt-1 flex justify-between text-[11px]"><span>Failed / timed out</span><span>{failed}</span></div><div className="mt-1 flex justify-between text-[11px]"><span>Final judge</span><span>{workers.length ? "selected" : "idle"}</span></div></div>
        <div className="mt-4 rounded-lg border p-3 text-[10.5px] leading-5" style={{ color: "var(--color-fg-muted)" }}>Garvex uses independent answers in parallel, then a dedicated synthesis pass. For repository changes, use the project AI Editor: it creates an isolated branch and PR instead of silently writing production code.</div>
      </aside>
    </div>
  );
}
