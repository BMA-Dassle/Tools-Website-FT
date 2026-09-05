import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

/**
 * The FT Kart Tracker home-screen icon.
 *
 * ITS OWN MARK, NOT THE SITE'S. Installed, this is a separate app on the
 * guest's home screen — "FT Kart Tracker", starting at /kart — so it must not
 * be mistaken for the FastTrax site icon sitting next to it. Same family (the
 * navy ground and the brand red of `app/apple-icon.tsx`), different mark: a
 * chequered band under the letters.
 *
 * Generated rather than checked in, matching how the site's own icons are done,
 * and served from a STABLE path so the manifest can point at it — Next's
 * `icon.tsx` convention appends a content hash, which a hand-written manifest
 * cannot know.
 *
 * `?s=` picks the square size; the manifest asks for 192 and 512.
 */
export const contentType = "image/png";

/** Sizes the manifest is allowed to ask for. An open size parameter is an
 *  invitation to render 8000×8000 on someone else's CPU. */
const ALLOWED = new Set([180, 192, 512]);

export async function GET(req: NextRequest) {
  const raw = Number(new URL(req.url).searchParams.get("s") ?? "192");
  const size = ALLOWED.has(raw) ? raw : 192;

  // Everything scales off the square so one drawing serves every size.
  const u = size / 192;
  const band = Math.round(26 * u);
  const cell = Math.round(band / 2);
  const cols = Math.ceil(size / cell);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#000418",
        position: "relative",
      }}
    >
      <div
        style={{
          display: "flex",
          color: "#E41C1D",
          fontSize: Math.round(86 * u),
          fontWeight: 900,
          letterSpacing: Math.round(-3 * u),
          fontFamily: "system-ui, sans-serif",
          marginTop: -band,
        }}
      >
        FT
      </div>
      {/* chequered band — the thing that says "tracker", not "website" */}
      <div style={{ display: "flex", position: "absolute", bottom: 0, left: 0 }}>
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                width: cell,
                height: cell,
                background: i % 2 === 0 ? "#f5ecee" : "#000418",
              }}
            />
            <div
              style={{
                width: cell,
                height: cell,
                background: i % 2 === 0 ? "#000418" : "#f5ecee",
              }}
            />
          </div>
        ))}
      </div>
    </div>,
    { width: size, height: size },
  );
}
