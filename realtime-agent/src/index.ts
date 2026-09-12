import { Agent, AgentSession, ServerOptions, cli, defineAgent, inference } from "@livekit/agents";
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

export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect();

    const groqKey = process.env.GROQ_API_KEY;
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (!groqKey) throw new Error("GROQ_API_KEY is required by the realtime agent.");
    if (!openRouterKey) throw new Error("OPENROUTER_API_KEY is required by the realtime agent.");

    const session = new AgentSession({
      stt: openai.STT.withGroq({
        apiKey: groqKey,
        model: process.env.GARVEX_REALTIME_STT_MODEL || "whisper-large-v3-turbo",
      }),
      llm: openai.LLM.withGroq({
        apiKey: groqKey,
        model: process.env.GARVEX_REALTIME_LLM_MODEL || "openai/gpt-oss-120b",
        temperature: 0.1,
      }),
      tts: new openai.TTS({
        apiKey: openRouterKey,
        baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
        model: process.env.GARVEX_REALTIME_TTS_MODEL || "deepgram/flux-tts:free",
        voice: process.env.GARVEX_REALTIME_TTS_VOICE || "flux-alexis-en",
      }),
      turnHandling: {
        turnDetection: new inference.TurnDetector(),
        endpointing: {
          minDelay: 250,
          maxDelay: 1800,
        },
        interruption: {
          mode: "adaptive",
          minDuration: 350,
          minWords: 0,
          resumeFalseInterruption: true,
          falseInterruptionTimeout: 1200,
        },
        preemptiveGeneration: {
          enabled: true,
          preemptiveTts: true,
          maxSpeechDuration: 10000,
          maxRetries: 3,
        },
      },
      ttsTextTransforms: ["filter_markdown", "filter_emoji"],
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        audioEnabled: true,
      },
    });

    await session.generateReply({
      instructions: "Greet the user briefly in English, then invite them to speak.",
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.GARVEX_REALTIME_AGENT_NAME || "garvex-realtime",
  }),
);
