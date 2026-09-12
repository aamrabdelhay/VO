import dns from "node:dns/promises";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { domains, projects } from "@/db/schema";
import { PLATFORM_DOMAIN, platformHost, publishRoutes } from "@/lib/router";
import { log } from "@/lib/logger";

const CNAME_TARGET = process.env.PLATFORM_CNAME_TARGET ?? `edge.${PLATFORM_DOMAIN}`;

export function dnsInstructions(domain: typeof domains.$inferSelect, projectSlug: string) {
  return {
    cname: { type: "CNAME", name: domain.domain, value: CNAME_TARGET },
    txt: {
      type: "TXT",
      name: `_platform-challenge.${domain.domain}`,
      value: domain.verificationToken ?? "",
    },
    alternative: { type: "CNAME", name: domain.domain, value: platformHost(projectSlug) },
  };
}

/**
 * Verifies domain ownership + routing, then moves the domain through its
 * lifecycle. Certificates are issued by Traefik's ACME resolver once the
 * router for the hostname is published.
 */
export async function verifyDomain(domainId: string) {
  const [record] = await db.select().from(domains).where(eq(domains.id, domainId)).limit(1);
  if (!record) return { ok: false, reason: "domain not found" };
  const [project] = await db.select().from(projects).where(eq(projects.id, record.projectId)).limit(1);
  if (!project) return { ok: false, reason: "project not found" };

  await db
    .update(domains)
    .set({ status: "DNS_VERIFICATION", lastCheckedAt: new Date(), updatedAt: new Date() })
    .where(eq(domains.id, domainId));

  let ownershipOk = false;
  let routingOk = false;
  let error: string | null = null;

  try {
    const txt = await dns
      .resolveTxt(`_platform-challenge.${record.domain}`)
      .catch(() => [] as string[][]);
    ownershipOk = txt.flat().some((v) => v.trim() === record.verificationToken);
  } catch (e) {
    error = String(e);
  }
  try {
    const cname = await dns.resolveCname(record.domain).catch(() => [] as string[]);
    routingOk = cname.some(
      (v) =>
        v.replace(/\.$/, "") === CNAME_TARGET || v.replace(/\.$/, "") === platformHost(project.slug),
    );
  } catch (e) {
    error = error ?? String(e);
  }

  if (!ownershipOk && !routingOk) {
    await db
      .update(domains)
      .set({
        status: "FAILED",
        lastError: error ?? "DNS records not found yet",
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(domains.id, domainId));
    return { ok: false, reason: "DNS verification failed" };
  }

  await db
    .update(domains)
    .set({ status: "CERTIFICATE_REQUESTED", lastError: null, updatedAt: new Date() })
    .where(eq(domains.id, domainId));
  await publishRoutes(); // Traefik requests the certificate for the new router

  await db
    .update(domains)
    .set({
      status: "ACTIVE",
      certificateStatus: "ISSUING",
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(domains.id, domainId));
  log.info("Domain activated", { projectId: project.id, domain: record.domain });
  return { ok: true };
}
