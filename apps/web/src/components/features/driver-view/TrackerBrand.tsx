/**
 * Whose screen this is, and where the timing comes from.
 *
 * The tracker is registered chrome-free — no site nav, no footer — and once a
 * guest installs it to their home screen it is the only FastTrax surface they
 * are looking at. So the branding has to be part of the screen rather than
 * inherited from the layout, and the timing attribution has to travel with it.
 *
 * TWO SIZES, ONE COMPONENT. `full` for the screens a guest is standing still on
 * — entry, rotate, nothing-on-this-kart, the report footer. `compact` for the
 * pit board's top strip, where anything bigger competes with the two numbers
 * that are the entire point of the screen.
 *
 * The logo is the same blob asset the site nav loads, so the tracker and the
 * site cannot drift apart, and it is already allow-listed in next.config's
 * remotePatterns.
 */
import Image from "next/image";
import { c, fluid, label } from "./tokens";

const LOGO_SRC = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logo/FT_logo.png";

/** The vendor behind the timing feed. Both words are a proper noun — they stay
 *  English in every locale, like FastTrax and Blue Track. */
export const POWERED_BY = "Powered by BMI Leisure";

export function TrackerLogo({ size = "full" }: { size?: "full" | "compact" }) {
  const h = size === "compact" ? fluid(16, 2.6, 26) : fluid(30, 5.5, 54);
  return (
    <Image
      src={LOGO_SRC}
      alt="FastTrax Entertainment"
      width={280}
      height={104}
      // `priority` on the entry screen only: on the pit board this is the least
      // important thing on the page and must never queue ahead of the numbers.
      priority={size === "full"}
      style={{ height: h, width: "auto", objectFit: "contain" }}
    />
  );
}

export function PoweredByBmi({ align = "center" }: { align?: "center" | "left" }) {
  return (
    <div
      style={{
        ...label,
        fontSize: fluid(8, 1.1, 11),
        color: c.inkFaint,
        textAlign: align,
        letterSpacing: "0.16em",
      }}
    >
      {POWERED_BY}
    </div>
  );
}

/** Logo over the attribution — the block the standing-still screens use. */
export function TrackerBrand({ align = "center" }: { align?: "center" | "left" }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "center" ? "center" : "flex-start",
        gap: fluid(5, 0.9, 9),
      }}
    >
      <TrackerLogo />
      <PoweredByBmi align={align} />
    </div>
  );
}
