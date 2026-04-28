"use client";

import type { Booking } from "../page";

/**
 * Context banner shown above the heat picker when the customer has
 * already booked one or more heats from a PRIOR category in this
 * session. Most common case: party with adults + juniors books all
 * the adult heats first, then bounces back to the picker for juniors
 * — without this banner the customer loses sight of what they already
 * picked and gets nervous they'll lose their adult times.
 *
 * Renders one pill per prior booking with race label, track, time,
 * and racer count. Click handlers intentionally absent — this is a
 * read-only confirmation, not an editing surface (changing prior
 * bookings means going back to the cart / review step).
 */

function formatTime(iso: string): string {
  const clean = iso.replace(/Z$/, "");
  const [datePart, timePart] = clean.split("T");
  if (!timePart) return clean;
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, min] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, h, min).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const TRACK_PILL: Record<string, string> = {
  Red:  "border-red-500/40 bg-red-500/[0.10] text-red-200",
  Blue: "border-blue-500/40 bg-blue-500/[0.10] text-blue-200",
  Mega: "border-purple-500/40 bg-purple-500/[0.10] text-purple-200",
};

/** Filter rule: only show bookings from a DIFFERENT category than the
 *  one the customer is currently filling. Same-category prior bookings
 *  (e.g. add-another-race within the same side) are already represented
 *  on the heat-picker grid via `bookedHeats` conflict greying. */
export default function PriorBookingsBanner({
  bookings,
  currentCategory,
}: {
  bookings: Booking[];
  currentCategory: "adult" | "junior";
}) {
  const prior = bookings.filter((b) => b.product.category !== currentCategory);
  if (prior.length === 0) return null;

  const otherCategory = currentCategory === "adult" ? "junior" : "adult";
  const otherLabel = otherCategory === "adult" ? "Adult" : "Junior";

  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-300 text-[11px] font-bold">
          ✓
        </span>
        <p className="text-emerald-300 text-xs font-bold uppercase tracking-widest">
          {otherLabel} {prior.length === 1 ? "race" : "races"} already booked
        </p>
      </div>
      <p className="text-white/50 text-[11px] mb-3 leading-relaxed">
        You&apos;re all set for the {otherLabel.toLowerCase()}s. Now pick heats for
        your {currentCategory === "adult" ? "adults" : "juniors"} below — same
        bill, same date.
      </p>
      <div className="flex flex-wrap gap-2">
        {prior.map((b, i) => {
          const trackTint = b.product.track ? TRACK_PILL[b.product.track] : null;
          const pillClass = trackTint
            ? `border ${trackTint}`
            : "border border-white/15 bg-white/5 text-white/70";
          return (
            <span
              key={`${b.product.productId}-${b.block.start}-${i}`}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold ${pillClass}`}
            >
              <span>🏎️ {b.product.name}</span>
              <span className="opacity-70">·</span>
              <span className="font-mono">{formatTime(b.block.start)}</span>
              {b.quantity > 1 && (
                <>
                  <span className="opacity-70">·</span>
                  <span className="opacity-80">× {b.quantity}</span>
                </>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
