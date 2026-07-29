"use client";

/**
 * KIOSK race-pack teaser — sits UNDER the premium packages (Rookie Pack) on the
 * race product step, same collapsed-teaser grammar (owner mockup 2026-07-18:
 * https://claude.ai/code/artifact/50e2252a-52ca-4363-9b4e-87e131e31bd0).
 *
 * Sells the CREDIT packs (3-race only on the kiosk; Mon–Thu hidden Fri–Sun —
 * `kioskPackSkus`). The tiles + "who's this pack for?" MULTI-SELECT live in the
 * shared RacePackPicker (also composed by the cart's race-packs block): a
 * one-person party assigns implicitly; a bigger party checks off everyone who
 * gets one and applies in ONE tap (manager report 2026-07-27 — the old
 * one-name-per-tap flow left a 4-person group with a pack on only one racer).
 * One pack per racer (replace semantics). Selections are POINTERS on
 * `item.creditPacks` — all money re-derives server-side (race-pack-kiosk.ts).
 *
 * Renders nothing off-kiosk / with the kill switch off / in combo sessions.
 */
import { useState } from "react";
import type { BookingSession, RaceItem } from "~/features/booking";
import { kioskRacePacksEnabled, kioskPackSkus } from "~/features/booking/service/race-pack-kiosk";
import { activeComboSpecial } from "~/features/combos/combo-pricing";
import { RacePackPicker, SINGLE_RACE_BASELINE } from "./RacePackPicker";

/** The teaser's render gate, exported so the product step can decide whether
 *  the "pick a single race" divider has anything above it without duplicating
 *  these rules (they must never drift apart). */
export function racePackTeaserVisible(session: BookingSession): boolean {
  if (!session.context?.kiosk || !kioskRacePacksEnabled()) return false;
  if (activeComboSpecial(session)) return false;
  if (kioskPackSkus().length === 0) return false;
  return session.party.some((m) => !!m.bmiPersonId);
}

export function RacePackTeaser({
  item,
  session,
  onChange,
}: {
  item: RaceItem;
  session: BookingSession;
  onChange: (patch: Partial<RaceItem>) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!racePackTeaserVisible(session)) return null;
  const skus = kioskPackSkus();
  const eligible = session.party.filter((m) => !!m.bmiPersonId);

  const picks = item.creditPacks ?? [];
  const cheapest = skus[0];
  const maxSave = Math.max(...skus.map((p) => p.raceCount * SINGLE_RACE_BASELINE - p.price));

  return (
    <div>
      <div className="rounded-xl border border-amber-500/20 bg-linear-to-br from-amber-500/10 to-amber-500/5 transition-all duration-200">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="block w-full p-4 text-left"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
                3-Race Pack
              </span>
              <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-bold text-amber-400">
                3 RACES
              </span>
            </div>
            <span className="shrink-0 text-base font-bold text-amber-400 tabular-nums">
              from ${cheapest.price.toFixed(2)}
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-white/55">
            Prepay 3 races at a discount — race today, the rest bank on your account and never
            expire.
          </p>
          <span className="mt-1 inline-block text-xs font-bold text-amber-400">
            Save up to ${maxSave.toFixed(2)}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 border-t border-dashed border-white/10 px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-widest text-amber-300/90"
        >
          <span
            aria-hidden
            className={`inline-block transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          >
            ›
          </span>
          Choose your pack
        </button>

        {open && (
          <div className="px-4 pb-4">
            <RacePackPicker
              skus={skus}
              eligible={eligible}
              picks={picks}
              onChange={(next) => onChange({ creditPacks: next })}
            />

            <p className="mt-3 border-t border-white/10 pt-2.5 text-[11px] leading-relaxed text-white/45">
              <span className="font-bold text-emerald-400">✓</span> Credits load right after payment
              and never expire. One pack per racer · non-transferable · savings vs the $
              {SINGLE_RACE_BASELINE.toFixed(2)} single race.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
