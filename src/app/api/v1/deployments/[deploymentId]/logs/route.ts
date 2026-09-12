import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments } from "@/db/schema";
import { handle, ok } from "@/lib/api";
import { HttpError, requireProjectAccess } from "@/lib/auth";
import { readLiveLogs, subscribe } from "@/lib/deployment-logs";
import { storage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ deploymentId: string }> }) {
  const { deploymentId } = await ctx.params;
  const url = new URL(request.url);

  if (url.searchParams.get("stream") === "1") {
    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1);
    if (!deployment) return new Response("not found", { status: 404 });
    await requireProjectAccess(deployment.projectId);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const initial = await readLiveLogs(deploymentId);
        for (const chunk of initial) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk.content)}\n\n`));
        }
        const unsubscribe = subscribe(deploymentId, (line) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
        });
        const keepAlive = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 15000);
        request.signal.addEventListener("abort", () => {
          clearInterval(keepAlive);
          unsubscribe();
          controller.close();
        });
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  return handle(async () => {
    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1);
    if (!deployment) throw new HttpError(404, "Deployment not found");
    await requireProjectAccess(deployment.projectId);

    if (url.searchParams.get("durable") === "1") {
      const buf = await storage.get(`logs/${deployment.projectId}/${deploymentId}.log`);
      return new Response(buf ? buf.toString("utf8") : "no durable log retained", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const chunks = await readLiveLogs(deploymentId, Number(url.searchParams.get("after") ?? 0));
    return ok({ chunks });
  });
}
