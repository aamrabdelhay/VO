"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type VoiceStatus = "off" | "listening" | "thinking" | "speaking";
type LiveMessage = { role: "user" | "assistant"; content: string };
type RecognitionLike = { continuous: boolean; interimResults: boolean; lang: string; start: () => void; stop: () => void; onresult: ((event: any) => void) | null; onend: (() => void) | null; onerror: ((event: any) => void) | null };
type SpeechRecognitionCtor = new () => RecognitionLike;
type LiveVoiceProps = { csrf: string; compact?: boolean };
type Source = { title?: string; url: string };
type AudioChunk = { sequence: number; src: string; text: string };

function getSpeechRecognition() {
  const w = window as any;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as SpeechRecognitionCtor | null;
}
function normalize(text: string) { return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
function similarityEnough(a: string, b: string) { const x = normalize(a); const y = normalize(b); return Boolean(x && y && (x === y || x.includes(y) || y.includes(x))); }
function aborted(error: unknown) { return error instanceof DOMException && error.name === "AbortError"; }

export function GarvexLiveVoice({ csrf, compact = false }: LiveVoiceProps) {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<VoiceStatus>("off");
  const [transcript, setTranscript] = useState("");
  const [response, setResponse] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const activeRef = useRef(false);
  const speakingRef = useRef(false);
  const thinkingRef = useRef(false);
  const audioQueueRef = useRef<AudioChunk[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<LiveMessage[]>([]);
  const lastSpokenRef = useRef("");

  useEffect(() => {
    if (compact) setPortalTarget(document.querySelector(".garvex-v4-input-row"));
    else setPortalTarget(null);
  }, [compact]);

  useEffect(() => () => {
    activeRef.current = false;
    thinkingRef.current = false;
    recognitionRef.current?.stop();
    abortRef.current?.abort();
    audioQueueRef.current = [];
    if (audioRef.current) audioRef.current.pause();
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

  const startRecognition = () => {
    if (!activeRef.current) return;
    try { recognitionRef.current?.start(); } catch {}
  };

  const playNextAudio = () => {
    if (!activeRef.current || speakingRef.current) return;
    const next = audioQueueRef.current.shift();
    if (!next) {
      if (activeRef.current && !thinkingRef.current) {
        setStatus("listening");
        startRecognition();
      }
      return;
    }
    const audio = new Audio(next.src);
    audioRef.current = audio;
    speakingRef.current = true;
    lastSpokenRef.current = next.text;
    setStatus("speaking");
    startRecognition();
    audio.onended = () => {
      audioRef.current = null;
      speakingRef.current = false;
      playNextAudio();
    };
    audio.onerror = () => {
      audioRef.current = null;
      speakingRef.current = false;
      playNextAudio();
    };
    void audio.play().catch(() => {
      audioRef.current = null;
      speakingRef.current = false;
      playNextAudio();
    });
  };

  const queueAudio = (chunk: AudioChunk) => {
    audioQueueRef.current.push(chunk);
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
    setSources([]);
    const controller = new AbortController();
    abortRef.current = controller;
    const res = await fetch("/api/v1/admin/garvex/live", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ prompt: text, history: historyRef.current.slice(-8), voice: true }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Live voice request failed (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let finalReceived = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const line = event.split("\n").find((item) => item.startsWith("data:"));
        if (!line) continue;
        const payload = JSON.parse(line.slice(5).trim()) as { type: string; text?: string; error?: string; audio?: string; sequence?: number; stage?: string; sources?: Source[] };
        if (payload.type === "stage") setStatus("thinking");
        if (payload.type === "delta" && payload.text) { full += payload.text; setResponse(full); }
        if (payload.type === "audio" && payload.audio) queueAudio({ sequence: payload.sequence ?? 0, src: payload.audio, text: payload.text ?? "" });
        if (payload.type === "sources" && payload.sources?.length) setSources(payload.sources);
        if (payload.type === "done") finalReceived = true;
        if (payload.type === "error") throw new Error(payload.error ?? "Live voice failed");
      }
    }
    historyRef.current = [...historyRef.current, { role: "user", content: text }, { role: "assistant", content: full }].slice(-12);
    thinkingRef.current = false;
    if (activeRef.current && !speakingRef.current) {
      setStatus("listening");
      startRecognition();
    }
    void finalReceived;
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
    if (!Ctor) {
      setResponse("Live Voice يحتاج Chrome أو Edge يدعم Speech Recognition.");
      return;
    }
    activeRef.current = true;
    setActive(true);
    thinkingRef.current = false;
    setStatus("listening");
    setTranscript("");
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
      const visible = `${finalText}${interim}`.trim();
      if (visible) setTranscript(visible);

      if (speakingRef.current && interim.trim().length >= 6 && !similarityEnough(interim, lastSpokenRef.current)) {
        interrupt();
        setStatus("listening");
      }

      const spoken = finalText.trim();
      if (!spoken) return;
      if (speakingRef.current && similarityEnough(spoken, lastSpokenRef.current)) return;
      void streamReply(spoken).catch((error) => {
        if (aborted(error)) return;
        thinkingRef.current = false;
        setResponse(error instanceof Error ? error.message : String(error));
        if (activeRef.current) {
          setStatus("listening");
          startRecognition();
        }
      });
    };
    recognition.onend = () => {
      if (activeRef.current) startRecognition();
    };
    recognition.onerror = () => {
      if (activeRef.current) setStatus("listening");
    };
    recognitionRef.current = recognition;
    startRecognition();
  };

  const control = (
    <section className={`garvex-live-voice ${active ? "is-active" : ""} ${compact ? "compact" : ""}`} aria-label="Garvex Live Voice">
      <button type="button" className="garvex-live-voice-button" onClick={active ? stop : start} aria-pressed={active} aria-label={active ? "Turn off Live Voice" : "Turn on Live Voice"} title="Live Voice">
        <span className="garvex-live-voice-pulse" aria-hidden />
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14.5a3.5 3.5 0 0 0 3.5-3.5V7a3.5 3.5 0 0 0-7 0v4a3.5 3.5 0 0 0 3.5 3.5Z"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>
        {!compact ? <span>{active ? "Live Voice · On" : "Live Voice"}</span> : null}
      </button>
      {!compact ? <span className="garvex-live-voice-status">{status === "listening" ? "Listening…" : status === "thinking" ? "Thinking…" : status === "speaking" ? "Speaking…" : "Ready"}</span> : null}
      {!compact && (transcript || response) ? <div className="garvex-live-voice-live"><span>{transcript}</span>{response ? <span>{response}</span> : null}{sources.length ? <div className="garvex-live-voice-sources">{sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer noopener">{source.title || source.url}</a>)}</div> : null}</div> : null}
    </section>
  );

  if (compact) return portalTarget ? createPortal(control, portalTarget) : null;
  return control;
}
