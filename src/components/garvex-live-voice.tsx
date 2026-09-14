"use client";

import { useEffect, useRef, useState } from "react";

type VoiceStatus = "off" | "listening" | "thinking" | "speaking";
type LiveMessage = { role: "user" | "assistant"; content: string };
type RecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: any) => void) | null;
};
type SpeechRecognitionCtor = new () => RecognitionLike;

function getSpeechRecognition() {
  const w = window as any;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as SpeechRecognitionCtor | null;
}

export function GarvexLiveVoice({ csrf }: { csrf: string }) {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<VoiceStatus>("off");
  const [transcript, setTranscript] = useState("");
  const [response, setResponse] = useState("");
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const activeRef = useRef(false);
  const speakingRef = useRef(false);
  const thinkingRef = useRef(false);
  const speechQueueRef = useRef<string[]>([]);
  const sentenceBufferRef = useRef("");
  const historyRef = useRef<LiveMessage[]>([]);

  useEffect(() => {
    return () => {
      activeRef.current = false;
      recognitionRef.current?.stop();
      speechQueueRef.current = [];
      window.speechSynthesis?.cancel();
    };
  }, []);

  const speakNext = () => {
    if (!window.speechSynthesis || speakingRef.current) return;
    const next = speechQueueRef.current.shift()?.trim();
    if (!next) {
      if (activeRef.current && !thinkingRef.current) {
        setStatus("listening");
        try { recognitionRef.current?.start(); } catch {}
      } else if (!activeRef.current) {
        setStatus("off");
      }
      return;
    }
    const utterance = new SpeechSynthesisUtterance(next);
    utterance.lang = /[\u0600-\u06ff]/.test(next) ? "ar-EG" : "en-US";
    utterance.rate = 1.05;
    utterance.pitch = 1;
    speakingRef.current = true;
    setStatus("speaking");
    utterance.onend = () => {
      speakingRef.current = false;
      speakNext();
    };
    utterance.onerror = () => {
      speakingRef.current = false;
      speakNext();
    };
    window.speechSynthesis.speak(utterance);
  };

  const queueSpeech = (text: string) => {
    const clean = text.trim();
    if (!clean || !window.speechSynthesis) return;
    speechQueueRef.current.push(clean);
    speakNext();
  };

  const streamReply = async (text: string) => {
    thinkingRef.current = true;
    setStatus("thinking");
    setResponse("");
    sentenceBufferRef.current = "";
    speechQueueRef.current = [];
    window.speechSynthesis?.cancel();
    speakingRef.current = false;
    recognitionRef.current?.stop();
    const res = await fetch("/api/v1/admin/garvex/live", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ prompt: text, history: historyRef.current.slice(-8) }),
    });
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
        const payload = JSON.parse(line.slice(5).trim()) as { type: string; text?: string; error?: string };
        if (payload.type === "delta" && payload.text) {
          full += payload.text;
          sentenceBufferRef.current += payload.text;
          setResponse(full);
          let match = sentenceBufferRef.current.match(/^([\s\S]*?[.!?。！？\n])\s*/);
          while (match) {
            const sentence = match[1];
            sentenceBufferRef.current = sentenceBufferRef.current.slice(match[0].length);
            queueSpeech(sentence);
            match = sentenceBufferRef.current.match(/^([\s\S]*?[.!?。！？\n])\s*/);
          }
        }
        if (payload.type === "error") throw new Error(payload.error ?? "Live voice failed");
      }
    }
    historyRef.current = [...historyRef.current, { role: "user", content: text }, { role: "assistant", content: full }].slice(-12);
    thinkingRef.current = false;
    if (sentenceBufferRef.current.trim()) {
      queueSpeech(sentenceBufferRef.current);
      sentenceBufferRef.current = "";
    }
    if (!speakingRef.current && speechQueueRef.current.length === 0 && activeRef.current) {
      setStatus("listening");
      try { recognitionRef.current?.start(); } catch {}
    }
  };

  const stop = () => {
    activeRef.current = false;
    thinkingRef.current = false;
    setActive(false);
    recognitionRef.current?.stop();
    speechQueueRef.current = [];
    window.speechSynthesis?.cancel();
    speakingRef.current = false;
    setStatus("off");
  };

  const start = () => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      setResponse("Live Voice يحتاج متصفحًا يدعم Speech Recognition مثل Chrome/Edge.");
      return;
    }
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
      if (finalText.trim()) {
        void streamReply(finalText.trim()).catch((error) => {
          thinkingRef.current = false;
          setResponse(error instanceof Error ? error.message : String(error));
          if (activeRef.current) {
            setStatus("listening");
            try { recognitionRef.current?.start(); } catch {}
          }
        });
      }
    };
    recognition.onend = () => {
      if (activeRef.current && !thinkingRef.current && !speakingRef.current) {
        try { recognition.start(); } catch {}
      }
    };
    recognition.onerror = () => {
      if (activeRef.current && !thinkingRef.current && !speakingRef.current) setStatus("listening");
    };
    recognitionRef.current = recognition;
    try { recognition.start(); } catch {}
  };

  return (
    <section className={`garvex-live-voice ${active ? "is-active" : ""}`} aria-label="Garvex Live Voice">
      <div className="garvex-live-voice-main">
        <button type="button" className="garvex-live-voice-button" onClick={active ? stop : start} aria-pressed={active}>
          <span className="garvex-live-voice-pulse" aria-hidden />
          <span>{active ? "Live Voice · On" : "Live Voice"}</span>
        </button>
        <span className="garvex-live-voice-status">{status === "listening" ? "Listening…" : status === "thinking" ? "Thinking…" : status === "speaking" ? "Speaking…" : "Ready"}</span>
      </div>
      {(transcript || response) ? <div className="garvex-live-voice-live" aria-live="polite"><span>{transcript}</span>{response ? <span>{response}</span> : null}</div> : null}
    </section>
  );
}
