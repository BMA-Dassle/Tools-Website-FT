"use client";

/**
 * The kiosk's branded loader — brand logo at rest inside a cyan "comet arc"
 * orbit with a breathing glow. Replaces every bare spinner on kiosk surfaces
 * (design decision 2026-07-17: anything that loads shows the logo loader).
 *
 * Pure CSS/SVG animation (keyframes in app/kiosk/kiosk.css); no JS timers.
 */
import type { Brand } from "~/features/booking";
import { BrandLogo } from "./BrandLogo";

export function BrandedLoader({
  brand = "fasttrax",
  label,
  sublabel,
  size = 300,
}: {
  brand?: Brand;
  label?: string;
  sublabel?: string;
  size?: number;
}) {
  const badge = Math.round(size * 0.64);
  // Badge padding scales with `size` (32px at the 300 default) — a fixed p-8
  // ate the whole badge at inline sizes and the logo collapsed to nothing.
  const badgePad = Math.round(size * 0.107);
  return (
    <div className="flex flex-col items-center gap-10 text-center" role="status" aria-live="polite">
      <div className="relative grid place-items-center" style={{ width: size, height: size }}>
        <div className="kiosk-breathe absolute inset-[9%] rounded-full bg-[radial-gradient(circle,rgba(0,226,229,0.22),transparent_65%)]" />
        <svg className="kiosk-orbit absolute inset-0" viewBox="0 0 340 340" aria-hidden="true">
          <circle
            cx="170"
            cy="170"
            r="150"
            fill="none"
            stroke="url(#kiosk-comet)"
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray="700 245"
          />
          <defs>
            <linearGradient id="kiosk-comet" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#00e2e5" />
              <stop offset="1" stopColor="#00e2e5" stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>
        <div
          className="grid place-items-center rounded-full border border-white/10 bg-[#0d1a36]"
          style={{ width: badge, height: badge, padding: badgePad }}
        >
          <BrandLogo brand={brand} className="max-h-full max-w-full object-contain" />
        </div>
      </div>
      {label ? (
        <div className="font-heading text-[40px] font-bold italic leading-tight">{label}</div>
      ) : null}
      {sublabel ? <div className="-mt-6 text-[24px] text-white/55">{sublabel}</div> : null}
    </div>
  );
}

/** Full-screen variant — dims the kiosk while vendor calls are in flight. */
export function BrandedLoaderOverlay({
  brand,
  label,
  sublabel,
}: {
  brand?: Brand;
  label: string;
  sublabel?: string;
}) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#000418]/95 backdrop-blur-sm">
      <BrandedLoader brand={brand} label={label} sublabel={sublabel ?? "Just a second"} />
    </div>
  );
}
