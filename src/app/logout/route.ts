import { redirect } from "next/navigation";
import { endSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  await endSession();
  redirect("/login");
}

export async function POST() {
  await endSession();
  redirect("/login");
}
