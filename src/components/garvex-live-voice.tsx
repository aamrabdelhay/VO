"use client";

import { useEffect, useRef, useState } from "react";

type VoiceStatus = "off" | "listening" | "thinking" | "speaking";
type LiveMessage = { role: "user" | "assistant"; content: string };
type RecognitionLike = { continuous: boolean; interimResults: boolean; lang: string; start: () => void; stop: () => void; onresult: ((event: any) => void) | null; onend: (() => void) | null; onerror: ((event: any) => void) | null };
type SpeechRecognitionCtor = new () => RecognitionLike;
type LiveVoiceProps = { csrf: string; compact?: boolean };

function getSpeechRecognition() {
  const w = window as any;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as SpeechRecognitionCtor | null;
}
function normalize(text: string) { return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
function similarityEnough(a: string, b: string) { const x = normalize(a); const y = normalize(b); return Boolean(x && y && (x === y || x.includes(y) || y.includes(x))); }

export function GarvexLiveVoice({ csrf, compact = false }: LiveVoiceProps) {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<VoiceStatus>("off");
  const [transcript, setTranscript] = useState("");
  const [response, setResponse] = useState("");
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const activeRef = useRef(false);
  const speakingRef = useRef(false);
  const thinkingRef = useRef(false);
  const audioQueueRef = useRef<{ sequence: number; src: string; text: string }[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<LiveMessage[]>([]);
  const lastSpokenRef = useRef("");

  useEffect(() => () => {
    activeRef.current = false;
    thinkingRef.current = false;
    recognitionRef.current?.stop();
    abortRef.current?.abort();
    audioQueueRef.current = [];
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  const stopAudio = () => {
    audioQueueRef.current = [];
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.src = "";
      audioRef.current = null;
    }
    speakingRef.current = false;
  };

  const playNextAudio = () => {
    if (!activeRef.current || speakingRef.current) return;
    const next = audioQueueRef.current.shift();
    if (!next) {
      if (activeRef.current && !thinkingRef.current) {
        setStatus("listening");
        try { recognitionRef.current?.start(); } catch {}
      }
      return;
    }
    const audio = new Audio(next.src);
    audioRef.current = audio;
    speakingRef.current = true;
    lastSpokenRef.current = next.text;
    setStatus("speaking");
    audio.onended = () => { audioRef.current = null; speakingRef.current = false; playNextAudio(); };
    audio.onerror = () => { audioRef.current = null; speakingRef.current = false; playNextAudio(); };
    void audio.play().catch(() => { audioRef.current = null; speakingRef.current = false; playNextAudio(); });
  };

  const queueAudio = (src: string, sequence: number, text: string) => {
    if (!src) return;
    audioQueueRef.current.push({ sequence, src, text });
    audioQueueRef.current.sort((a, b) => a.sequence - b.sequence);
    playNextAudio();
  };

  const interrupt = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    thinkingRef.current = false;
    stopAudio();
  };

  const streamReply = async (text: string) => {
    interrupt();
    thinkingRef.current = true;
    setStatus("thinking");
    setResponse("");
    const controller = new AbortController();
    abortRef.current = controller;
    const res = await fetch("/api/v1/admin/garvex/live", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ prompt: text, history: historyRef.current.slice(-8) }), signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`Live voice request failed (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const line = event.split("\n").find((item) => item.startsWith("data:"));
        if (!line) continue;
        const payload = JSON.parse(line.slice(5).trim()) as { type: string; text?: string; error?: string; audio?: string; sequence?: number };
        if (payload.type === "delta" && payload.text) { full += payload.text; setResponse(full); }
        if (payload.type === "audio" && payload.audio) queueAudio(payload.audio, payload.sequence ?? 0, payload.text ?? "");
        if (payload.type === "error") throw new Error(payload.error ?? "Live voice failed");
      }
    }
    historyRef.current = [...historyRef.current, { role: "user", content: text }, { role: "assistant", content: full }].slice(-12);
    thinkingRef.current = false;
    if (!speakingRef.current && audioQueueRef.current.length === 0 && activeRef.current) {
      setStatus("listening");
      try { recognitionRef.current?.start(); } catch {}
    }
  };

  const stop = () => {
    interrupt();
    activeRef.current = false;
    setActive(false);
    recognitionRef.current?.stop();
    setStatus("off");
  };

  const start = () => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) { setResponse("Live Voice يحتاج Chrome أو Edge يدعم Speech Recognition."); return; }
    activeRef.current = true;
    setActive(true);
    thinkingRef.current = false;
    setStatus("listening");
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "ar-EG";
    recognition.onresult = (event: any) => {
      let finalText = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const part = event.results[i][0]?.transcript ?? "";
        if (event.results[i].isFinal) finalText += part;
        else interim += part;
      }
      setTranscript(`${finalText}${interim}`.trim());
      const spoken = finalText.trim();
      if (!spoken) return;
      if (speakingRef.current && similarityEnough(spoken, lastSpokenRef.current)) return;
      void streamReply(spoken).catch((error) => {
        if (controllerIsAborted(error)) return;
        thinkingRef.current = false;
        setResponse(error instanceof Error ? error.message : String(error));
        if (activeRef.current) setStatus("listening");
      });
    };
    recognition.onend = () => { if (activeRef.current && !thinkingRef.current) { try { recognition.start(); } catch {} } };
    recognition.onerror = () => { if (activeRef.current && !thinkingRef.current) setStatus("listening"); };
    recognitionRef.current = recognition;
    try { recognition.start(); } catch {}
  };

  return (
    <section className={`garvex-live-voice ${active ? "is-active" : ""} ${compact ? "compact" : ""}`} aria-label="Garvex Live Voice">
      <div className="garvex-live-voice-main">
        <button type="button" className="garvex-live-voice-button" onClick={active ? stop : start} aria-pressed={active}>
          <span className="garvex-live-voice-pulse" aria-hidden />
          <span>{active ? "Live Voice · On" : "Live Voice"}</span>
        </button>
        <span className="garvex-live-voice-status">{status === "listening" ? "Listening…" : status === "thinking" ? "Thinking…" : status === "speaking" ? "Speaking…" : "Ready"}</span>
      </div>
      {!compact && (transcript || response) ? <div className="garvex-live-voice-live" aria-live="polite"><span>{transcript}</span>{response ? <span>{response}</span> : null}</div> : null}
    </section>
  );
}

function controllerIsAborted(error: unknown) { return error instanceof DOMException && error.name === "AbortError"; }
