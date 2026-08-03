"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { IconClockHour4 } from "@tabler/icons-react";
import DealCountdown from "./DealCountdown";

/**
 * "Includes 50 bonus tokens per pack through Thursday, August 6."
 *
 * The hero's one urgency element. It owns the whole sentence rather than just
 * the date so that when the deadline passes it can remove the whole sentence
 * instead of leaving a grammatically broken half of one behind.
 *
 * WHAT IT DOES NOT SAY is the point: no "$39 after". The price does not move
 * (owner 2026-08-03), so the deadline is stated against the thing that actually
 * ends — the bonus. Everything on this page has to survive a guest coming back
 * on Friday and checking.
 *
 * SELF-HEALING. The page around it is server-rendered — the value table, the
 * saving, the Offer JSON-LD — so when the deadline passes mid-visit all of those
 * go stale at once. Patching them individually from the client would be a lot of
 * state for a rare event and would still leave the structured data wrong.
 * `router.refresh()` re-runs the server components and the whole page becomes
 * consistent in one step, while React client state (crucially, anything already
 * typed into the buy panel) survives untouched.
 */

export interface DealOfferNoteProps {
  endsAt: string;
  /** e.g. "50 bonus tokens per pack". */
  bonusLabel: string;
  accentColor: string;
}

export default function DealOfferNote({ endsAt, bonusLabel, accentColor }: DealOfferNoteProps) {
  const router = useRouter();
  const [expired, setExpired] = useState(false);

  const handleExpire = useCallback(() => {
    setExpired(true);
    router.refresh();
  }, [router]);

  if (expired) return null;

  return (
    <p
      className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold"
      style={{ color: accentColor }}
    >
      <IconClockHour4 size={16} aria-hidden="true" />
      <span>
        Includes {bonusLabel} through <DealCountdown endsAt={endsAt} onExpire={handleExpire} />
      </span>
    </p>
  );
}
