# Garvex Realtime Voice Agent

This worker is the persistent realtime sidecar for Garvex. The browser connects to LiveKit over WebRTC; this worker joins the same room and runs the voice pipeline:

`WebRTC → VAD / turn detection → Groq Whisper STT → Groq streaming LLM → OpenRouter streaming TTS → WebRTC`

Interruption/barge-in is handled by LiveKit Agents turn handling. The worker keeps provider credentials server-side.

## Required environment

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `GROQ_API_KEY`
- `OPENROUTER_API_KEY`

Optional tuning variables are documented in `.env.example`.

## Local run

```bash
npm install
npm run dev
```

The LiveKit Agents CLI starts the worker in development mode and waits for jobs dispatched to `GARVEX_REALTIME_AGENT_NAME`.

## VO configuration

In VO → Settings, store these platform secrets for the browser-side token endpoint:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

The agent runtime must separately receive the LiveKit and provider secrets above. Never move these keys into client components or public environment variables.

## Voice behavior

The realtime lane is intentionally optimized for low latency. It uses the fast Groq model directly instead of the full multi-agent Garvex Council on every audio token. The existing Council remains the read-only / Build & Fix / Research reasoning layer in VO, while realtime voice uses streaming and interruption-aware execution.

Build, fix, deploy, GitHub write, and other mutations are not exposed as automatic voice actions. The user must explicitly use the Build & Fix workflow in the VO UI.
