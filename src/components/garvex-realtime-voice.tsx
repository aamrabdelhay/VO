"use client";

import { useCallback, useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    DailyIframe?: {
      createCallObject: (options?: Record<string, unknown>) => DailyCall;
    };
  }
}

type DailyCall = {
  join: (options: Record<string, unknown>) => Promise<unknown>;
  leave: () => Promise<unknown>;
  destroy: () => void;
  setLocalAudio: (enabled: boolean) => Promise<unknown>;
  setLocalVideo: (enabled: boolean) => Promise<unknown>;
  on: (event: string, handler: (event?: any) => void) => DailyCall;
  off: (event: string, handler: (event?: any) => void) => DailyCall;
};

type VoiceState = "idle" | "connecting" | "listening" | "speaking" | "error";

const DAILY_SCRIPT = "https://unpkg.com/@daily-co/daily-js@0.81.0";

function loadDaily(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("Daily can only load in a browser."));
  if (window.DailyIframe) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>("script[data-vo-daily]");
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Could not load Daily WebRTC client.")), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = DAILY_SCRIPT;
    script.async = true;
    script.dataset.voDaily = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Daily WebRTC client."));
    document.head.appendChild(script);
  });
}

function labelForState(state: VoiceState) {
  switch (state) {
    case "connecting": return "Connecting to Garvex…";
    case "listening": return "Listening";
    case "speaking": return "Garvex is speaking";
    case "error": return "Voice unavailable";
    default: return "Live voice";
  }
}

export function GarvexRealtimeVoice({ csrf }: { csrf: string }) {
  const callRef = useRef<DailyCall | null>(null);
  const audioElsRef = useRef<HTMLAudioElement[]>([]);
  const [state, setState] = useState<VoiceState>("idle");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const cleanupAudio = useCallback(() => {
    for (const audio of audioElsRef.current) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    }
    audioElsRef.current = [];
  }, []);

  const stop = useCallback(async () => {
    cleanupAudio();
    const call = callRef.current;
    callRef.current = null;
    if (call) {
      try { await call.leave(); } catch { /* room may already be gone */ }
      call.destroy();
    }
    setMuted(false);
    setSessionId(null);
    setWarning(null);
    setState("idle");
  }, [cleanupAudio]);

  useEffect(() => () => { void stop(); }, [stop]);

  const start = useCallback(async () => {
    if (callRef.current || state === "connecting") return;
    setError(null);
    setWarning(null);
    setState("connecting");

    try {
      await loadDaily();
      const response = await fetch("/api/v1/admin/garvex/realtime/session", {
        method: "POST",
        headers: { "x-csrf-token": csrf },
      });
      const text = await response.text();
      let payload: any = null;
      try { payload = text ? JSON.parse(text) : null; } catch { throw new Error(`Invalid realtime session response (${response.status}).`); }
      if (!response.ok) throw new Error(payload?.error?.message ?? `Realtime session failed (${response.status}).`);

      const session = payload?.data ?? {};
      if (!session.roomUrl || !session.token) throw new Error("Realtime session did not return a Daily room.");
      setSessionId(session.sessionId ?? null);
      if (session.warning) setWarning(String(session.warning));

      if (!window.DailyIframe) throw new Error("Daily WebRTC client is not available.");
      const call = window.DailyIframe.createCallObject({ subscribeToTracksAutomatically: true });
      callRef.current = call;

      const onJoined = () => setState("listening");
      const onLeft = () => { void stop(); };
      const onError = (event?: any) => {
        const message = event?.errorMsg || event?.error?.message || "Daily WebRTC error.";
        setError(String(message));
        setState("error");
      };
      const onTrackStarted = (event?: any) => {
        const track: MediaStreamTrack | undefined = event?.track;
        const participant = event?.participant;
        if (!track || track.kind !== "audio" || participant?.local) return;
        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.playsInline = true;
        audio.setAttribute("aria-hidden", "true");
        audio.srcObject = new MediaStream([track]);
        document.body.appendChild(audio);
        audioElsRef.current.push(audio);
        void audio.play().catch(() => {
          setError("اضغط زر الصوت مرة أخرى للسماح بتشغيل صوت Garvex في المتصفح.");
        });
      };
      const onRemoteAudioLevel = (event?: any) => {
        const level = Number(event?.audioLevel ?? event?.level ?? 0);
        if (level > 0.08 && state !== "connecting") setState("speaking");
        else if (state === "speaking") setState("listening");
      };

      call.on("joined-meeting", onJoined);
      call.on("left-meeting", onLeft);
      call.on("error", onError);
      call.on("track-started", onTrackStarted);
      call.on("remote-participants-audio-level", onRemoteAudioLevel);

      await call.join({ url: session.roomUrl, token: session.token, startVideoOff: true });
      await call.setLocalVideo(false);
      await call.setLocalAudio(true);
      setMuted(false);
    } catch (cause) {
      await stop();
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setState("error");
    }
  }, [csrf, state, stop]);

  const toggleMute = useCallback(async () => {
    const call = callRef.current;
    if (!call) return;
    try {
      const next = !muted;
      await call.setLocalAudio(!next);
      setMuted(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [muted]);

  const active = state === "connecting" || state === "listening" || state === "speaking";

  return (
    <section className="mb-5 rounded-2xl border bg-black/20 p-4 shadow-sm" aria-label="Garvex live voice">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <div className={`relative grid h-16 w-16 shrink-0 place-items-center rounded-full border transition ${active ? "garvex-voice-orb-active" : ""}`}>
            <span className="absolute inset-1 rounded-full border border-sky-400/30" />
            <span className="absolute inset-2 rounded-full border border-indigo-400/20" />
            <span className={`h-5 w-5 rounded-full bg-sky-400 shadow-[0_0_28px_rgba(56,189,248,.8)] ${state === "speaking" ? "animate-pulse" : ""}`} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <strong>Garvex Live Voice</strong>
              <span className="rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-widest">WebRTC</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{labelForState(state)} · speak naturally; interruptions are supported by the realtime pipeline.</p>
            {sessionId ? <p className="mt-1 truncate text-[10px] text-muted-foreground">Session {sessionId}</p> : null}
            {warning ? <p className="mt-2 text-[11px] text-amber-300">{warning}</p> : null}
            {error ? <p className="mt-2 text-[11px] text-red-300">{error}</p> : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {active ? <>
            <button className="btn" type="button" onClick={() => void toggleMute()}>{muted ? "Unmute" : "Mute"}</button>
            <button className="btn" type="button" onClick={() => void stop()}>End call</button>
          </> : <button className="btn" type="button" onClick={() => void start()}>Start live voice</button>}
        </div>
      </div>
    </section>
  );
}
