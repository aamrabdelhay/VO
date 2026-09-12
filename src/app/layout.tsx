import type { Metadata } from "next";
import type { ReactNode } from "react";
import { BackButton } from "@/components/back-button";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deployment Platform",
  description: "Self-hosted GitHub-to-production deployment control plane.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <BackButton />
        {children}
      </body>
    </html>
  );
}
