import { resolveProjectRoute } from "@/lib/router";

export const dynamic = "force-dynamic";

/**
 * Built-in fallback edge.
 *
 * In a full installation Traefik terminates TLS and routes hostnames straight
 * to runtime containers, so production traffic never traverses the control
 * plane. This route exists for single-host installs where no external proxy is
 * configured yet, and for the dashboard "Open app" link.
 */
async function proxy(request: Request, slug: string, parts: string[]) {
  const route = await resolveProjectRoute(slug);
  if (!route) {
    return new Response("No healthy deployment is currently serving this project.", {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
  }
  const incoming = new URL(request.url);
  const target = `http://127.0.0.1:${route.port}/${parts.join("/")}${incoming.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cookie");
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));

  try {
    const res = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: "manual",
    });
    const responseHeaders = new Headers(res.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    return new Response(res.body, { status: res.status, headers: responseHeaders });
  } catch (error) {
    return new Response(`Runtime unreachable: ${String(error)}`, { status: 502 });
  }
}

type Ctx = { params: Promise<{ slug: string; path?: string[] }> };

export async function GET(request: Request, ctx: Ctx) {
  const { slug, path } = await ctx.params;
  return proxy(request, slug, path ?? []);
}
export async function POST(request: Request, ctx: Ctx) {
  const { slug, path } = await ctx.params;
  return proxy(request, slug, path ?? []);
}
export async function PUT(request: Request, ctx: Ctx) {
  const { slug, path } = await ctx.params;
  return proxy(request, slug, path ?? []);
}
export async function DELETE(request: Request, ctx: Ctx) {
  const { slug, path } = await ctx.params;
  return proxy(request, slug, path ?? []);
}
