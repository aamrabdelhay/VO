import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { containerInstances, deployments, domains, projects } from "@/db/schema";
import { log } from "@/lib/logger";

export const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "apps.localhost";
const TRAEFIK_DYNAMIC_DIR =
  process.env.TRAEFIK_DYNAMIC_DIR ?? path.join(process.cwd(), "infrastructure", "traefik", "dynamic");

export type Route = {
  host: string;
  projectId: string;
  deploymentId: string;
  port: number;
  kind: "platform" | "preview" | "custom";
};

export function platformHost(slug: string) {
  return `${slug}.${PLATFORM_DOMAIN}`;
}

export function deploymentHost(deploymentId: string, slug: string) {
  return `${deploymentId.slice(0, 8)}.${slug}.${PLATFORM_DOMAIN}`;
}

export function previewHost(slug: string, prNumber: number | null, branch: string) {
  const label = prNumber ? `pr-${prNumber}` : branch.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return `${label}.${slug}.${PLATFORM_DOMAIN}`;
}

/** Builds the live routing table from observed data-plane state. */
export async function computeRoutes(): Promise<Route[]> {
  const rows = await db
    .select({
      project: projects,
      deployment: deployments,
      container: containerInstances,
    })
    .from(deployments)
    .innerJoin(projects, eq(projects.id, deployments.projectId))
    .innerJoin(
      containerInstances,
      and(
        eq(containerInstances.deploymentId, deployments.id),
        eq(containerInstances.status, "running"),
      ),
    )
    .where(inArray(deployments.status, ["PROMOTED", "HEALTHY", "PROMOTING"]));

  const routes: Route[] = [];
  const customs = await db.select().from(domains).where(eq(domains.status, "ACTIVE"));

  for (const row of rows) {
    const isProduction =
      row.deployment.target === "PRODUCTION" &&
      row.project.currentHealthyDeploymentId === row.deployment.id;
    if (isProduction) {
      routes.push({
        host: platformHost(row.project.slug),
        projectId: row.project.id,
        deploymentId: row.deployment.id,
        port: row.container.port,
        kind: "platform",
      });
      for (const custom of customs.filter((c) => c.projectId === row.project.id)) {
        routes.push({
          host: custom.domain,
          projectId: row.project.id,
          deploymentId: row.deployment.id,
          port: row.container.port,
          kind: "custom",
        });
      }
    }
    if (row.deployment.target === "PREVIEW") {
      routes.push({
        host: previewHost(row.project.slug, row.deployment.prNumber, row.deployment.branch),
        projectId: row.project.id,
        deploymentId: row.deployment.id,
        port: row.container.port,
        kind: "preview",
      });
    }
    routes.push({
      host: deploymentHost(row.deployment.id, row.project.slug),
      projectId: row.project.id,
      deploymentId: row.deployment.id,
      port: row.container.port,
      kind: "platform",
    });
  }
  return routes;
}

/**
 * Publishes the routing table to Traefik's file provider. Traefik watches this
 * directory, so traffic keeps flowing even if the control plane is down.
 */
export async function publishRoutes() {
  const routes = await computeRoutes();
  const http: {
    routers: Record<string, unknown>;
    services: Record<string, unknown>;
  } = { routers: {}, services: {} };

  routes.forEach((route, i) => {
    const name = `r${i}-${route.deploymentId.slice(0, 8)}`;
    http.routers[name] = {
      rule: `Host(\`${route.host}\`)`,
      service: name,
      entryPoints: ["websecure", "web"],
      tls: { certResolver: process.env.TRAEFIK_CERT_RESOLVER ?? "letsencrypt" },
    };
    http.services[name] = {
      loadBalancer: {
        servers: [{ url: `http://${process.env.RUNTIME_HOST ?? "127.0.0.1"}:${route.port}` }],
      },
    };
  });

  try {
    await fs.mkdir(TRAEFIK_DYNAMIC_DIR, { recursive: true });
    await fs.writeFile(
      path.join(TRAEFIK_DYNAMIC_DIR, "platform.json"),
      JSON.stringify({ http }, null, 2),
    );
  } catch (error) {
    log.warn("Could not publish Traefik dynamic configuration", { error: String(error) });
  }
  return routes;
}

/** Resolve the runtime target for a host; used by the built-in edge proxy. */
export async function resolveRoute(host: string): Promise<Route | null> {
  const routes = await computeRoutes();
  const normalized = host.split(":")[0].toLowerCase();
  return routes.find((r) => r.host.toLowerCase() === normalized) ?? null;
}

export async function resolveProjectRoute(slug: string): Promise<Route | null> {
  const routes = await computeRoutes();
  return routes.find((r) => r.host === platformHost(slug)) ?? null;
}

export async function resolveDeploymentRoute(deploymentId: string): Promise<Route | null> {
  const routes = await computeRoutes();
  return routes.find((r) => r.deploymentId === deploymentId) ?? null;
}
