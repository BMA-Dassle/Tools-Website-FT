import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { QueryProvider } from "~/context/QueryProvider";
import { kioskEnabled } from "~/features/kiosk/flags";
import { KioskShell } from "~/features/kiosk/components/KioskShell";
import "./kiosk.css";

/**
 * /kiosk — in-center self-service booking kiosk (portrait touchscreen).
 *
 * Chrome-free by middleware (x-kiosk / x-no-chrome strip Nav, Footer,
 * MiniCarts, chat, analytics). Kill switch: NEXT_PUBLIC_KIOSK_ENABLED=false
 * in Vercel 404s every kiosk route at the layout gate.
 *
 * React Query is scoped here exactly like /book/v2 — the kiosk reuses the
 * booking feature's hooks/services, the rest of the site pays zero cost.
 */

export const metadata: Metadata = {
  title: "Kiosk",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function KioskLayout({ children }: { children: React.ReactNode }) {
  if (!kioskEnabled()) notFound();
  return (
    <QueryProvider>
      <KioskShell>{children}</KioskShell>
    </QueryProvider>
  );
}
