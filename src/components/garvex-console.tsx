"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";

type Provider = { provider: string; model: string; configured: boolean };
type Worker = { provider: string; model: string; tokensIn: number; tokensOut: number };
type Project = { id: string; name: string; repoFullName: string };
type ChatMessage = { id: string; role: "user" | "assistant"; content: string; mode?: "chat" | "build" | "research" };
type Activity = { id: string; label: string; detail: string; status: "running" | "complete" | "error" };
type WorkspaceTab = "activity" | "code" | "preview" | "files" | "terminal";

const labels: Record<string, string> = { nvidia: "NVIDIA", openrouter: "OpenRouter", mistral: "Mistral", cerebras: "Cerebras", groq: "Groq", kilo: "Kilo", cohere: "Cohere" };
function isArabic(text: string) { return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text); }
function getDirection(text: string): "rtl" | "ltr" { const clean = text.replace(/[\u2000-\u206F\u2E00-\u2E7F'"“”‘’.,!?;:()\[\]{}\d\s]/g, ""); return clean ? (isArabic(clean) ? "rtl" : "ltr") : "ltr"; }
function nextId(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

export function GarvexConsole({ csrf, providers, projects, isPlatformAdmin }: { csrf: string; providers: Provider[]; projects: Project[]; isPlatformAdmin: boolean }) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"chat" | "build" | "research">("chat");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [failed, setFailed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState("Ready");
  const [activities, setActivities] = useState<Activity[]>([]);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("activity");
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id ?? "");
  const [changedFiles, setChangedFiles] = useState<{ path: string; content: string }[]>([]);
  const [lastSummary, setLastSummary] = useState<string | null>(null);
  const [lastBaseSha, setLastBaseSha] = useState<string | null>(null);
  const [lastPr, setLastPr] = useState<string | null>(null);
  const [rotation, setRotation] = useState(0);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const configuredCount = useMemo(() => providers.filter((provider) => provider.configured).length, [providers]);
  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedProjectId) ?? projects[0], [projects, selectedProjectId]);

  useEffect(() => { try { const saved = localStorage.getItem("vo-garvex-history-v2"); if (saved) setMessages(JSON.parse(saved) as ChatMessage[]); } catch {} }, []);
  useEffect(() => { try { localStorage.setItem("vo-garvex-history-v2", JSON.stringify(messages.slice(-80))); } catch {} }, [messages]);
  useEffect(() => { let frame = 0; const tick = () => { setRotation((value) => (value + 0.45) % 360); frame = requestAnimationFrame(tick); }; frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame); }, []);

  const setActivity = (id: string, patch: Partial<Activity>) => setActivities((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  const addActivity = (label: string, detail: string) => { const item = { id: nextId("activity"), label, detail, status: "running" as const }; setActivities((current) => [...current, item]); return item.id; };

  const callChat = async (trimmed: string) => {
    const history = messages.map(({ role, content }) => ({ role, content })).slice(-10);
    const res = await fetch("/api/v1/admin/garvex", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ prompt: trimmed, mode: mode === "build" ? "architect" : mode, history }) });
    const text = await res.text(); const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`); return data.data;
  };

  const callEditor = async (projectId: string, body: unknown) => {
    const res = await fetch(`/api/v1/projects/${projectId}/ai/editor`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
    const text = await res.text(); const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`); return data.data;
  };

  const runBuild = async (trimmed: string) => {
    if (!selectedProject) throw new Error("Select a project for Build mode first");
    const inspectId = addActivity("Inspect repository", `${selectedProject.name} · ${selectedProject.repoFullName}`);
    setWorkspaceTab("activity");
    const prepared = await callEditor(selectedProject.id, { mode: "prepare", prompt: trimmed });
    setActivity(inspectId, { status: "complete", detail: `${prepared.files?.length ?? 0} relevant file(s) prepared from ${prepared.baseSha?.slice(0, 10) ?? "current"}` });
    setChangedFiles(prepared.files ?? []); setLastSummary(prepared.summary ?? null); setLastBaseSha(prepared.baseSha ?? null);
    const planId = addActivity("Plan implementation", prepared.summary ?? "Safe file replacements prepared"); setActivity(planId, { status: "complete", detail: prepared.summary ?? "Safe file replacements prepared" });
    const writeId = addActivity("Write code to GitHub", "Creating isolated AI edit branch and commit"); setWorkspaceTab("code");
    const applied = await callEditor(selectedProject.id, { mode: "apply", baseSha: prepared.baseSha, files: prepared.files, summary: prepared.summary });
    setActivity(writeId, { status: "complete", detail: `Branch ${applied.branch} · commit ${applied.commitSha?.slice(0, 10) ?? "created"}` });
    setLastPr(applied.pullRequest ?? null);
    const verifyId = addActivity("Hand off for deployment", applied.pullRequest ? "Pull request opened; production branch remains protected" : "Change published to isolated branch");
    setActivity(verifyId, { status: "complete", detail: applied.pullRequest ?? applied.branch ?? "Completed" });
    return `Done. I changed ${prepared.files?.length ?? 0} file(s) in ${selectedProject.name} and published the work through GitHub. ${applied.pullRequest ? `PR: ${applied.pullRequest}` : ""}`.trim();
  };

  const run = async (event?: FormEvent) => {
    event?.preventDefault(); const trimmed = prompt.trim(); if (!trimmed || busy || !isPlatformAdmin) return;
    setMessages((current) => [...current, { id: nextId("user"), role: "user", content: trimmed, mode }]); setPrompt(""); setBusy(true); setError(null); setWorkers([]); setFailed(0); setLastPr(null); setActivities([]); setWorkspaceTab("activity"); setPhase(mode === "build" ? "Inspecting repository…" : "Dispatching agents…");
    try {
      let answer = "";
      if (mode === "build") { answer = await runBuild(trimmed); setPhase("Change completed"); }
      else { const dispatchId = addActivity("Dispatch agents", `Launching ${configuredCount} configured AI engine(s) in parallel`); const data = await callChat(trimmed); setActivity(dispatchId, { status: "complete", detail: `${data.workers.length} agent(s) responded` }); const reconcileId = addActivity("Reconcile evidence", "Comparing independent outputs before final synthesis"); setActivity(reconcileId, { status: "complete", detail: "Evidence reconciliation complete" }); const synthId = addActivity("Synthesize response", `${data.provider} judge · ${data.model}`); setActivity(synthId, { status: "complete", detail: data.steps?.find((step: { id: string; detail: string }) => step.id === "synthesize")?.detail ?? "Completed" }); setWorkers(data.workers ?? []); setFailed(data.failedWorkers ?? 0); answer = data.answer ?? ""; setPhase("Ready"); }
      setMessages((current) => [...current, { id: nextId("assistant"), role: "assistant", content: answer, mode }]);
    } catch (err) { const message = err instanceof Error ? err.message : String(err); setError(message); setPhase("Stopped with an error"); const failure = addActivity("Execution error", message); setActivity(failure, { status: "error", detail: message }); }
    finally { setBusy(false); requestAnimationFrame(() => textareaRef.current?.focus()); }
  };

  const resetChat = () => { setMessages([]); setActivities([]); setChangedFiles([]); setError(null); setPhase("Ready"); localStorage.removeItem("vo-garvex-history-v2"); };

  return (
    <div className="garvex-shell" onMouseMove={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setTilt({ x: ((event.clientY - rect.top) / rect.height - 0.5) * -10, y: ((event.clientX - rect.left) / rect.width - 0.5) * 12 }); }} onMouseLeave={() => setTilt({ x: 0, y: 0 })}>
      <style>{`@keyframes garvexOrbGlow{0%,100%{filter:drop-shadow(0 0 12px rgba(96,165,250,.15))}50%{filter:drop-shadow(0 0 28px rgba(96,165,250,.38))}}@keyframes garvexOrbRing{from{transform:rotateZ(0deg) rotateX(68deg)}to{transform:rotateZ(360deg) rotateX(68deg)}}`}</style>
      <div className="garvex-chat">
        <header className="garvex-topbar">
          <div className="flex min-w-0 items-center gap-3"><div className="garvex-orb garvex-orb-live" style={{ transform: `perspective(500px) rotateX(${tilt.x}deg) rotateY(${rotation + tilt.y}deg)`, animation: "garvexOrbGlow 3s ease-in-out infinite", transition: "transform 160ms ease-out" }} aria-hidden><span style={{ transform: `rotateZ(${rotation}deg) rotateX(68deg)`, animation: "garvexOrbRing 5s linear infinite" }} /></div><div className="min-w-0"><div className="flex items-center gap-2"><div className="truncate text-[15px] font-semibold">Garvex</div><span className="rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-wider">Agent</span></div><div className="text-[10.5px]" style={{ color: "var(--color-fg-muted)" }}>{configuredCount}/{providers.length} engines connected · {busy ? phase : "Online"}</div></div></div>
          <div className="flex items-center gap-2">{selectedProject ? <span className="hidden max-w-[220px] truncate rounded-full border px-2.5 py-1 text-[10px] sm:inline-flex">Target: {selectedProject.name}</span> : null}<button className="btn hidden sm:inline-flex" type="button" onClick={resetChat}>New chat</button><Link href="/admin/settings" className="btn">Settings</Link></div>
        </header>

        <main className="garvex-messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="garvex-welcome">
              <div className="garvex-orb garvex-orb-xl garvex-orb-live" style={{ transform: `perspective(700px) rotateX(${tilt.x}deg) rotateY(${rotation + tilt.y}deg)`, transition: "transform 180ms ease-out" }} aria-hidden><span /></div>
              <h1>What should Garvex do?</h1><p>Chat, research, or hand it a build command and let the agent inspect, edit and publish the connected project for you.</p>
              <div className="garvex-suggestions"><button onClick={() => { setMode("build"); setPrompt("Inspect the current project and fix the most important visible problem without removing existing functionality."); }}>Fix my project</button><button onClick={() => { setMode("research"); setPrompt("Research this topic and distinguish verified facts from uncertainty."); }}>Deep research</button><button onClick={() => { setMode("build"); setPrompt("Design a production-grade architecture for this application, then implement the necessary frontend and backend changes in the connected project."); }}>Architect & build</button></div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
              {messages.map((message) => { const dir = getDirection(message.content); return <div key={message.id} className={message.role === "user" ? "mb-8 flex justify-end" : "mb-10 flex items-start gap-3"}>{message.role === "assistant" ? <div className="garvex-orb garvex-orb-sm garvex-orb-live mt-1 shrink-0" style={{ transform: `rotateX(${tilt.x * 0.35}deg) rotateY(${rotation + tilt.y}deg)` }} aria-hidden><span /></div> : null}<div className={message.role === "user" ? "garvex-user-message" : "garvex-assistant-message"} dir={dir} style={{ textAlign: dir === "rtl" ? "right" : "left" }}>{message.role === "assistant" ? <MessageResponse>{message.content}</MessageResponse> : <div className="whitespace-pre-wrap leading-7 text-[13px] sm:text-[13.5px]">{message.content}</div>}</div></div>; })}
              {busy ? <div className="mb-10 flex items-start gap-3"><div className="garvex-orb garvex-orb-sm garvex-orb-live mt-1 shrink-0" aria-hidden><span /></div><div className="garvex-typing"><span /><span /><span /></div></div> : null}
              {error ? <div className="mb-8 rounded-xl border px-4 py-3 text-[12px]" style={{ borderColor: "rgba(248,81,73,.3)", color: "#ff9b95", background: "rgba(248,81,73,.05)" }}>{error}</div> : null}
            </div>
          )}
        </main>

        <footer className="garvex-composer-wrap"><div className="mx-auto w-full max-w-4xl px-4 pb-2 sm:px-6"><div className="mb-2 flex flex-wrap items-center gap-2"><label className="hint" htmlFor="garvex-project">Project</label><select id="garvex-project" className="input !w-auto min-w-[190px] text-[11px]" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)} disabled={busy || !projects.length}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.repoFullName}</option>)}</select></div>
          <form onSubmit={run} className="garvex-composer"><div className="flex items-center justify-between gap-2 px-3 pt-2"><div className="flex items-center gap-1.5">{(["chat", "build", "research"] as const).map((item) => <button key={item} type="button" className={mode === item ? "garvex-mode active" : "garvex-mode"} onClick={() => setMode(item)}>{item === "chat" ? "Chat" : item === "build" ? "Build & Fix" : "Research"}</button>)}</div><span className="hint hidden sm:inline">Enter to send · Shift+Enter for new line</span></div>
            <div className="flex items-end gap-2 p-2.5"><button type="button" className="garvex-icon-button" aria-label="Clear chat" title="Clear chat" onClick={resetChat}>⌘</button><textarea ref={textareaRef} className="garvex-textarea" dir={getDirection(prompt)} style={{ textAlign: getDirection(prompt) === "rtl" ? "right" : "left" }} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void run(); } }} placeholder={mode === "build" ? "Tell Garvex exactly what to change…" : "Message Garvex…"} rows={1} disabled={!isPlatformAdmin || busy}/><button type="submit" className="garvex-send" disabled={!prompt.trim() || busy || !isPlatformAdmin} aria-label="Send">↑</button></div></form>
            <div className="garvex-footer-hint">Build mode can prepare and publish an isolated GitHub change automatically. The live workspace shows operational actions and generated code, never private chain-of-thought.</div>
          </div></footer>
      </div>

      <aside className="garvex-live-panel"><div className="flex items-center justify-between"><div><div className="text-[12px] font-semibold">Live workspace</div><div className="hint mt-0.5">Choose exactly what you want to inspect</div></div><span className="garvex-live-dot" /></div>
        <div className="mt-3 grid grid-cols-5 gap-1 border-b pb-2">{(["activity", "code", "preview", "files", "terminal"] as WorkspaceTab[]).map((tab) => <button key={tab} type="button" className={workspaceTab === tab ? "garvex-mode active" : "garvex-mode"} onClick={() => setWorkspaceTab(tab)}>{tab === "activity" ? "Activity" : tab === "code" ? "Code" : tab === "preview" ? "Preview" : tab === "files" ? "Files" : "Terminal"}</button>)}</div>
        {workspaceTab === "activity" ? <div className="mt-3 space-y-2">{activities.length ? activities.map((item) => <div key={item.id} className="garvex-agent-row"><span className={item.status === "complete" ? "garvex-agent-dot ready" : item.status === "error" ? "garvex-agent-dot error" : "garvex-agent-dot"}/><div className="min-w-0 flex-1"><div className="text-[11.5px] font-medium">{item.label}</div><div className="text-[9px]" style={{ color: "var(--color-fg-muted)" }}>{item.detail}</div></div><span className="text-[9px]" style={{ color: "var(--color-fg-muted)" }}>{item.status}</span></div>) : <div className="hint rounded-lg border border-dashed p-3">Start a request and Garvex will surface each operational phase here.</div>}<div className="mt-3 grid grid-cols-3 gap-2"><div className="garvex-stat"><span>{workers.length}</span><small>agents</small></div><div className="garvex-stat"><span>{failed}</span><small>failed</small></div><div className="garvex-stat"><span>{changedFiles.length}</span><small>files</small></div></div></div>
        : workspaceTab === "code" ? <div className="mt-3 space-y-3">{changedFiles.length ? changedFiles.map((file) => <div key={file.path} className="overflow-hidden rounded-lg border"><div className="mono border-b px-3 py-2 text-[10px]">{file.path}</div><pre className="max-h-[420px] overflow-auto p-3 text-[10px] leading-5" dir="ltr"><code>{file.content}</code></pre></div>) : <div className="hint rounded-lg border border-dashed p-3">Build mode will show generated files here.</div>}</div>
        : workspaceTab === "files" ? <div className="mt-3 space-y-1">{changedFiles.length ? changedFiles.map((file) => <div key={file.path} className="mono rounded-md border px-3 py-2 text-[10.5px]">📄 {file.path}</div>) : <div className="hint rounded-lg border border-dashed p-3">No changed files yet.</div>}</div>
        : workspaceTab === "terminal" ? <div className="mt-3 rounded-lg border bg-black/30 p-3 font-mono text-[10px] leading-5" dir="ltr"><div>$ garvex run</div>{activities.map((item) => <div key={item.id}>{item.status === "complete" ? "✓" : item.status === "error" ? "✕" : "›"} {item.label}: {item.detail}</div>)}{!activities.length ? <div className="opacity-50">$ waiting for an agent task…</div> : null}</div>
        : <div className="mt-3 space-y-3">{lastSummary ? <div className="rounded-lg border p-3"><div className="label">Last change</div><div className="mt-1 text-[11px]">{lastSummary}</div>{lastBaseSha ? <div className="mono mt-2 text-[9px] opacity-60">base {lastBaseSha.slice(0, 12)}</div> : null}</div> : null}<div className="rounded-lg border border-dashed p-3 text-[10.5px] text-muted-foreground">{lastPr ? <a className="underline" href={lastPr} target="_blank" rel="noreferrer">Open generated GitHub PR ↗</a> : selectedProject ? <Link className="underline" href={`/projects/${selectedProject.id}`}>Open project workspace ↗</Link> : "Select a project first."}</div></div>}
        <div className="mt-4 space-y-2 border-t pt-3"><div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--color-fg-muted)" }}>Engines</div>{providers.map((provider) => { const worker = workers.find((item) => item.provider === provider.provider); return <div key={provider.provider} className="garvex-agent-row"><span className={worker ? "garvex-agent-dot ready" : provider.configured ? "garvex-agent-dot" : "garvex-agent-dot idle"}/><div className="min-w-0 flex-1"><div className="text-[11px] font-medium">{labels[provider.provider] ?? provider.provider}</div><div className="mono truncate text-[9px]" style={{ color: "var(--color-fg-muted)" }}>{worker?.model ?? provider.model}</div></div><span className="text-[9px]" style={{ color: "var(--color-fg-muted)" }}>{worker ? "used" : provider.configured ? "ready" : "off"}</span></div>; })}</div>
      </aside>
    </div>
  );
}
