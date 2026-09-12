# Garvex Realtime Voice Agent

This worker is the persistent realtime half of VO's Garvex voice experience. VO's Next.js app creates a short-lived private Daily room and the worker joins that room as Garvex.

## Flow

Browser microphone → Daily WebRTC → Silero VAD → Groq Whisper STT → Groq streaming LLM → Groq streaming TTS → Daily audio → browser.

`PipelineParams.allow_interruptions=True` enables pipeline interruption handling, so a new user turn can interrupt Garvex while it is speaking. Pipecat's current Groq STT service uses Whisper-style VAD-segmented transcription rather than true interim streaming STT; the transport and turn pipeline are realtime, while interim transcript events require a streaming STT provider such as Deepgram.

## Required secrets

Set `GROQ_API_KEY` in the worker runtime. Configure one of these on VO:

- `PIPECAT_CLOUD_API_KEY` + `GARVEX_PIPECAT_AGENT` (recommended hosted deployment)
- `GARVEX_VOICE_AGENT_URL` pointing at a compatible runner endpoint
- `DAILY_API_KEY` for creating Daily rooms directly (transport-only until an agent is attached)

## Model defaults

`GARVEX_REALTIME_LLM_MODEL` defaults to `openai/gpt-oss-120b`, matching the Groq streaming example used by VO.

The worker uses Pipecat's `GroqTTSService` for low-latency streaming playback. VO's existing OpenRouter TTS endpoint remains available for non-realtime voice turns and can be replaced with a custom raw-audio service later if OpenRouter is required as the realtime TTS provider.

## Run locally

Install Python 3.12+ dependencies:

```bash
pip install -r requirements.txt
```

Then run:

```bash
python bot.py -t daily
```

For a hosted runner, use the same `bot(runner_args)` entry point with the Pipecat/Daily runtime.
