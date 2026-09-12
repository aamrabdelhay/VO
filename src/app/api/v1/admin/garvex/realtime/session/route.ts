import { requirePlatformAdmin, assertCsrf } from "@/lib/auth";
import { getPlatformSecret } from "@/lib/platform-secrets";
import { ok, handle } from "@/lib/api";

export const dynamic = "force-dynamic";

const SESSION_TTL_SECONDS = 30 * 60;

function roomNameFor(userId: string) {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
  return `garvex-${safe}-${Date.now().toString(36)}`;
}

async function jsonFetch(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data?.error?.message ?? data?.message ?? `${url} failed (${response.status})`);
  }
  return data;
}

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);

    const pipecatKey = await getPlatformSecret("PIPECAT_CLOUD_API_KEY");
    const pipecatAgent = process.env.GARVEX_PIPECAT_AGENT?.trim();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + SESSION_TTL_SECONDS;

    if (pipecatKey && pipecatAgent) {
      const data = await jsonFetch(`https://api.pipecat.daily.co/v1/public/${encodeURIComponent(pipecatAgent)}/start`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${pipecatKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          createDailyRoom: true,
          dailyRoomProperties: {
            privacy: "private",
            exp,
            start_video_off: true,
            start_audio_off: false,
            max_participants: 2,
          },
          enableDefaultIceServers: true,
          transport: "daily",
          body: {
            userId: user.id,
            mode: "garvex-realtime",
          },
        }),
      });

      const dailyRoom = data?.dailyRoom ?? data?.room ?? {};
      const token = data?.dailyToken ?? data?.token;
      const roomUrl = data?.roomUrl ?? dailyRoom?.url;
      if (!roomUrl || !token) throw new Error("Pipecat Cloud did not return a Daily room URL and token.");
      return ok({
        roomUrl,
        token,
        sessionId: data?.sessionId ?? `garvex-${Date.now().toString(36)}`,
        agent: "pipecat-cloud",
        realtime: true,
      });
    }

    const externalAgentUrl = process.env.GARVEX_VOICE_AGENT_URL?.trim().replace(/\/$/, "");
    if (externalAgentUrl) {
      const data = await jsonFetch(`${externalAgentUrl}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          mode: "garvex-realtime",
          createDailyRoom: true,
          dailyRoomProperties: {
            privacy: "private",
            exp,
            start_video_off: true,
            start_audio_off: false,
            max_participants: 2,
          },
        }),
      });
      const token = data?.dailyToken ?? data?.token;
      const roomUrl = data?.roomUrl ?? data?.dailyRoom?.url ?? data?.room?.url;
      if (!roomUrl || !token) throw new Error("Realtime voice agent did not return a Daily room URL and token.");
      return ok({
        roomUrl,
        token,
        sessionId: data?.sessionId ?? `garvex-${Date.now().toString(36)}`,
        agent: "external-runner",
        realtime: true,
      });
    }

    const dailyKey = await getPlatformSecret("DAILY_API_KEY");
    if (!dailyKey) {
      throw new Error("Configure PIPECAT_CLOUD_API_KEY + GARVEX_PIPECAT_AGENT (recommended), GARVEX_VOICE_AGENT_URL, or DAILY_API_KEY for realtime voice.");
    }

    const roomName = roomNameFor(user.id);
    const room = await jsonFetch("https://api.daily.co/v1/rooms", {
      method: "POST",
      headers: {
        authorization: `Bearer ${dailyKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: roomName,
        privacy: "private",
        properties: {
          exp,
          start_video_off: true,
          start_audio_off: false,
          max_participants: 2,
        },
      }),
    });

    const token = await jsonFetch("https://api.daily.co/v1/meeting-tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${dailyKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          room_name: roomName,
          exp,
          eject_at_token_exp: true,
          user_name: "Garvex User",
          is_owner: false,
        },
      }),
    });

    return ok({
      roomUrl: room?.url,
      token: token?.token,
      sessionId: roomName,
      agent: "transport-only",
      realtime: false,
      warning: "Daily transport is ready, but no Garvex voice agent is attached. Configure Pipecat Cloud or GARVEX_VOICE_AGENT_URL for live AI audio.",
    });
  });
}
