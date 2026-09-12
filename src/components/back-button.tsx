"use client";

import { usePathname, useRouter } from "next/navigation";

export function BackButton() {
  const pathname = usePathname();
  const router = useRouter();
  if (pathname === "/") return null;
  return (
    <button
      type="button"
      aria-label="Go back"
      title="Back"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push("/");
      }}
      className="fixed left-3 top-3 z-[100] inline-flex h-8 items-center gap-1.5 rounded-full border bg-black/70 px-3 text-[11px] font-medium text-white shadow-lg backdrop-blur-md transition hover:bg-black/90"
    >
      <span aria-hidden>←</span>
      <span>Back</span>
    </button>
  );
}
