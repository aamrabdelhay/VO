"use client";

import { LiveKitRoom, RoomAudioRenderer, StartAudio, useConnectionState, useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import { useCallback, useEffect, useState } from "react";

type Connection = {
  token: string;
  serverUrl: string;
  roomName: string;
  identity: string;
  agentName: string;
};

function VoiceControls({ onClose }: { onClose: () => void }) {
  const room = useRoomContext();
  const state = useConnectionState();
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const [micError, setMicError] = useState<string | null>(null);

  useEffect(() => {
    if (state !== ConnectionState.Connected) return;
    let cancelled = false;
    void localParticipant.setMicrophoneEnabled(true).catch((error) => {
      if (!cancelled) setMicError(error instanceof Error ? error.message : "Microphone could not be enabled.");
    });
    return () => {
      cancelled = true;
    };
  }, [localParticipant, state]);

  const toggleMic = useCallback(async () => {
    setMicError(null);
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch (error) {
      setMicError(error instanceof Error ? error.message : "Microphone change failed.");
    }
  }, [isMicrophoneEnabled, localParticipant]);

  const disconnect = useCallback(() => {
    room.disconnect();
    onClose();
  }, [onClose, room]);

  const connected = state === ConnectionState.Connected;
  const connecting = state === ConnectionState.Connecting;

  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4 shadow-lg backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white">Garvex Live Voice</div>
          <div className="text-xs text-white/60">
            {connected ? "Live · WebRTC · interruption enabled" : connecting ? "Connecting…" : "Disconnected"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleMic}
            disabled={!connected}
            className="rounded-xl border border-white/10 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isMicrophoneEnabled ? "Mute" : "Unmute"}
          </button>
          <button
            type="button"
            onClick={disconnect}
            className="rounded-xl bg-white px-3 py-2 text-xs font-semibold text-black transition hover:bg-white/90"
          >
            End call
          </button>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[11px] text-white/50">
        <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : connecting ? "bg-amber-300" : "bg-white/20"}`} />
        {connected ? "Speak naturally — Garvex can be interrupted while speaking." : "Starting the realtime audio session."}
      </div>
      {micError ? <div className="mt-3 rounded-lg border border-red-400/20 bg-red-400/10 p-2 text-xs text-red-200">{micError}</div> : null}
      <RoomAudioRenderer />
      <StartAudio label="Enable audio" />
    </div>
  );
}

export function GarvexRealtimeVoice({ csrf }: { csrf: string }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (busy || connection) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/admin/garvex/realtime/token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ displayName: "Garvex Console" }),
      });
      const text = await response.text();
      let payload: { data?: Connection; error?: { message?: string } } = {};
      try {
        payload = text ? (JSON.parse(text) as typeof payload) : {};
      } catch {
        throw new Error(`Realtime token response was invalid (${response.status}).`);
      }
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? `Realtime voice failed (${response.status}).`);
      setConnection(payload.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Realtime voice could not start.");
    } finally {
      setBusy(false);
    }
  }, [busy, connection, csrf]);

  const close = useCallback(() => {
    setConnection(null);
  }, []);

  return (
    <section className="mb-5 rounded-3xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
      {!connection ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-semibold">Realtime voice</div>
            <div className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              Live microphone session over WebRTC with server-side Groq STT, Garvex realtime reasoning, streaming OpenRouter TTS, and barge-in interruption handling.
            </div>
          </div>
          <button
            type="button"
            onClick={start}
            disabled={busy}
            className="shrink-0 rounded-xl bg-white px-4 py-2.5 text-xs font-semibold text-black transition hover:bg-white/90 disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? "Starting…" : "Start live voice"}
          </button>
        </div>
      ) : (
        <LiveKitRoom
          token={connection.token}
          serverUrl={connection.serverUrl}
          connect
          audio
          video={false}
          onDisconnected={close}
          options={{ adaptiveStream: true, dynacast: true }}
        >
          <VoiceControls onClose={close} />
        </LiveKitRoom>
      )}
      {error ? <div className="mt-3 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-xs text-red-200">{error}</div> : null}
    </section>
  );
}
