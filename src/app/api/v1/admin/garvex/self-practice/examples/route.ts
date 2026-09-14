import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  await requirePlatformAdmin();
  const result = await db.execute(sql`select id, project_id as "projectId", source, problem_description as "problemDescription", diff, validation_output as "validationOutput", verified, created_at as "createdAt" from self_practice_examples where verified = true order by created_at desc limit 10`);
  return NextResponse.json({ examples: result.rows ?? [] });
}
