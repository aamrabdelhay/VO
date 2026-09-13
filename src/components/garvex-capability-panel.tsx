"use client";

import { useEffect, useMemo, useState } from "react";

type CapabilityProvider = { provider: string; model: string; available: boolean; state: "ready" | "fallback" | "unavailable"; reason?: string };
type CapabilityPlan = { capability: string; primary: CapabilityProvider; fallbacks: CapabilityProvider[] };
type RuntimeState = "idle" | "loading" | "streaming" | "success" | "error";

const labels: Record<string, { title: string; subtitle: string }> = {
  text: { title: "Text & reasoning", subtitle: "Chat, coding, architecture" },
  "audio-transcription": { title: "Speech to text", subtitle: "Voice transcription" },
  "multimodal-understanding": { title: "Image · audio · video", subtitle: "Omni understanding" },
  "image-generation": { title: "Image generation", subtitle: "Prompt to image" },
  "image-edit": { title: "Image editing", subtitle: "Transform an input image" },
  "document-parse": { title: "Document analysis", subtitle: "PDFs & complex reports" },
  "video-generation": { title: "Video generation", subtitle: "Prompt to motion" },
  "voice-realtime": { title: "Realtime voice", subtitle: "Full-duplex voice" },
};

function dot(state: RuntimeState) {
  if (state === "error") return "●";
  if (state === "success") return "●";
  if (state === "streaming") return "◉";
  if (state === "loading") return "◌";
  return "○";
}

export function GarvexCapabilityPanel({ capabilities }: { capabilities: CapabilityPlan[] }) {
  const [runtime, setRuntime] = useState<Record<string, RuntimeState>>({});
  const byCapability = useMemo(() => new Map(capabilities.map((item) => [item.capability, item])), [capabilities]);

  useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<{ capability?: string; state?: RuntimeState }>).detail;
      if (!detail?.capability || !detail.state) return;
      setRuntime((current) => ({ ...current, [detail.capability]: detail.state! }));
    };
    window.addEventListener("garvex:capability", handle);
    return () => window.removeEventListener("garvex:capability", handle);
  }, []);

  return (
    <section className="garvex-capability-panel" aria-label="Garvex capabilities">
      <div className="garvex-capability-head">
        <div>
          <div className="garvex-capability-kicker">MODEL ROUTING</div>
          <h2>What should Garvex do?</h2>
        </div>
        <div className="garvex-capability-legend"><span>Primary</span><span>Fallback</span><span>Unavailable</span></div>
      </div>
      <div className="garvex-capability-grid">
        {Object.keys(labels).map((key) => {
          const plan = byCapability.get(key);
          if (!plan) return null;
          const meta = labels[key];
          const state = runtime[key] ?? "idle";
          const status = plan.primary.available ? (plan.primary.state === "fallback" ? "fallback" : "ready") : "unavailable";
          const fallback = plan.fallbacks.find((candidate) => candidate.available);
          return (
            <article key={key} className="garvex-capability-card">
              <div className="garvex-capability-row">
                <div>
                  <strong>{meta.title}</strong>
                  <span>{meta.subtitle}</span>
                </div>
                <span className={`garvex-capability-status ${status}`}>{status.toUpperCase()}</span>
              </div>
              <div className="garvex-capability-engine"><small>NOW</small><b>{plan.primary.provider}</b><code>{plan.primary.model}</code></div>
              <div className="garvex-capability-runtime"><span className={`runtime-dot ${state}`} aria-hidden>{dot(state)}</span><span>{state === "idle" ? "Idle" : state === "loading" ? "Loading" : state === "streaming" ? "Streaming" : state === "success" ? "Ready" : "Error"}</span></div>
              {fallback ? <div className="garvex-capability-fallback"><span>Fallback</span><code>{fallback.provider} · {fallback.model}</code></div> : null}
              {!plan.primary.available && plan.primary.reason ? <p className="garvex-capability-note">{plan.primary.reason}</p> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
