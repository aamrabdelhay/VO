"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { GarvexOrb } from "@/components/garvex-orb";

type Provider = { provider: string; model: string; configured: boolean; stored?: number; readable?: number; environment?: boolean; state?: "ready" | "stored-unreadable" | "missing" };
type Worker = { provider: string; model: string; tokensIn: number; tokensOut: number };
type Project = { id: string; name: string; repoFullName: string; liveUrl?: string };
type Message = { id: string; role: "user" | "assistant"; content: string; mode?: "chat" | "build" | "research" };
type HistoryItem = { id: string; title: string; projectId: string | null; createdAt: string; updatedAt: string; messageCount: number };
type Tab = "activity" | "code" | "preview" | "files" | "terminal";

const names: Record<string, string> = { nvidia: "NVIDIA", openrouter: "OpenRouter", mistral: "Mistral", cerebras: "Cerebras", groq: "Groq", kilo: "Kilo", cohere: "Cohere" };
const makeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function ProviderPill({ provider }: { provider: Provider }) {
  const state = provider.state ?? (provider.configured ? "ready" : "missing");
  const label = state === "ready" ? "READY" : state === "stored-unreadable" ? "RE-KEY" : "OFF";
  return <div className="garvex-provider-pill"><span className={state === "ready" ? "garvex-agent-dot ready" : state === "stored-unreadable" ? "garvex-agent-dot error" : "garvex-agent-dot idle"} /><div className="min-w-0"><div>{names[provider.provider] ?? provider.provider}</div><div className="mono truncate">{provider.model}</div></div><span>{label}</span></div>;
}

