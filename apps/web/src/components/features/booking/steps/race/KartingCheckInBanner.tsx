"use client";

/**
 * THE BANNER ABOVE THE HEAT GRID — what the times on these cards actually mean.
 *
 * Owner 2026-08-17, looking at the kiosk grid: "in all that empty space at the
 * top I think we need to utilize it better. We need to make it very clear this is
 * your Karting check in time. Not your race time. Also add current track status
 * and that it can can up to 30 minutes from check in to race."
 *
 * WHY THIS IS THE RIGHT PLACE FOR IT. The grid is the FIRST time a guest ever
 * sees one of these times, and every later surface (confirmation, e-ticket,
 * wallet pass, kiosk hub) has to spend words undoing the wrong model if it is
 * learned here. One banner at the top costs a strip of space that was empty
 * anyway; the same explanation repeated on twenty cards is noise.
 *
 * THREE THINGS, IN THIS ORDER:
 *  1. THE MEANING — these are karting check-in times, at the 1st Floor desk, and
 *     not race times. Loudest element, because it is the one that changes
 *     behaviour.
 *  2. THE ALLOWANCE — how long after check-in racing actually starts, taken from
 *     TODAY'S measured span where we have one and the measured 30-minute default
 *     where we do not (owner: "if no data for the day use 30 minutes"). Always
 *     rendered as an estimate — owner: "make sure we put est."
 *  3. TRACK STATUS — the same On Time / +N late verdict every other surface
 *     shows, from our own data (features/racing/on-time.ts).
 *
 * Shared by the web booking flow and the kiosk (the kiosk registry mounts the
 * same step), so every string goes through the kiosk catalog — `useT` falls back
 * to English outside a LocaleProvider, which is what the web gets.
 */

import { useTrackStatus } from "@/hooks/useTrackStatus";
import { useT } from "~/features/kiosk/i18n";
import { raceByAllowanceMin, trackDisplay, verdictLabel } from "~/features/racing/on-time-display";

/** Tracks whose status is worth showing beside a grid. Mega replaces both on a
 *  Mega day, which is why the caller passes what the grid is actually showing. */
export interface KartingCheckInBannerProps {
  /** Lowercase track keys the grid currently spans — "blue" | "red" | "mega". */
  tracks: string[];
}

const TRACK_LABEL: Record<string, string> = {
  blue: "Blue Track",
  red: "Red Track",
  mega: "Mega Track",
};

const TRACK_TINT: Record<string, string> = {
  blue: "#4fa9ff",
  red: "#e53935",
  mega: "#8652ff",
};

export default function KartingCheckInBanner({ tracks }: KartingCheckInBannerProps) {
  const t = useT();
  const status = useTrackStatus();
  const onTime = status?.onTime ?? null;

  // One allowance for the banner even when the grid spans two tracks: the guest
  // is picking ONE heat and does not yet know which track, so the longer of the
  // two is the only bound that is true whichever they choose.
  const allowanceMin = tracks.length
    ? Math.max(...tracks.map((tr) => raceByAllowanceMin(onTime, tr)))
    : raceByAllowanceMin(onTime, "blue");

  return (
    <div className="mx-auto max-w-2xl space-y-3 rounded-2xl border border-[#00E2E5]/25 bg-[#00E2E5]/[0.04] p-4">
      {/* 1. THE MEANING — loudest, because it is the line that changes behaviour. */}
      <div className="text-center">
        <p className="font-display text-sm tracking-widest text-[#00E2E5] uppercase sm:text-base">
          {t("race.heat.bannerTitle")}
        </p>
        {/* The place is spelled out in the catalog rather than interpolated from
            KARTING_CHECKIN_PLACE, so the Spanish can translate "1st Floor, by the
            Red Track" instead of dropping an English fragment into a Spanish
            sentence. That module stays the source of truth for every non-kiosk
            surface; if its wording changes, change these two keys with it. */}
        <p className="mt-1 text-xs text-white/70 sm:text-sm">{t("race.heat.bannerBody")}</p>
      </div>

      {/* 2. THE ALLOWANCE — today's measured span, or the 30-minute default. */}
      <p className="text-center text-xs font-semibold text-amber-300/90">
        {t("race.heat.bannerAllowance", { mins: allowanceMin })}
      </p>

      {/* 3. TRACK STATUS — our own verdict, the same words the TVs use. */}
      {tracks.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2">
          {tracks.map((tr) => {
            const d = trackDisplay(onTime, tr, null);
            const tint = TRACK_TINT[tr] ?? "#00E2E5";
            return (
              <span
                key={tr}
                className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs"
                style={{ borderColor: `${tint}55`, background: "rgba(0,0,0,0.25)" }}
              >
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ background: d.tone === "warn" ? "#f0b341" : "#46d68c" }}
                />
                <span className="font-semibold text-white/80">{TRACK_LABEL[tr] ?? tr}</span>
                <span className="font-bold" style={{ color: tint }}>
                  {verdictLabel(d)}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
