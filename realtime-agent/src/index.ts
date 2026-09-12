import { Agent, AgentSession, AgentSessionEventTypes, ServerOptions, cli, defineAgent, log } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const agent = new Agent({
  instructions: [
    "You are Garvex, the realtime voice assistant inside the VO deployment platform.",
    "Speak naturally, clearly, and concisely. Prefer short spoken sentences.",
    "The voice channel is read-only. Never claim you changed code, deployed a site, edited a project, or performed an external action unless a separate tool actually completed it.",
    "For build, fix, deploy, or mutation requests, tell the user to use the explicit Build & Fix workflow in the Garvex console.",
    "Do not reveal hidden reasoning, private chain-of-thought, API keys, credentials, or internal secrets.",
  ].join("\n"),
});

function makeTts() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required by the realtime agent.");

  return new openai.TTS({
    apiKey,
    baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    model: process.env.GARVEX_REALTIME_TTS_MODEL || "deepgram/flux-tts:free",
    voice: process.env.GARVEX_REALTIME_TTS_VOICE || "flux-alexis-en",
  });
}

export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect();

    const stt = openai.STT.withGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GARVEX_REALTIME_STT_MODEL || "whisper-large-v3-turbo",
    });

    const llm = openai.LLM.withGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GARVEX_REALTIME_LLM_MODEL || "openai/gpt-oss-120b",
      temperature: 0.1,
    });

    const session = new AgentSession({
      stt,
      llm,
      tts: makeTts(),
      turnHandling: {
        interruption: {
          resumeFalseInterruption: true,
          falseInterruptionTimeout: 1000,
          mode: "adaptive",
        },
        endpointing: {
          mode: "dynamic",
          minDelay: 250,
          maxDelay: 1800,
        },
      },
      preemptiveGeneration: {
        enabled: true,
      },
    });

    session.on(AgentSessionEventTypes.Error, (event) => {
      log.error({ error: event.error }, "Garvex realtime session error");
    });

    session.on(AgentSessionEventTypes.UserInputTranscribed, (event) => {
      log.debug({ text: event.transcript, final: event.isFinal }, "Garvex STT");
    });

    session.on(AgentSessionEventTypes.OverlappingSpeech, () => {
      log.debug("Garvex interruption detected; active speech will be interrupted");
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        audioEnabled: true,
      },
    });

    await session.say("أهلاً، أنا Garvex. أنا معاك دلوقتي لايف.", { allowInterruptions: true });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