export function GarvexMaxConsoleV3({ csrf, providers, projects, isPlatformAdmin }: { csrf: string; providers: Provider[]; projects: Project[]; isPlatformAdmin: boolean }) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"chat" | "build" | "research">("chat");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id ?? "");
  const [tab, setTab] = useState<Tab>("activity");
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [failed, setFailed] = useState(0);
  const [activity, setActivity] = useState<{ id: string; label: string; detail: string; status: "running" | "complete" | "error" }[]>([]);
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [media, setMedia] = useState<{ kind: "image" | "video"; url: string } | null>(null);
  const [voiceAudio, setVoiceAudio] = useState<string | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState("Ready");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const selectedProject = useMemo(() => projects.find((item) => item.id === selectedProjectId) ?? null, [projects, selectedProjectId]);
  const configuredCount = providers.filter((item) => item.configured).length;
  const unreadableCount = providers.filter((item) => item.state === "stored-unreadable").length;

  const refreshHistory = async () => {
    const response = await fetch("/api/v1/admin/garvex/history", { cache: "no-store" });
    const text = await response.text();
    if (!response.ok) throw new Error(`History failed (${response.status})`);
    const data = text ? JSON.parse(text) as { data?: { chats?: HistoryItem[] } } : {};
    setHistory(data.data?.chats ?? []);
  };

  useEffect(() => {
    void refreshHistory().catch(() => undefined);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); }, []);

  useEffect(() => {
    if (!messages.length || !isPlatformAdmin) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/v1/admin/garvex/history", {
            method: "POST",
            headers: { "content-type": "application/json", "x-csrf-token": csrf },
            body: JSON.stringify({ id: historyId ?? undefined, projectId: selectedProjectId || null, title: messages.find((item) => item.role === "user")?.content ?? "Garvex chat", messages }),
          });
          if (!response.ok) return;
          const text = await response.text();
          const data = text ? JSON.parse(text) as { data?: { id?: string } } : {};
          if (!historyId && data.data?.id) setHistoryId(data.data.id);
          await refreshHistory();
        } catch {
          // Chat remains usable if history persistence is temporarily unavailable.
        }
      })();
    }, 500);
  }, [messages, csrf, historyId, selectedProjectId, isPlatformAdmin]);

  const addActivity = (label: string, detail: string) => {
    const item = { id: makeId("activity"), label, detail, status: "running" as const };
    setActivity((items) => [...items, item]);
    return item.id;
  };
  const finishActivity = (id: string, detail: string, status: "complete" | "error" = "complete") => setActivity((items) => items.map((item) => item.id === id ? { ...item, detail, status } : item));

  const parseJson = async <T,>(response: Response) => {
    const text = await response.text();
    let data: unknown = {};
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Invalid server response (${response.status})`); }
    if (!response.ok) {
      const message = typeof data === "object" && data !== null && "error" in data && typeof (data as { error?: { message?: string } }).error?.message === "string" ? (data as { error: { message: string } }).error.message : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return data as T;
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || busy || !isPlatformAdmin) return;
    const userMessage: Message = { id: makeId("user"), role: "user", content: text, mode };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setPrompt("");
    setBusy(true);
    setError(null);
    setMedia(null);
    setActivity([]);
    setPhase(mode === "build" ? "Inspecting project…" : "Thinking…");
    try {
      if (mode === "build") {
        if (!selectedProject) throw new Error("Select a project for Build & Fix first.");
        const inspect = addActivity("Inspect repository", `${selectedProject.name} · ${selectedProject.repoFullName}`);
        const prepared = await parseJson<{ data: { files?: { path: string; content: string }[]; baseSha?: string; summary?: string } }>(await fetch(`/api/v1/projects/${selectedProject.id}/ai/editor`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ mode: "prepare", prompt: text }) }));
        finishActivity(inspect, `${prepared.data.files?.length ?? 0} relevant file(s) inspected`);
        setFiles(prepared.data.files ?? []);
        const write = addActivity("Write explicit change", "Only Build & Fix is allowed to write to GitHub.");
        const applied = await parseJson<{ data: { branch?: string; commitSha?: string; pullRequest?: string } }>(await fetch(`/api/v1/projects/${selectedProject.id}/ai/editor`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ mode: "apply", baseSha: prepared.data.baseSha, files: prepared.data.files, summary: prepared.data.summary }) }));
        finishActivity(write, `${applied.data.branch ?? "branch"} · ${applied.data.commitSha?.slice(0, 10) ?? "commit"}`);
        setTab("code");
        const responseText = `Done. ${prepared.data.summary ?? "The requested change was applied."}${applied.data.pullRequest ? `\n\nPR: ${applied.data.pullRequest}` : ""}`;
        setMessages((items) => [...items, { id: makeId("assistant"), role: "assistant", content: responseText, mode: "build" }]);
        setPhase("Ready");
      } else {
        const step = addActivity("Dispatch AI council", `${configuredCount} configured engine(s)`);
        const response = await parseJson<{ data: { answer: string; workers?: Worker[]; failedWorkers?: number } }>(await fetch("/api/v1/admin/garvex", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ prompt: text, mode, history: messages.map((item) => ({ role: item.role, content: item.content })).slice(-10), context: selectedProject ? `Project ${selectedProject.name}; repository ${selectedProject.repoFullName}.` : undefined, complex: true }) }));
        finishActivity(step, `${response.data.workers?.length ?? 0} agent(s) responded`);
        setWorkers(response.data.workers ?? []);
        setFailed(response.data.failedWorkers ?? 0);
        setMessages((items) => [...items, { id: makeId("assistant"), role: "assistant", content: response.data.answer ?? "", mode }]);
        setTab("activity");
        setPhase("Ready");
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setPhase("Stopped");
      const item = addActivity("Execution error", message);
      finishActivity(item, message, "error");
    } finally {
      setBusy(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const mediaRequest = async (kind: "image" | "video") => {
    if (busy || !isPlatformAdmin) return;
    const text = prompt.trim() || (kind === "image" ? "Create a premium cinematic website visual, high detail, elegant lighting, no text." : "Create a premium cinematic 4-second website hero video, smooth camera movement, high detail, no text.");
    setBusy(true); setPrompt(""); setError(null); setActivity([]); setPhase(kind === "image" ? "Generating image…" : "Generating video…");
    const item = addActivity(kind === "image" ? "Generate image" : "Generate video", "Media pipeline");
    try {
      const response = await fetch("/api/v1/admin/garvex/media", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ kind, prompt: text, duration: 4, resolution: "720p", aspectRatio: "16:9", generateAudio: true }) });
      const data = await parseJson<{ data: { image?: string; job?: { id?: string } } }>(response);
      if (kind === "image") {
        if (!data.data.image) throw new Error("No image returned by the media provider.");
        setMedia({ kind, url: data.data.image }); setTab("preview"); finishActivity(item, "Image ready");
      } else {
        const jobId = data.data.job?.id;
        if (!jobId) throw new Error("Video job was not created.");
        for (let attempt = 0; attempt < 36; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const result = await parseJson<{ data?: { video?: { status?: string; unsigned_urls?: string[]; content_url?: string } } }>(await fetch(`/api/v1/admin/garvex/media?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" }));
          const video = result.data?.video;
          if (video?.status === "completed") {
            const url = video.unsigned_urls?.[0] ?? video.content_url;
            if (!url) throw new Error("Video completed without a playable URL.");
            setMedia({ kind, url }); setTab("preview"); finishActivity(item, "Video ready"); break;
          }
          if (video?.status === "failed" || video?.status === "error") throw new Error("Video generation failed.");
          if (attempt === 35) throw new Error("Video generation timed out.");
        }
      }
      setPhase("Ready");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught); setError(message); finishActivity(item, message, "error");
    } finally { setBusy(false); }
  };

  const stopRecordingAndSend = () => {
    if (!recorderRef.current) return;
    recorderRef.current.stop();
    setRecording(false);
  };

  const startVoice = async () => {
    if (voiceBusy) return;
    if (recording) { stopRecordingAndSend(); return; }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setVoiceBusy(true);
        setPhase("Processing voice…");
        try {
          const form = new FormData();
          form.append("audio", new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }), "voice.webm");
          const result = await parseJson<{ data: { transcript: string; answer: string; audio?: string } }>(await fetch("/api/v1/admin/garvex/voice", { method: "POST", headers: { "x-csrf-token": csrf }, body: form }));
          setMessages((items) => [...items, { id: makeId("user"), role: "user", content: result.data.transcript, mode: "chat" }, { id: makeId("assistant"), role: "assistant", content: result.data.answer, mode: "chat" }]);
          setVoiceAudio(result.data.audio ?? null);
          if (!result.data.audio && "speechSynthesis" in window) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(result.data.answer);
            utterance.lang = /[\u0600-\u06FF]/.test(result.data.answer) ? "ar-EG" : "en-US";
            utterance.rate = 0.95;
            utterance.pitch = 0.9;
            window.speechSynthesis.speak(utterance);
          }
          setPhase("Ready");
        } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setPhase("Stopped"); }
        finally { setVoiceBusy(false); }
      };
      recorder.start();
      setRecording(true);
      setPhase("Listening…");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Microphone access failed"); }
  };

  const loadChat = async (id: string) => {
    try {
      const response = await fetch(`/api/v1/admin/garvex/history?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await parseJson<{ data: { chat?: { id: string; projectId: string | null; messages: Message[] } | null } }>(response);
      if (!data.data.chat) return;
      setHistoryId(data.data.chat.id); setMessages(data.data.chat.messages); setSelectedProjectId(data.data.chat.projectId ?? ""); setHistoryOpen(false); setError(null); setMedia(null); setTab("activity");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  const newChat = () => { setMessages([]); setHistoryId(null); setMedia(null); setVoiceAudio(null); setActivity([]); setError(null); setPhase("Ready"); setPrompt(""); };

  return (
    <div className="garvex-v3-shell">
      <header className="garvex-v3-topbar">
        <div className="garvex-v3-brand"><div className="garvex-v3-orb"><GarvexOrb size={52} /></div><div><div className="garvex-brand-title">Garvex<span>MAX</span></div><div className="garvex-brand-sub">{configuredCount}/{providers.length} engines · {phase}</div></div></div>
        <div className="garvex-top-actions"><button type="button" className="garvex-ghost" onClick={() => setHistoryOpen((value) => !value)}>History</button><button type="button" className="garvex-ghost" onClick={newChat}>New chat</button><Link className="garvex-ghost" href="/admin/settings">Settings</Link></div>
      </header>

      {unreadableCount ? <div className="garvex-v3-warning"><strong>{unreadableCount} credential(s) need re-save.</strong><span>The encrypted records are still present, but this deployment cannot decrypt them. Re-save them once under Platform Settings; new keys use the stable platform encryption material.</span><Link href="/admin/settings">Open Settings →</Link></div> : null}

      <div className="garvex-v3-body">
        {historyOpen ? <aside className="garvex-history"><div className="garvex-history-head"><strong>Chat history</strong><button type="button" className="garvex-icon-button" onClick={() => setHistoryOpen(false)} aria-label="Close history">×</button></div><button type="button" className="garvex-history-new" onClick={newChat}>＋ New chat</button><div className="garvex-history-list">{history.length ? history.map((item) => <div key={item.id} className={item.id === historyId ? "garvex-history-item active" : "garvex-history-item"}><button type="button" onClick={() => void loadChat(item.id)}><span>{item.title.slice(0, 70)}</span><small>{item.messageCount} messages · {new Date(item.updatedAt).toLocaleDateString()}</small></button><button type="button" className="garvex-history-delete" aria-label="Delete chat" onClick={async () => { await fetch(`/api/v1/admin/garvex/history?id=${encodeURIComponent(item.id)}`, { method: "DELETE", headers: { "x-csrf-token": csrf } }); if (historyId === item.id) newChat(); await refreshHistory(); }}>×</button></div>) : <div className="garvex-history-empty">Your saved conversations will appear here.</div>}</div></aside> : null}

        <main className="garvex-v3-main">
          <div className="garvex-v3-scroll" data-garvex-scroll="true">
            {!messages.length && !media ? <section className="garvex-v3-welcome"><div className="garvex-v3-hero-orb"><GarvexOrb size={230} /><div className="garvex-orb-halo" /></div><div className="garvex-kicker">AUTONOMOUS ENGINEERING CONTROL</div><h1>Talk to Garvex.<br /><em>Build the thing.</em></h1><p>One control center for repositories, deployments, AI agents and media pipelines.</p><div className="garvex-v3-quick"><button type="button" onClick={() => { setMode("build"); setPrompt("Inspect the selected project and fix its most important current issue."); }}>Build &amp; Fix<span>Write only after explicit request</span></button><button type="button" onClick={() => { setMode("research"); setPrompt("Research the current issue and explain the strongest evidence-backed solution."); }}>Research<span>Read-only multi-agent reasoning</span></button><button type="button" onClick={() => void mediaRequest("image")}>Image<span>Generate a visual</span></button><button type="button" onClick={() => void mediaRequest("video")}>Video<span>Generate motion</span></button></div></section> : null}

            {messages.map((message) => <div key={message.id} className={message.role === "user" ? "garvex-v3-message user" : "garvex-v3-message assistant"} dir={/[\u0600-\u06FF]/.test(message.content) ? "rtl" : "ltr"}><div className="garvex-message-role">{message.role === "user" ? "You" : "Garvex"}{message.mode ? ` · ${message.mode}` : ""}</div><div className="garvex-message-content">{message.content}</div></div>)}
            {busy ? <div className="garvex-v3-message assistant"><div className="garvex-typing"><span /><span /><span /></div></div> : null}
            {media ? <div className="garvex-media-result">{media.kind === "image" ? <img src={media.url} alt="Garvex generated" /> : <video src={media.url} controls playsInline autoPlay />}</div> : null}
            {voiceAudio ? <div className="garvex-voice-result"><div>Garvex voice</div><audio src={voiceAudio} controls autoPlay /></div> : null}
            {error ? <div className="garvex-error">{error}</div> : null}
            <div ref={endRef} />
          </div>

          <footer className="garvex-v3-composer-wrap">
            <div className="garvex-v3-composer-tools"><label>Project<select className="input" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}><option value="">Global — no project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.repoFullName}</option>)}</select></label><div className="garvex-media-tools"><button type="button" className="garvex-tool" onClick={() => void mediaRequest("image")} disabled={busy}>◈ Image</button><button type="button" className="garvex-tool" onClick={() => void mediaRequest("video")} disabled={busy}>◉ Video</button><button type="button" className={recording ? "garvex-tool recording" : "garvex-tool"} onClick={() => void startVoice()} disabled={voiceBusy}>{recording ? "■ Stop" : "◌ Live voice"}</button></div></div>
            <form className="garvex-v3-composer" onSubmit={(event) => void send(event)}><div className="garvex-mode-row"><div className="flex gap-1"><button type="button" className={mode === "chat" ? "garvex-mode active" : "garvex-mode"} onClick={() => setMode("chat")}>Chat</button><button type="button" className={mode === "build" ? "garvex-mode active" : "garvex-mode"} onClick={() => setMode("build")}>Build &amp; Fix</button><button type="button" className={mode === "research" ? "garvex-mode active" : "garvex-mode"} onClick={() => setMode("research")}>Research</button></div><span className="garvex-input-hint">Enter to send · Shift+Enter for line break</span></div><div className="garvex-input-row"><textarea ref={textareaRef} className="garvex-textarea" rows={1} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={mode === "build" ? "Tell Garvex exactly what to change…" : "Message Garvex…"} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} /><button className="garvex-send" type="submit" disabled={!prompt.trim() || busy}>↗</button></div></form><div className="garvex-footline"><span>GPU 3D orb</span><span>Adaptive refresh</span><span>Persistent history</span><span>Chat &amp; Research read-only</span><span>Build writes only on request</span></div></footer>
          </main>

        <aside className="garvex-v3-workspace"><div className="garvex-panel-head"><div><div className="garvex-panel-title">Live workspace</div><div className="hint">Agents · code · preview · runtime</div></div><span className="garvex-live-dot" /></div><div className="garvex-tabs">{(["activity", "code", "preview", "files", "terminal"] as Tab[]).map((item) => <button key={item} type="button" className={tab === item ? "garvex-mode active" : "garvex-mode"} onClick={() => setTab(item)}>{item}</button>)}</div>{tab === "activity" ? <div className="garvex-work-content">{activity.length ? activity.map((item) => <div key={item.id} className="garvex-work-item"><span className={item.status === "error" ? "garvex-agent-dot error" : item.status === "complete" ? "garvex-agent-dot ready" : "garvex-agent-dot"} /><div><strong>{item.label}</strong><span>{item.detail}</span></div></div>) : <div className="hint rounded-xl border border-dashed p-4">Waiting for an agent task…</div>}<div className="garvex-stats"><div><b>{workers.length}</b><span>agents</span></div><div><b>{failed}</b><span>failed</span></div><div><b>{files.length}</b><span>files</span></div></div></div> : null}{tab === "code" ? <div className="garvex-code-list">{files.length ? files.map((file) => <div key={file.path}><div className="mono">{file.path}</div><pre>{file.content.slice(0, 5000)}</pre></div>) : <div className="hint">No code changes in the current chat.</div>}</div> : null}{tab === "preview" ? <div className="garvex-preview-panel">{media ? (media.kind === "image" ? <img src={media.url} alt="Preview" /> : <video src={media.url} controls playsInline />) : <div className="hint">Generate an image or video to preview it here.</div>}</div> : null}{tab === "files" ? <div className="hint">Project files are available through Build &amp; Fix and the repository workspace.</div> : null}{tab === "terminal" ? <div className="hint">Terminal output appears here when a real execution step is running.</div> : null}<div className="garvex-provider-list">{providers.map((provider) => <ProviderPill key={`${provider.provider}:${provider.model}`} provider={provider} />)}</div></aside>
      </div>
    </div>
  );
}
