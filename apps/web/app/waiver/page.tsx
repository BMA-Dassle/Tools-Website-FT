import { headers } from "next/headers";
import type { CenterCode } from "~/features/booking/types";
import { WaiverFlow } from "~/features/waiver/WaiverFlow";
import "~/features/waiver/waiver-party.css";

/**
 * /waiver — the unified first-party waiver flow. Shared top-level route on BOTH
 * brand hosts (registered in middleware.ts isSharedTopLevelRoute + x-no-chrome);
 * brand theming comes from the host (x-brand), center from ?c=. Reachable by
 * typed URL for QA; outbound entry points (nav/footer/email/SMS) are flipped to
 * it in a later, flag-gated PR.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign your waiver",
  robots: { index: false, follow: false },
};

function parseCenter(c: string | undefined): CenterCode | null {
  if (c === "naples") return "naples";
  if (c === "fort-myers" || c === "fasttrax") return "fort-myers";
  return null;
}

export default async function WaiverPage(props: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await props.searchParams;
  const h = await headers();
  const brand = h.get("x-brand") === "headpinz" ? "headpinz" : "fasttrax";
  return <WaiverFlow brand={brand} initialCenter={parseCenter(c)} />;
}
