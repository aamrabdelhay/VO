"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Provider = { provider: string; model: string; configured: boolean; state?: "ready" | "stored-unreadable" | "missing" };
type Project = { id: string; name: string; repoFullName: string; liveUrl?: string };
type Message = { id: string; role: "user" | "assistant"; content: string; mode?: "chat" | "build" | "research" };
type HistoryItem = { id: string; title: string; projectId: string | null; createdAt: string; updatedAt: string; messageCount: number };
type Tab = "activity" | "code" | "preview" | "files" | "terminal";

type Worker = { provider: string; model: string; tokensIn: number; tokensOut: number };

const names: Record<string, string> = { nvidia: "NVIDIA", openrouter: "OpenRouter", mistral: "Mistral", cerebras: "Cerebras", groq: "Groq", kilo: "Kilo", cohere: "Cohere" };
const id = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function StatusDot({ state }: { state: "ready" | "loading" | "error" | "idle" }) {
  return <span className={`garvex-v4-dot ${state}`} aria-hidden />;
}

export function GarvexChatV4({ csrf, providers, projects, isPlatformAdmin }: { csrf: string; providers: Provider[]; projects: Project[]; isPlatformAdmin: boolean }) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"chat" | "build" | "research">("chat");
  const [busy, setBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("activity");
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id ?? "");
  const [activity, setActivity] = useState<{ id: string; label: string; detail: string; status: "running" | "complete" | "error" }[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [failed, setFailed] = useState(0);
  const [media, setMedia] = useState<{ kind: "image" | "video"; url: string } | null>(null);
  const [voiceAudio, setVoiceAudio] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState("Ready");
  const [liveCapability, setLiveCapability] = useState<{ kind: string; state: string; model?: string; provider?: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const selectedProject = useMemo(() => projects.find((item) => item.id === selectedProjectId) ?? null, [projects, selectedProjectId]);
  const configured = providers.filter((item) => item.configured).length;

  const parseJson = async <T,>(response: Response) => {
    const text = await response.text();
    let data: unknown = {};
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Invalid server response (${response.status})`); }
    if (!response.ok) {
      const message = typeof data === "object" && data !== null && "error" in data && typeof (data as { error?: { message?: string } }).error?.message === "string"
        ? (data as { error: { message: string } }).error.message
        : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return data as T;
  };

  const refreshHistory = async () => {
    const response = await fetch("/api/v1/admin/garvex/history", { cache: "no-store" });
    if (!response.ok) return;
    const data = await parseJson<{ data?: { chats?: HistoryItem[] } }>(response);
    setHistory(data.data?.chats ?? []);
  };

  useEffect(() => { void refreshHistory(); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, busy, media]);

  const emitCapability = (capability: { kind: string; state: string; model?: string; provider?: string }) => {
    setLiveCapability(capability);
    window.dispatchEvent(new CustomEvent("garvex:capability", { detail: capability }));
  };

  const newChat = () => {
    setMessages([]); setHistoryId(null); setPrompt(""); setMedia(null); setVoiceAudio(null); setActivity([]); setError(null); setPhase("Ready"); setWorkers([]); setFiles([]); setFailed(0); setTab("activity");
  };

  const loadChat = async (chatId: string) => {
    try {
      setError(null); setPhase("Loading chat…");
      const response = await fetch(`/api/v1/admin/garvex/history?id=${encodeURIComponent(chatId)}`, { cache: "no-store" });
      const data = await parseJson<{ data: { chat?: { id: string; projectId: string | null; messages: Message[] } | null } }>(response);
      if (!data.data.chat) throw new Error("Chat not found.");
      setHistoryId(data.data.chat.id); setMessages(data.data.chat.messages ?? []); setSelectedProjectId(data.data.chat.projectId ?? ""); setHistoryOpen(false); setWorkspaceOpen(false); setPhase("Ready"); setMedia(null); setVoiceAudio(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught)); setPhase("Stopped");
    }
  };

  useEffect(() => {
    if (!messages.length || !isPlatformAdmin) return;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/v1/admin/garvex/history", {
          method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf },
          body: JSON.stringify({ id: historyId ?? undefined, projectId: selectedProjectId || null, title: messages.find((item) => item.role === "user")?.content ?? "Garvex chat", messages }),
        });
        if (!response.ok) return;
        const data = await parseJson<{ data?: { id?: string } }>(response);
        if (!historyId && data.data?.id) setHistoryId(data.data.id);
        await refreshHistory();
      } catch { /* persistence must not block chat */ }
    }, 600);
    return () => clearTimeout(timer);
  }, [messages, historyId, selectedProjectId, csrf, isPlatformAdmin]);

  const finish = (activityId: string, detail: string, status: "complete" | "error" = "complete") => setActivity((items) => items.map((item) => item.id === activityId ? { ...item, detail, status } : item));
  const start = (label: string, detail: string) => { const item = { id: id("activity"), label, detail, status: "running" as const }; setActivity((items) => [...items, item]); return item.id; };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || busy || !isPlatformAdmin) return;
    const userMessage: Message = { id: id("user"), role: "user", content: text, mode };
    setMessages((items) => [...items, userMessage]);
    setPrompt(""); setBusy(true); setError(null); setMedia(null); setActivity([]); setWorkspaceOpen(true); setPhase(mode === "build" ? "Inspecting…" : mode === "research" ? "Researching…" : "Thinking…");
    emitCapability({ kind: "text", state: "loading" });
    try {
      if (mode === "build") {
        if (!selectedProject) throw new Error("Select a project for Build & Fix first.");
        const inspect = start("Inspect repository", `${selectedProject.name} · ${selectedProject.repoFullName}`);
        const prepared = await parseJson<{ data: { files?: { path: string; content: string }[]; baseSha?: string; summary?: string } }>(await fetch(`/api/v1/projects/${selectedProject.id}/ai/editor`, {
          method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ mode: "prepare", prompt: text }),
        }));
        finish(inspect, `${prepared.data.files?.length ?? 0} relevant file(s)`);
        setFiles(prepared.data.files ?? []);
        const write = start("Apply explicit change", "Build & Fix is the only write path.");
        const applied = await parseJson<{ data: { branch?: string; commitSha?: string; pullRequest?: string } }>(await fetch(`/api/v1/projects/${selectedProject.id}/ai/editor`, {
          method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ mode: "apply", baseSha: prepared.data.baseSha, files: prepared.data.files, summary: prepared.data.summary }),
        }));
        finish(write, `${applied.data.branch ?? "branch"} · ${applied.data.commitSha?.slice(0, 9) ?? "commit"}`);
        setMessages((items) => [...items, { id: id("assistant"), role: "assistant", content: `Done. ${prepared.data.summary ?? "The requested change was applied."}${applied.data.pullRequest ? `\n\nPR: ${applied.data.pullRequest}` : ""}`, mode: "build" }]);
        setTab("code"); emitCapability({ kind: "text", state: "success", provider: "Build & Fix" }); setPhase("Ready");
      } else {
        const task = start(mode === "research" ? "Run evidence search" : "Run AI council", `${configured} configured engine(s)`);
        const response = await parseJson<{ data: { answer: string; workers?: Worker[]; failedWorkers?: number } }>(await fetch("/api/v1/admin/garvex", {
          method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ prompt: text, mode, history: messages.slice(-10).map((item) => ({ role: item.role, content: item.content })), context: selectedProject ? `Project ${selectedProject.name}; repository ${selectedProject.repoFullName}.` : undefined, complex: true }),
        }));
        finish(task, `${response.data.workers?.length ?? 0} agent(s) responded`);
        setWorkers(response.data.workers ?? []); setFailed(response.data.failedWorkers ?? 0);
        setMessages((items) => [...items, { id: id("assistant"), role: "assistant", content: response.data.answer ?? "", mode }]);
        setTab("activity"); emitCapability({ kind: "text", state: "success", provider: response.data.workers?.[0]?.provider, model: response.data.workers?.[0]?.model }); setPhase("Ready");
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught); setError(message); setPhase("Stopped"); emitCapability({ kind: "text", state: "error" });
      const task = start("Execution error", message); finish(task, message, "error");
    } finally { setBusy(false); requestAnimationFrame(() => textareaRef.current?.focus()); }
  };

  const mediaRequest = async (kind: "image" | "video") => {
    if (busy || !isPlatformAdmin) return;
    const text = prompt.trim() || (kind === "image" ? "Create a premium cinematic visual with no text." : "Create a premium cinematic 4-second motion clip with no text.");
    setBusy(true); setPrompt(""); setError(null); setActivity([]); setWorkspaceOpen(true); setPhase(kind === "image" ? "Generating image…" : "Generating video…"); emitCapability({ kind, state: "loading" });
    const task = start(kind === "image" ? "Generate image" : "Generate video", "Media pipeline");
    try {
      const data = await parseJson<{ data: { image?: string; job?: { id?: string } } }>(await fetch("/api/v1/admin/garvex/media", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ kind, prompt: text, duration: 4, resolution: "720p", aspectRatio: "16:9", generateAudio: true }) }));
      if (kind === "image") {
        if (!data.data.image) throw new Error("No image returned by the media provider.");
        setMedia({ kind, url: data.data.image }); setTab("preview"); finish(task, "Image ready"); emitCapability({ kind, state: "success", provider: "Media pipeline" });
      } else {
        const jobId = data.data.job?.id; if (!jobId) throw new Error("Video job was not created.");
        for (let attempt = 0; attempt < 36; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const result = await parseJson<{ data?: { video?: { status?: string; unsigned_urls?: string[]; content_url?: string } } }>(await fetch(`/api/v1/admin/garvex/media?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" }));
          const video = result.data?.video;
          if (video?.status === "completed") { const url = video.unsigned_urls?.[0] ?? video.content_url; if (!url) throw new Error("Video completed without a playable URL."); setMedia({ kind, url }); setTab("preview"); finish(task, "Video ready"); emitCapability({ kind, state: "success", provider: "Media pipeline" }); break; }
          if (video?.status === "failed" || video?.status === "error") throw new Error("Video generation failed.");
        }
      }
      setPhase("Ready");
    } catch (caught) { const message = caught instanceof Error ? caught.message : String(caught); setError(message); finish(task, message, "error"); emitCapability({ kind, state: "error" }); setPhase("Stopped"); }
    finally { setBusy(false); }
  };

  const startVoice = async () => {
    if (voiceBusy) return;
    if (recording) { recorderRef.current?.stop(); setRecording(false); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream); recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop()); setVoiceBusy(true); setWorkspaceOpen(true); setPhase("Processing voice…"); emitCapability({ kind: "audio", state: "loading" });
        try {
          const form = new FormData(); form.append("audio", new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }), "voice.webm");
          const result = await parseJson<{ data: { transcript: string; answer: string; audio?: string } }>(await fetch("/api/v1/admin/garvex/voice", { method: "POST", headers: { "x-csrf-token": csrf }, body: form }));
          setMessages((items) => [...items, { id: id("user"), role: "user", content: result.data.transcript, mode: "chat" }, { id: id("assistant"), role: "assistant", content: result.data.answer, mode: "chat" }]);
          setVoiceAudio(result.data.audio ?? null); emitCapability({ kind: "audio", state: "success", provider: "Voice pipeline" }); setPhase("Ready");
        } catch (caught) { const message = caught instanceof Error ? caught.message : String(caught); setError(message); emitCapability({ kind: "audio", state: "error" }); setPhase("Stopped"); }
        finally { setVoiceBusy(false); }
      };
      recorder.start(); setRecording(true); setPhase("Listening…"); emitCapability({ kind: "audio", state: "loading", provider: "Microphone" });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Microphone access failed"); }
  };

  const topProvider = liveCapability?.provider || providers.find((item) => item.configured)?.provider || "Auto";
  const topModel = liveCapability?.model || providers.find((item) => item.configured)?.model || "Automatic fallback";

  return (
    <div className="garvex-v4-shell">
      <header className="garvex-v4-topbar">
        <div className="garvex-v4-title"><button type="button" className="garvex-v4-icon" onClick={() => setHistoryOpen((value) => !value)} aria-label="Open chat history">☰</button><div><strong>Garvex</strong><span>AI control plane</span></div></div>
        <div className="garvex-v4-topcenter"><StatusDot state={busy || voiceBusy ? "loading" : error ? "error" : "ready"} /><span>{phase}</span><b>{topProvider}</b><small>{topModel}</small></div>
        <div className="garvex-v4-actions"><button type="button" className="garvex-v4-button secondary" onClick={() => { newChat(); setHistoryOpen(false); }}>New chat</button><button type="button" className="garvex-v4-button" onClick={() => setWorkspaceOpen((value) => !value)}>{workspaceOpen ? "Hide workspace" : "Workspace"}</button></div>
      </header>

      <div className="garvex-v4-body">
        <aside className={historyOpen ? "garvex-v4-drawer history open" : "garvex-v4-drawer history"} aria-hidden={!historyOpen}>
          <div className="garvex-v4-drawer-head"><strong>Chat history</strong><button type="button" className="garvex-v4-icon" onClick={() => setHistoryOpen(false)} aria-label="Close history">×</button></div>
          <button type="button" className="garvex-v4-new" onClick={() => { newChat(); setHistoryOpen(false); }}>＋ New conversation</button>
          <div className="garvex-v4-list">{history.length ? history.map((item) => <div key={item.id} className={item.id === historyId ? "garvex-v4-history active" : "garvex-v4-history"}><button type="button" onClick={() => void loadChat(item.id)}><span>{item.title.slice(0, 65)}</span><small>{item.messageCount} messages · {new Date(item.updatedAt).toLocaleDateString()}</small></button><button type="button" className="garvex-v4-delete" aria-label="Delete conversation" onClick={async () => { await fetch(`/api/v1/admin/garvex/history?id=${encodeURIComponent(item.id)}`, { method: "DELETE", headers: { "x-csrf-token": csrf } }); if (historyId === item.id) newChat(); await refreshHistory(); }}>×</button></div>) : <div className="garvex-v4-empty">No saved conversations yet.</div>}</div>
        </aside>

        <main className="garvex-v4-main">
          {!messages.length && !media ? <section className="garvex-v4-welcome"><div className="garvex-v4-kicker">WHAT SHOULD GARVEX DO?</div><h1>Build. Research. Create.</h1><p>One conversation for code, deployments, reasoning and media — with the active engine visible at a glance.</p><div className="garvex-v4-actions-grid"><button type="button" onClick={() => { setMode("build"); setPrompt("Inspect the selected project and fix its most important current issue."); }}><b>Build &amp; Fix</b><span>Explicit writes only</span></button><button type="button" onClick={() => { setMode("research"); setPrompt("Research the current issue and explain the strongest evidence-backed solution."); }}><b>Research</b><span>Read-only council</span></button><button type="button" onClick={() => void mediaRequest("image")}><b>Image</b><span>Generate a visual</span></button><button type="button" onClick={() => void mediaRequest("video")}><b>Video</b><span>Generate motion</span></button></div></section> : null}

          {messages.map((message) => <article key={message.id} className={`garvex-v4-message ${message.role}`} dir={/[\u0600-\u06FF]/.test(message.content) ? "rtl" : "ltr"}><div className="garvex-v4-role">{message.role === "user" ? "You" : "Garvex"}<span>{message.mode ? ` · ${message.mode}` : ""}</span></div><div className="garvex-v4-content">{message.content}</div></article>)}
          {busy ? <article className="garvex-v4-message assistant"><div className="garvex-v4-role">Garvex</div><div className="garvex-v4-thinking"><span /><span /><span /></div></article> : null}
          {media ? <div className="garvex-v4-media">{media.kind === "image" ? <img src={media.url} alt="Garvex generated" /> : <video src={media.url} controls playsInline autoPlay />}</div> : null}
          {voiceAudio ? <div className="garvex-v4-audio"><span>Garvex voice</span><audio src={voiceAudio} controls autoPlay /></div> : null}
          {error ? <div className="garvex-v4-error"><StatusDot state="error" /><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div> : null}
          <div ref={endRef} />
        </main>

        <aside className={workspaceOpen ? "garvex-v4-drawer workspace open" : "garvex-v4-drawer workspace"} aria-hidden={!workspaceOpen}>
          <div className="garvex-v4-drawer-head"><div><strong>Workspace</strong><small>{selectedProject ? `${selectedProject.name} · ${selectedProject.repoFullName}` : "No project selected"}</small></div><button type="button" className="garvex-v4-icon" onClick={() => setWorkspaceOpen(false)} aria-label="Close workspace">×</button></div>
          <div className="garvex-v4-tabs">{(["activity", "code", "preview", "files", "terminal"] as Tab[]).map((item) => <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
          {tab === "activity" ? <div className="garvex-v4-panel">{activity.length ? activity.map((item) => <div className="garvex-v4-activity" key={item.id}><StatusDot state={item.status === "error" ? "error" : item.status === "complete" ? "ready" : "loading"} /><div><b>{item.label}</b><span>{item.detail}</span></div></div>) : <div className="garvex-v4-muted">Activity appears here while Garvex is working.</div>}<div className="garvex-v4-stats"><div><b>{workers.length}</b><span>agents</span></div><div><b>{failed}</b><span>failed</span></div><div><b>{files.length}</b><span>files</span></div></div></div> : null}
          {tab === "code" ? <div className="garvex-v4-panel">{files.length ? files.map((file) => <div className="garvex-v4-code" key={file.path}><b>{file.path}</b><pre>{file.content.slice(0, 5000)}</pre></div>) : <div className="garvex-v4-muted">Build &amp; Fix file inspection appears here.</div>}</div> : null}
          {tab === "preview" ? <div className="garvex-v4-panel">{media ? (media.kind === "image" ? <img className="garvex-v4-preview" src={media.url} alt="Preview" /> : <video className="garvex-v4-preview" src={media.url} controls playsInline />) : <div className="garvex-v4-muted">Generate an image or video to preview it here.</div>}</div> : null}
          {tab === "files" ? <div className="garvex-v4-panel"><div className="garvex-v4-muted">Files are exposed through Build &amp; Fix inspection and the project workspace.</div></div> : null}
          {tab === "terminal" ? <div className="garvex-v4-panel"><div className="garvex-v4-muted">Live terminal output is shown here when a real execution step is active.</div></div> : null}
          <div className="garvex-v4-provider-section"><div className="garvex-v4-section-label">Active engines</div>{providers.map((provider) => <div className="garvex-v4-provider" key={`${provider.provider}:${provider.model}`}><StatusDot state={provider.state === "ready" ? "ready" : provider.state === "stored-unreadable" ? "error" : "idle"} /><div><b>{names[provider.provider] ?? provider.provider}</b><span>{provider.model}</span></div></div>)}</div>
        </aside>

        <footer className="garvex-v4-composer-area">
          <div className="garvex-v4-composer-meta"><select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}><option value="">Global — no project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><div className="garvex-v4-capabilities"><span><StatusDot state={liveCapability?.kind === "text" ? (liveCapability.state as "loading" | "error" | "ready") : "ready"} /> Text</span><span><StatusDot state={liveCapability?.kind === "image" ? (liveCapability.state as "loading" | "error" | "ready") : "ready"} /> Image</span><span><StatusDot state={liveCapability?.kind === "audio" ? (liveCapability.state as "loading" | "error" | "ready") : "ready"} /> Voice</span><span><StatusDot state={liveCapability?.kind === "video" ? (liveCapability.state as "loading" | "error" | "ready") : "ready"} /> Video</span></div></div>
          <form className="garvex-v4-composer" onSubmit={(event) => void send(event)}>
            <div className="garvex-v4-mode-row"><div>{(["chat", "build", "research"] as const).map((item) => <button key={item} type="button" className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{item === "chat" ? "Chat" : item === "build" ? "Build & Fix" : "Research"}</button>)}</div><span>Enter ↵ · Shift+Enter line break</span></div>
            <div className="garvex-v4-input-row"><textarea ref={textareaRef} rows={1} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={mode === "build" ? "Tell Garvex exactly what to change…" : "Message Garvex…"} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} /><button type="button" className={recording ? "recording" : ""} onClick={() => void startVoice()} disabled={voiceBusy}>{recording ? "■" : "◉"}</button><button type="button" onClick={() => void mediaRequest("image")} disabled={busy}>＋</button><button className="send" type="submit" disabled={!prompt.trim() || busy}>{busy ? "…" : "↑"}</button></div>
          </form>
          <div className="garvex-v4-foot"><span>Garvex chooses the best available engine and falls back automatically.</span><span>{configured}/{providers.length} configured</span></div>
        </footer>
      </div>
    </div>
  );
}
