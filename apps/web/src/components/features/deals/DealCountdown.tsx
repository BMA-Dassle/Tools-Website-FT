"use client";

import { useEffect, useState } from "react";
import {
  COUNTDOWN_THRESHOLD_MS,
  formatCountdown,
  formatDealDeadline,
} from "~/features/deals/format";

/**
 * A launch offer's deadline: a date most of the time, a running clock at the end.
 *
 * HYDRATION. The server has no idea what time it is on the buyer's machine, and
 * a clock rendered server-side is wrong the moment it arrives. So the first
 * render — server AND client — is always the DATE, and the ticker only appears
 * after mount, once `remainingMs` has been measured locally. There is nothing
 * for React to mismatch.
 *
 * The clock is only shown inside `COUNTDOWN_THRESHOLD_MS`. Above that the date
 * is both friendlier and more useful: "Monday, September 7" is a thing you can
 * plan around, "23d 4h" is wallpaper.
 *
 * ACCESSIBILITY. The ticking text is `aria-hidden` and the real deadline is
 * exposed once, statically, through the `<time datetime>` and an sr-only date.
 * A live region updating every second would read the clock aloud continuously,
 * which is unusable — and the information a screen-reader user needs is the
 * deadline, not the animation of it approaching.
 *
 * ONCE IT PASSES this renders NOTHING and fires `onExpire`. It must never fall
 * back to printing the date, because "ends Monday, September 7" on Tuesday is a
 * false claim about a price — the exact thing the whole feature is built to
 * avoid. The parent is responsible for replacing it with the truth.
 */

export interface DealCountdownProps {
  /** Fully-offset ISO instant from `DealOffer.endsAt`. */
  endsAt: string;
  /** Called once when the deadline passes, so a parent can re-price. */
  onExpire?: () => void;
  className?: string;
}

export default function DealCountdown({ endsAt, onExpire, className }: DealCountdownProps) {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    const endMs = new Date(endsAt).getTime();
    if (Number.isNaN(endMs)) return;

    let fired = false;
    const tick = () => {
      const left = endMs - Date.now();
      setRemainingMs(left);
      if (left <= 0 && !fired) {
        fired = true;
        onExpire?.();
      }
    };
    tick();
    // A flat 1s tick rather than a self-correcting timeout: the display only
    // changes per second inside the last hour, and setInterval drift of a few
    // milliseconds is invisible against a deadline the server owns anyway.
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endsAt, onExpire]);

  if (remainingMs !== null && remainingMs <= 0) return null;

  const dateLabel = formatDealDeadline(endsAt);
  const clock =
    remainingMs !== null && remainingMs <= COUNTDOWN_THRESHOLD_MS
      ? formatCountdown(remainingMs)
      : null;

  return (
    <time dateTime={endsAt} className={className}>
      {clock ? (
        <>
          <span aria-hidden="true">{clock}</span>
          <span className="sr-only">until {dateLabel}</span>
        </>
      ) : (
        dateLabel
      )}
    </time>
  );
}
