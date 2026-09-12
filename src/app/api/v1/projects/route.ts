import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments, projects } from "@/db/schema";
import { handle, ok, readJson, requireFields } from "@/lib/api";
import { assertCsrf, HttpError, orgRole, primaryOrg, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { encryptSecret, randomToken } from "@/lib/crypto";
import { getRepo } from "@/lib/github";
import { installationToken } from "@/lib/github-auth";
import { normalizeFreeDomain } from "@/lib/vercel-hosting";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const user = await requireUser();
    const membership = await primaryOrg(user.id);
    if (!membership) return ok({ projects: [] });
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.orgId, membership.org.id))
      .orderBy(desc(projects.updatedAt));
    const enriched = await Promise.all(
      rows.map(async (project) => {
        const [latest] = await db
          .select()
          .from(deployments)
          .where(eq(deployments.projectId, project.id))
          .orderBy(desc(deployments.queuedAt))
          .limit(1);
        return { project, latestDeployment: latest ?? null };
      }),
    );
    return ok({ projects: enriched });
  });
}

type CreateBody = {
  name: string;
  repoFullName: string;
  freeDomain?: string;
  productionBranch?: string;
  rootDirectory?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  testCommand?: string;
  healthPath?: string;
};

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    await assertCsrf(user);
    const membership = await primaryOrg(user.id);
    if (!membership) throw new HttpError(400, "No organization membership");
    const role = await orgRole(user.id, membership.org.id);
    if (role !== "OWNER" && role !== "ADMIN" && role !== "DEVELOPER") {
      throw new HttpError(403, "Requires DEVELOPER role");
    }

    const body = await readJson<CreateBody>(request);
    requireFields(body, ["name", "repoFullName"]);

    const token = await installationToken(membership.org.id);
    const repo = await getRepo(body.repoFullName, token);

    const slug = `${body.name}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    const uniqueSlug = `${slug || "project"}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    const freeDomain = normalizeFreeDomain(body.freeDomain || body.name, uniqueSlug).slice(0, 63);

    const [project] = await db
      .insert(projects)
      .values({
        orgId: membership.org.id,
        name: body.name,
        slug: uniqueSlug,
        freeDomain,
        repoFullName: repo.full_name,
        repoUrl: repo.html_url,
        productionBranch: body.productionBranch || repo.default_branch || "main",
        rootDirectory: body.rootDirectory || ".",
        installCommand: body.installCommand || null,
        buildCommand: body.buildCommand || null,
        startCommand: body.startCommand || null,
        testCommand: body.testCommand || null,
        healthPath: body.healthPath || "/",
        webhookSecretCipher: encryptSecret(randomToken(24)) as unknown as object,
        createdBy: user.id,
      })
      .returning();

    await audit({
      orgId: membership.org.id,
      projectId: project.id,
      actorId: user.id,
      action: "project.created",
      resourceType: "project",
      resourceId: project.id,
      newState: { repo: repo.full_name, branch: project.productionBranch, freeDomain },
    });
    return ok({ project });
  });
}