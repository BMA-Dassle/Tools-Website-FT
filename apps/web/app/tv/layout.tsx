import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { signageEnabled } from "~/features/signage/flags";
import "./tv.css";

/**
 * Lobby-TV surface. Chrome-free (middleware early-returns /tv the way it does
 * /kiosk), never indexed, and dark by default so a panel powering on shows the
 * canvas ground rather than a white flash.
 */
export const metadata: Metadata = {
  title: "FastTrax Signage",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function TvLayout({ children }: { children: React.ReactNode }) {
  // Kill switch. A dark 404 is the right failure mode for a wall panel — far
  // better than leaving a broken screen up in front of guests.
  if (!signageEnabled()) notFound();
  return <div style={{ background: "#000418", minHeight: "100vh" }}>{children}</div>;
}
