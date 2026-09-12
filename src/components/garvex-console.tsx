"use client";

import Link from "next/link";
import { FormEvent, useMemo, useRef, useState } from "react";

type Provider = { provider: string; model: string; configured: boolean };
type Worker = { provider: string; model: string; tokensIn: number; tokensOut: number };

type Message = { role: "user" | "assistant"; content: string };

const labels: Record<string, string> = {
  nvidia: "NVIDIA",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  cerebras: "Cerebras",
  groq: "Groq",
  kilo: "Kilo",
  cohere: "Cohere",
};

export function GarvexConsole({ csrf, providers, isPlatformAdmin }: { csrf: string; providers: Provider[]; isPlatformAdmin: boolean }) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"chat" | "architect" | "research">("chat");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [failed, setFailed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState("Ready");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const configuredCount = useMemo(() => providers.filter((provider) => provider.configured).length, [providers]);

  const run = async (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || busy || !isPlatformAdmin) return;
    setMessages((current) => [...current, { role: "user", content: trimmed }]);
    setPrompt("");
    setBusy(true);
    setError(null);
    setWorkers([]);
    setFailed(0);
    setPhase("Dispatching agents in parallel…");
    try {
      const res = await fetch("/api/v1/admin/garvex", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ prompt: trimmed, mode }),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
      setWorkers(data.data?.workers ?? []);
      setFailed(data.data?.failedWorkers ?? 0);
      setMessages((current) => [...current, { role: "assistant", content: data.data?.answer ?? "" }]);
      setPhase("Council synthesized the result");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("Stopped with an error");
    } finally {
      setBusy(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  return (
    <div className="garvex-shell">
      <div className="garvex-chat">
        <header className="garvex-topbar">
          <div className="flex min-w-0 items-center gap-3">
            <div className={busy ? "garvex-orb garvex-orb-live" : "garvex-orb"} aria-hidden="true"><span /></div>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold">Garvex</div>
              <div className="text-[10.5px]" style={{ color: "var(--color-fg-muted)" }}>AI control center · {configuredCount}/{providers.length} engines connected</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden rounded-full border px-2.5 py-1 text-[10px] sm:inline-flex">{busy ? phase : "Online"}</span>
            <Link href="/admin/settings" className="btn">Settings</Link>
          </div>
        </header>

        <main className="garvex-messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="garvex-welcome">
              <div className={busy ? "garvex-orb garvex-orb-xl garvex-orb-live" : "garvex-orb garvex-orb-xl"} aria-hidden="true"><span /></div>
              <h1>What can I help you build?</h1>
              <p>Ask Garvex to reason, research, design, debug, or work with your projects.</p>
              <div className="garvex-suggestions">
                <button onClick={() => setPrompt("Inspect my current project architecture and tell me what should be improved without changing existing behavior.")}>Inspect my project</button>
                <button onClick={() => setPrompt("Research this topic using reliable sources and separate verified facts from uncertainty.")}>Deep research</button>
                <button onClick={() => setPrompt("Design the best production architecture for this project and explain the implementation steps.")}>Design architecture</button>
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
              {messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className={message.role === "user" ? "mb-8 flex justify-end" : "mb-10 flex items-start gap-3"}>
                  {message.role === "assistant" ? <div className={busy && index === messages.length - 1 ? "garvex-orb garvex-orb-sm garvex-orb-live mt-1 shrink-0" : "garvex-orb garvex-orb-sm mt-1 shrink-0"} aria-hidden="true"><span /></div> : null}
                  <div className={message.role === "user" ? "garvex-user-message" : "garvex-assistant-message"}>
                    <div className="whitespace-pre-wrap leading-7 text-[13px] sm:text-[13.5px]">{message.content}</div>
                  </div>
                </div>
              ))}
              {busy ? (
                <div className="mb-10 flex items-start gap-3">
                  <div className="garvex-orb garvex-orb-sm garvex-orb-live mt-1 shrink-0" aria-hidden="true"><span /></div>
                  <div className="garvex-typing"><span /><span /><span /></div>
                </div>
              ) : null}
              {error ? <div className="mb-8 rounded-xl border px-4 py-3 text-[12px]" style={{ borderColor: "rgba(248,81,73,.3)", color: "#ff9b95", background: "rgba(248,81,73,.05)" }}>{error}</div> : null}
            </div>
          )}
        </main>

        <footer className="garvex-composer-wrap">
          <div className="mx-auto w-full max-w-3xl px-4 pb-2 sm:px-6">
            <form onSubmit={run} className="garvex-composer">
              <div className="flex items-center gap-1.5 px-3 pt-2">
                {(["chat", "architect", "research"] as const).map((item) => (
                  <button key={item} type="button" className={mode === item ? "garvex-mode active" : "garvex-mode"} onClick={() => setMode(item)}>
                    {item === "chat" ? "Chat" : item === "architect" ? "Build" : "Research"}
                  </button>
                ))}
              </div>
              <div className="flex items-end gap-2 p-2.5">
                <button type="button" className="garvex-icon-button" aria-label="Attach file" title="Attachments are coming to the unified composer">＋</button>
                <textarea
                  ref={textareaRef}
                  className="garvex-textarea"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void run();
                    }
                  }}
                  placeholder="Message Garvex…"
                  rows={1}
                  disabled={!isPlatformAdmin || busy}
                />
                <button type="submit" className="garvex-send" disabled={!prompt.trim() || busy || !isPlatformAdmin} aria-label="Send">
                  ↑
                </button>
              </div>
            </form>
            <div className="garvex-footer-hint">Garvex can coordinate multiple AI engines. Responses are synthesized; live execution shows operational status, not private chain-of-thought.</div>
          </div>
        </footer>
      </div>

      <aside className="garvex-live-panel">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[12px] font-semibold">Live workspace</div>
            <div className="hint mt-0.5">See what Garvex is using right now</div>
          </div>
          <span className="garvex-live-dot" />
        </div>
        <div className="mt-4 space-y-2">
          {providers.map((provider) => {
            const worker = workers.find((item) => item.provider === provider.provider);
            return (
              <div key={provider.provider} className="garvex-agent-row">
                <span className={worker ? "garvex-agent-dot ready" : provider.configured ? "garvex-agent-dot" : "garvex-agent-dot idle"} />
                <div className="min-w-0 flex-1">
                  <div className="text-[11.5px] font-medium">{labels[provider.provider] ?? provider.provider}</div>
                  <div className="mono truncate text-[9px]" style={{ color: "var(--color-fg-muted)" }}>{worker?.model ?? provider.model}</div>
                </div>
                <span className="text-[9.5px]" style={{ color: "var(--color-fg-muted)" }}>{worker ? "done" : provider.configured ? "ready" : "off"}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="garvex-stat"><span>{workers.length}</span><small>agents</small></div>
          <div className="garvex-stat"><span>{failed}</span><small>timeouts</small></div>
          <div className="garvex-stat"><span>{workers.length ? "✓" : "—"}</span><small>judge</small></div>
        </div>
        <div className="garvex-execution-note mt-4"><strong>Execution</strong><br />Parallel agents → evidence reconciliation → final synthesis.</div>
      </aside>
    </div>
  );
}
