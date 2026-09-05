import { NextResponse } from "next/server";

/**
 * FT Kart Tracker — its OWN web app manifest, deliberately not the site's.
 *
 * The root `app/manifest.ts` installs "FastTrax Entertainment" pointing at `/`.
 * A guest who saves the tracker wants the TRACKER: an app called FT Kart
 * Tracker that opens on the kart-number screen, with its own icon so it is not
 * confused with the site icon beside it (owner 2026-09-05).
 *
 * `app/kart/layout.tsx` points at this instead of the root manifest — a nested
 * layout's `metadata.manifest` overrides the one above it.
 *
 * `display: standalone` is the whole point: no address bar, which on a phone
 * held sideways is most of the screen back.
 *
 * FASTTRAX ONLY, like the rest of /kart. There is no karting at HeadPinz, so
 * unlike the root manifest this one does not branch on host.
 */
export async function GET() {
  return NextResponse.json(
    {
      id: "/kart",
      name: "FT Kart Tracker",
      short_name: "Kart Tracker",
      description: "Live position, lap times and flags for your kart at FastTrax.",
      start_url: "/kart",
      scope: "/kart",
      display: "standalone",
      // Landscape is what the pit board is drawn for. `any` rather than a hard
      // lock: a locked orientation fights a guest who has rotation off, and the
      // rotate prompt already handles portrait more gently than the OS would.
      orientation: "any",
      background_color: "#000418",
      theme_color: "#000418",
      icons: [
        { src: "/kart/app-icon?s=192", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/kart/app-icon?s=512", sizes: "512x512", type: "image/png", purpose: "any" },
      ],
    },
    {
      headers: {
        "Content-Type": "application/manifest+json",
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
}
