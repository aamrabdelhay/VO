import { AccessToken } from "livekit-server-sdk";
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol";
import { assertCsrf, requirePlatformAdmin } from "@/lib/auth";
import { getPlatformSecret } from "@/lib/platform-secrets";
import { handle, ok } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeServerUrl(value: string) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  return trimmed;
}

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);

    const body = (await request.json().catch(() => ({}))) as { displayName?: string };
    const apiKey = await getPlatformSecret("LIVEKIT_API_KEY");
    const apiSecret = await getPlatformSecret("LIVEKIT_API_SECRET");
    const configuredUrl = await getPlatformSecret("LIVEKIT_URL");

    if (!apiKey || !apiSecret || !configuredUrl) {
      throw new Error("LiveKit is not configured. Add LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in VO → Settings.");
    }

    const roomName = `garvex-${crypto.randomUUID()}`;
    const identity = `garvex-user-${crypto.randomUUID()}`;
    const name = String(body.displayName ?? "Garvex User").trim().slice(0, 80) || "Garvex User";
    const agentName = process.env.GARVEX_REALTIME_AGENT_NAME || "garvex-realtime";

    const token = new AccessToken(apiKey, apiSecret, { identity, name });
    token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    token.roomConfig = new RoomConfiguration({
      agents: [new RoomAgentDispatch({ agentName })],
    });

    return ok({
      token: await token.toJwt(),
      serverUrl: normalizeServerUrl(configuredUrl),
      roomName,
      identity,
      agentName,
    });
  });
}
