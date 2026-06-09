/**
 * Shared QAMF availability client for the bowling/KBF booking steps.
 *
 * v1 parity (apps/web/components/bowling/BowlingWizard.tsx `fetchSlots`):
 *   - probe with cold-start retry (the first request after a deploy can hit a
 *     cold Lambda / cold QAMF auth and 502),
 *   - a coarse hourly scan to drive the "which hours are open" chips, and
 *   - a targeted fine probe (with a full-day widen safeguard) for exact times.
 *
 * QAMF availability/search is POINT-IN-TIME (one BookedAt per probe), so a
 * 15-min full-day scan = ~52 probes = timeout. The date step uses the cheap
 * hourly scan (stepMinutes=60, ~13 probes); the package step probes a narrow
 * window around the chosen hour and only widens when that hour is empty.
 */

export interface RawAvailability {
  Availabilities?: Array<{
    BookedAt: string;
    WebOffer: {
      Id: number | string;
      Title?: string;
      Options?: Record<string, Array<{ Id: number; Minutes?: number }>>;
    };
  }>;
}

export interface AvailabilitySlot {
  bookedAt: string;
  webOfferId: number;
  webOfferTitle: string;
  optionId?: number;
  optionType?: "Game" | "Time" | "Unlimited";
  availableTimeOptionIds?: number[];
}

/**
 * Fetch QAMF availability with cold-start retry (502/503/504). The first
 * request after a deploy — or any request that lands on a freshly-spun cold
 * worker under load — can fail the route's all-probes-failed guard; retry a
 * few times with growing backoff before surfacing a "no times" UX that's
 * actually an upstream blip. (v1 parity: BowlingWizard.tsx fetchSlots.)
 */
export async function probeAvailability(url: string): Promise<RawAvailability> {
  const backoffs = [600, 1500, 2500];
  let lastStatus = 0;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    const res = await fetch(url);
    if (res.ok) return (await res.json()) as RawAvailability;
    lastStatus = res.status;
    const retryable = res.status === 502 || res.status === 503 || res.status === 504;
    if (!retryable || attempt === backoffs.length) break;
    await new Promise((r) => setTimeout(r, backoffs[attempt]));
  }
  throw new Error(`Availability request failed: ${lastStatus}`);
}

/** Map a QAMF availability response to our slot shape. */
export function parseAvailabilities(data: RawAvailability): AvailabilitySlot[] {
  return (data.Availabilities ?? []).map((a) => {
    const twoGame = a.WebOffer.Options?.Game?.find((g) => g.Id);
    const timeOpts = a.WebOffer.Options?.Time ?? [];
    const unlimOpts = a.WebOffer.Options?.Unlimited ?? [];

    let optionId: number | undefined;
    let optionType: "Game" | "Time" | "Unlimited" = "Game";
    if (twoGame) {
      optionId = twoGame.Id;
      optionType = "Game";
    } else if (timeOpts[0]) {
      const longest = timeOpts.reduce(
        (best, t) => ((t.Minutes ?? 0) > (best.Minutes ?? 0) ? t : best),
        timeOpts[0],
      );
      optionId = longest.Id;
      optionType = "Time";
    } else if (unlimOpts[0]) {
      optionId = unlimOpts[0].Id;
      optionType = "Unlimited";
    }

    return {
      bookedAt: a.BookedAt,
      webOfferId: typeof a.WebOffer.Id === "string" ? parseInt(a.WebOffer.Id, 10) : a.WebOffer.Id,
      webOfferTitle: a.WebOffer.Title ?? "",
      optionId,
      optionType,
      availableTimeOptionIds: timeOpts.map((t) => t.Id),
    };
  });
}

/**
 * ET hour (0-23) of an ISO time; post-midnight (12-2 AM, Fri/Sat late-night)
 * bumped to 24-26 so hour chips sort after 11 PM rather than wrapping to the
 * front. Matches the offer step + v1's hour-chip notation.
 */
export function etHour(iso: string): number {
  try {
    const h = Number(
      new Date(iso).toLocaleString("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        hour12: false,
      }),
    );
    return h < 6 ? h + 24 : h;
  } catch {
    return 0;
  }
}

/** "7 PM", "11 AM", "12 AM" from an hour in 0-26 notation. */
export function formatHourLabel(h: number): string {
  const hr = h % 24;
  const ampm = hr >= 12 ? "PM" : "AM";
  const disp = hr % 12 === 0 ? 12 : hr % 12;
  return `${disp} ${ampm}`;
}

/** Distinct open hours (0-26 notation, sorted) from a coarse availability scan. */
export function hoursFromAvailability(data: RawAvailability): number[] {
  const hrs = new Set<number>();
  for (const a of data.Availabilities ?? []) hrs.add(etHour(a.BookedAt));
  return [...hrs].sort((a, b) => a - b);
}
