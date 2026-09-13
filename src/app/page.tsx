import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function IndexPage() {
  const user = await getSessionUser();
  redirect(user ? "/admin/garvex" : "/login");
}
