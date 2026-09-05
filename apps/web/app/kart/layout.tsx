import type { Metadata, Viewport } from "next";

/**
 * The FT Kart Tracker's own identity, separate from the site's.
 *
 * Saved to a home screen this is a distinct app — its own name, its own icon,
 * opening on the kart-number screen rather than the FastTrax homepage (owner
 * 2026-09-05). Three things make that true, and all three are needed:
 *
 *   manifest              Android reads name / start_url / icons from here. A
 *                         nested layout's manifest overrides the root one.
 *   appleWebApp.title     iOS ignores the manifest's name and uses this.
 *   appleWebApp.capable   iOS only drops the address bar when this is set.
 *
 * `viewportFit: "cover"` matters once installed: without it the notch and the
 * home indicator leave letterboxed bars on a phone held sideways, which is the
 * screen space this whole exercise is trying to win back.
 */
export const metadata: Metadata = {
  title: { default: "FT Kart Tracker", template: "%s | FT Kart Tracker" },
  applicationName: "FT Kart Tracker",
  manifest: "/kart/app.webmanifest",
  appleWebApp: {
    capable: true,
    title: "FT Kart Tracker",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/kart/app-icon?s=192", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/kart/app-icon?s=180", sizes: "180x180", type: "image/png" }],
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#000418",
  viewportFit: "cover",
  // The pit board is a fixed layout read at a glance; pinch-zooming it only
  // ever loses the guest their place. Not applied to the report pages, which
  // live under /race and are ordinary documents.
  initialScale: 1,
  maximumScale: 1,
};

export default function KartLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
