import { ImageResponse } from "next/og";
import { headers } from "next/headers";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * Apple touch icon — brand-aware. Programmatically generated so it stays
 * consistent with brand colors without checking in two PNG assets.
 *
 * We avoid relying on a bundled font (the default ImageResponse font fetch
 * has been flaky on Vercel cold starts) and keep the design to plain
 * background + bold text using the system font.
 */
export default async function AppleIcon() {
  const hdrs = await headers();
  const host = (hdrs.get("host") || "").toLowerCase();
  const isHeadPinz = host.includes("headpinz.com");

  const bg = isHeadPinz ? "#0a1628" : "#000418";
  const fg = isHeadPinz ? "#ffffff" : "#E41C1D";
  const label = isHeadPinz ? "HP" : "FT";

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: bg,
        color: fg,
        fontSize: 96,
        fontWeight: 900,
        letterSpacing: -2,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {label}
    </div>,
    { ...size },
  );
}
