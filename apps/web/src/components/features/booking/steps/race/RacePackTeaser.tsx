"use client";

/**
 * KIOSK race-pack teaser — sits UNDER the premium packages (Rookie Pack) on the
 * race product step, same collapsed-teaser grammar (owner mockup 2026-07-18:
 * https://claude.ai/code/artifact/50e2252a-52ca-4363-9b4e-87e131e31bd0).
 *
 * Sells the CREDIT packs — the WHOLE catalog, 3/5/10 races (owner 2026-08-03;
 * Mon–Thu SKUs hidden Fri–Sun — `kioskPackSkus`). It used to offer 3-packs only,
 * which meant a returning racer mid-booking could not buy a 5- or 10-pack at
 * all: this is the only pack surface inside a booking, and the bigger packs
 * lived exclusively in the standalone attract flow. Every size/price/label here
 * is DERIVED from the catalog — nothing about "3" is written into the copy.
 *
 * The tiles + "who's this pack for?" MULTI-SELECT live in the shared
 * RacePackPicker (also composed by the cart's race-packs block): a one-person
 * party assigns implicitly; a bigger party checks off everyone who gets one and
 * applies in ONE tap (manager report 2026-07-27 — the old one-name-per-tap flow
 * left a 4-person group with a pack on only one racer). One pack per racer
 * (replace semantics). Selections are POINTERS on `item.creditPacks` — all
 * money re-derives server-side (race-pack-kiosk.ts).
 *
 * Kiosk-born; since 2026-08-10 the WEB booking flow sells packs too — but only
 * to parties with a signed-in returning racer (packs grant onto a BMI account,
 * and a new racer has none until reserve; owner: "for returning racers we can
 * bring in the race pack flow"). Renders nothing with the kill switch off, in
 * combo sessions, or when nobody in the party has an account.
 */
import { useState } from "react";
import type { BookingSession, RaceItem } from "~/features/booking";
import {
  kioskRacePacksEnabled,
  packSkusForRaceDate,
} from "~/features/booking/service/race-pack-kiosk";
import { activeComboSpecial } from "~/features/combos/combo-pricing";
import { useT } from "~/features/kiosk/i18n";
import { RacePackPicker, SINGLE_RACE_BASELINE } from "./RacePackPicker";

/** The teaser's render gate, exported so the product step and the pay-mode
 *  page can decide what to show without duplicating these rules (they must
 *  never drift apart). `raceDate` keys the weekday-pack day rule to the BOOKED
 *  race day — on the kiosk that's always today; on web it can be days away. */
export function racePackTeaserVisible(
  session: BookingSession,
  raceDate: string | null | undefined,
): boolean {
  if (!kioskRacePacksEnabled()) return false;
  if (activeComboSpecial(session)) return false;
  if (packSkusForRaceDate(raceDate ?? null).length === 0) return false;
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
  const t = useT();
  const [open, setOpen] = useState(false);

  if (!racePackTeaserVisible(session, item.date)) return null;
  const skus = packSkusForRaceDate(item.date);
  const eligible = session.party.filter((m) => !!m.bmiPersonId);

  const picks = item.creditPacks ?? [];
  const cheapest = skus[0];
  const maxSave = Math.max(...skus.map((p) => p.raceCount * SINGLE_RACE_BASELINE - p.price));
  // "3 · 5 · 10" — the sizes actually on sale right now, deduped in catalog
  // order (smallest first). A digit list needs no translation.
  const sizes = [...new Set(skus.map((p) => p.raceCount))].join(" · ");

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
                {t("racePack.teaser.name")}
              </span>
              <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-bold text-amber-400">
                {t("racePack.teaser.badge", { sizes })}
              </span>
            </div>
            <span className="shrink-0 text-base font-bold text-amber-400 tabular-nums">
              {t("racePack.teaser.from", { price: `$${cheapest.price.toFixed(2)}` })}
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-white/55">
            {t("racePack.teaser.blurb")}
          </p>
          <span className="mt-1 inline-block text-xs font-bold text-amber-400">
            {t("racePack.teaser.saveUpTo", { amount: `$${maxSave.toFixed(2)}` })}
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
          {t("racePack.teaser.choose")}
        </button>

        {open && (
          <div className="px-4 pb-4">
            <RacePackPicker
              skus={skus}
              eligible={eligible}
              ineligibleNames={session.party.filter((m) => !m.bmiPersonId).map((m) => m.firstName)}
              picks={picks}
              onChange={(next) => onChange({ creditPacks: next })}
            />

            <p className="mt-3 border-t border-white/10 pt-2.5 text-[11px] leading-relaxed text-white/45">
              <span className="font-bold text-emerald-400">✓</span>{" "}
              {t("racePack.teaser.fineprint", {
                price: `$${SINGLE_RACE_BASELINE.toFixed(2)}`,
              })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
