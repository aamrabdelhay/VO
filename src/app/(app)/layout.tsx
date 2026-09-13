import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { notifications, projects } from "@/db/schema";
import { getSessionUser, primaryOrg } from "@/lib/auth";
import "../motion.css";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/admin/garvex", label: "Garvex" },
  { href: "/dashboard", label: "Overview" },
  { href: "/projects", label: "Projects" },
  { href: "/storage", label: "Storage" },
  { href: "/admin", label: "Administration" },
  { href: "/admin/settings", label: "Settings" },
];

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const membership = await primaryOrg(user.id);
  const projectList = membership ? await db.select({ id: projects.id, name: projects.name, slug: projects.slug }).from(projects).where(eq(projects.orgId, membership.org.id)).orderBy(desc(projects.updatedAt)).limit(12) : [];
  const alerts = membership ? await db.select().from(notifications).where(eq(notifications.orgId, membership.org.id)).orderBy(desc(notifications.createdAt)).limit(5) : [];
  return (
    <div className="flex min-h-screen vo-app-shell">
      <aside className="hidden w-[216px] shrink-0 flex-col border-r px-3 py-4 md:flex" style={{ background: "var(--color-bg-subtle)" }}>
        <Link href="/admin/garvex" className="mb-5 flex items-center gap-2 px-1"><span aria-hidden style={{ width: 13, height: 13, background: "#fafafa", borderRadius: 3, display: "block" }} /><span className="text-[12.5px] font-semibold">Garvex · VO</span></Link>
        <nav className="flex flex-col gap-0.5" aria-label="Primary">{NAV.map((item) => <Link key={item.href} href={item.href} className="nav-link">{item.label}</Link>)}</nav>
        <div className="mt-6 px-2 text-[10.5px] uppercase tracking-[0.06em]" style={{ color: "var(--color-fg-muted)" }}>Projects</div>
        <nav className="mt-1.5 flex flex-col gap-0.5" aria-label="Projects">{projectList.map((p) => <Link key={p.id} href={`/projects/${p.id}`} className="nav-link truncate">{p.name}</Link>)}<Link href="/projects/new" className="nav-link" style={{ color: "var(--color-fg-muted)" }}>+ New project</Link></nav>
        <div className="mt-auto border-t pt-3"><div className="px-2 text-[11px]" style={{ color: "var(--color-fg-secondary)" }}>{user.email}</div><div className="px-2 text-[10.5px]" style={{ color: "var(--color-fg-muted)" }}>{membership?.role ?? "no membership"}{user.isPlatformAdmin ? " · platform admin" : ""}</div><form action="/logout" method="post" className="mt-2 px-1"><a className="nav-link" href="/logout">Sign out</a></form></div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b px-5 py-2.5 md:hidden"><Link href="/admin/garvex" className="text-[12.5px] font-semibold">Garvex</Link><Link href="/projects" className="nav-link">Projects</Link><Link href="/dashboard" className="nav-link">Overview</Link><Link href="/admin" className="nav-link">Admin</Link><Link href="/admin/settings" className="nav-link">Settings</Link></header>
        {alerts.some((a) => a.severity === "error") ? <div className="border-b px-5 py-2 text-[11.5px]" style={{ background: "rgba(248,81,73,0.07)", color: "#ffb4ae" }}>{alerts.find((a) => a.severity === "error")?.title}</div> : null}
        <main className="min-w-0 flex-1 px-5 py-5 vo-scroll-stage">{children}</main>
      </div>
    </div>
  );
}
