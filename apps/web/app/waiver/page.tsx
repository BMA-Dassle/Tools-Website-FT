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

/** Reservation-scoped when both a BMI locationId (loc) and projectId (pid) are
 *  present — signatures then attach to that reservation. */
function parseReservation(
  loc: string | undefined,
  pid: string | undefined,
): { locationId: number; projectId: string } | null {
  const locationId = Number(loc);
  if (!loc || !Number.isInteger(locationId) || locationId <= 0) return null;
  if (!pid || !/^\d+$/.test(pid)) return null;
  return { locationId, projectId: pid };
}

export default async function WaiverPage(props: {
  searchParams: Promise<{ c?: string; loc?: string; pid?: string }>;
}) {
  const { c, loc, pid } = await props.searchParams;
  const h = await headers();
  const brand = h.get("x-brand") === "headpinz" ? "headpinz" : "fasttrax";
  return (
    <WaiverFlow
      brand={brand}
      initialCenter={parseCenter(c)}
      reservation={parseReservation(loc, pid)}
    />
  );
}
