"use client";

/**
 * Shared kiosk race-pack picker — pack tiles + a MULTI-SELECT "who's this pack
 * for?" panel + the current assignments list. Composed by two surfaces:
 *   - RacePackTeaser (race product step) — inside its collapsed accordion
 *   - CartView's race-packs block — fix a missing pack from the cart without
 *     re-entering the wizard (manager report 2026-07-27: a 4-person group got
 *     a pack on only ONE racer because the old picker took one name per tap,
 *     and the wizard walk back was a trap)
 *
 * Every tile is rendered from the SKU it was handed — sizes, day types, prices
 * and savings are catalog values, so the same component serves 2 tiles or all
 * six (3/5/10 × Mon–Thu/Any-Day, owner 2026-08-03).
 *
 * Selections are POINTERS on `item.creditPacks` — all money re-derives
 * server-side at charge time (race-pack-kiosk.ts), so applying here is pure
 * session state: no vendor calls. One pack per racer (replace semantics) is
 * kept, enforced again server-side in resolveKioskPacks.
 *
 * Guest-facing copy goes through the kiosk catalog (EN+ES). `useT` falls back to
 * English outside a LocaleProvider, so composing this off-kiosk is safe.
 */
import { useState } from "react";
import {
  applyPackSelection,
  type KioskPackSelection,
} from "~/features/booking/service/race-pack-kiosk";
import { getRacePack, type RacePack } from "~/features/booking/data/packs";
import { useT, type Translate } from "~/features/kiosk/i18n";

/** Savings baseline = the $26.99 single race (never fold the license in). */
export const SINGLE_RACE_BASELINE = 26.99;

export interface PackEligibleMember {
  id: string;
  firstName: string;
  lastName?: string;
}

function nameOf(members: PackEligibleMember[], memberId: string): string {
  const m = members.find((x) => x.id === memberId);
  return m ? `${m.firstName} ${m.lastName ?? ""}`.trim() : "";
}

/** "Mon–Thu" / "Any day" in the guest's language. */
function dayLabel(t: Translate, pack: RacePack): string {
  return pack.dayType === "weekday" ? t("racePack.build.monThu") : t("racePack.build.anyDay");
}

/** Current assignments — one row per racer with a remove ×. Shared by the
 *  picker (below the tiles) and the cart block's collapsed summary. */
export function PackAssignmentList({
  picks,
  eligible,
  onChange,
}: {
  picks: KioskPackSelection[];
  eligible: PackEligibleMember[];
  onChange: (next: KioskPackSelection[] | undefined) => void;
}) {
  const t = useT();
  if (picks.length === 0) return null;
  const remove = (memberId: string) => {
    const next = picks.filter((p) => p.memberId !== memberId);
    onChange(next.length > 0 ? next : undefined);
  };
  return (
    <div className="space-y-1.5">
      {picks.map((p) => {
        const sku = getRacePack(p.slug);
        const name = nameOf(eligible, p.memberId);
        return (
          <div
            key={`${p.memberId}-${p.slug}`}
            className="flex items-center justify-between rounded-lg border border-[#00E2E5]/40 bg-[#00E2E5]/5 px-3 py-2 text-sm"
          >
            <span>
              <span className="font-bold">{name}</span>
              {/* An off-catalog slug can't reach here from the tiles (and would
                  be refused at charge time) — still, render the name + the
                  remove door rather than inventing a size for it. */}
              {sku
                ? ` — ${t("racePack.picker.assignment", {
                    count: sku.raceCount,
                    day: dayLabel(t, sku),
                    price: `$${sku.price.toFixed(2)}`,
                  })}`
                : ""}
            </span>
            <button
              type="button"
              aria-label={t("racePack.picker.removeAria", { name })}
              onClick={() => remove(p.memberId)}
              className="ml-3 text-base leading-none text-white/50 transition-colors hover:text-red-300"
            >
              ×
            </button>
          </div>
        );
      })}
      <p className="text-xs text-white/45">{t("racePack.picker.firstCredit")}</p>
    </div>
  );
}

export function RacePackPicker({
  skus,
  eligible,
  picks,
  onChange,
  showAssignments = true,
  autoOpen = false,
}: {
  /** The packs this surface offers right now (already day-filtered). */
  skus: RacePack[];
  /** Party members a pack can land on (bmiPersonId-holders). */
  eligible: PackEligibleMember[];
  /** Current selections (item.creditPacks ?? []). */
  picks: KioskPackSelection[];
  /** Receives the FULL next selection array (undefined = none). */
  onChange: (next: KioskPackSelection[] | undefined) => void;
  /** The cart block renders its own summary rows — let it hide this copy. */
  showAssignments?: boolean;
  /** Mount with the "who's this pack for?" panel ALREADY expanded (owner
   *  preview feedback 2026-07-27: the cart's Add / edit landed on bare tiles
   *  and the selector stayed collapsed until a second tap). Opens on the pack
   *  that already has holders, else the first offered pack. */
  autoOpen?: boolean;
}) {
  const t = useT();
  // The tile whose "who's this for?" panel is open + the working set of
  // checked members. Seeded with the tile's CURRENT holders so the panel is
  // an edit surface: unchecking someone and applying removes their pack.
  // (Mount-time only — cheap to recompute per render, useState ignores it.)
  const initialSlug =
    autoOpen && eligible.length > 1
      ? (skus.find((s) => picks.some((p) => p.slug === s.slug))?.slug ?? skus[0]?.slug ?? null)
      : null;
  const [pendingSlug, setPendingSlug] = useState<string | null>(initialSlug);
  const [pendingIds, setPendingIds] = useState<string[]>(
    initialSlug ? picks.filter((p) => p.slug === initialSlug).map((p) => p.memberId) : [],
  );

  const holdersOf = (slug: string) => picks.filter((p) => p.slug === slug).map((p) => p.memberId);

  const pickTile = (slug: string) => {
    // One-person party: the tile itself is the toggle — no panel ceremony.
    if (eligible.length === 1) {
      const only = eligible[0];
      const has = picks.some((p) => p.memberId === only.id && p.slug === slug);
      onChange(applyPackSelection(picks, slug, has ? [] : [only.id]));
      setPendingSlug(null);
      return;
    }
    if (pendingSlug === slug) {
      setPendingSlug(null);
      return;
    }
    setPendingSlug(slug);
    setPendingIds(holdersOf(slug));
  };

  const toggleMember = (memberId: string) => {
    setPendingIds((cur) =>
      cur.includes(memberId) ? cur.filter((id) => id !== memberId) : [...cur, memberId],
    );
  };

  const toggleEveryone = () => {
    setPendingIds((cur) => (cur.length === eligible.length ? [] : eligible.map((m) => m.id)));
  };

  const apply = () => {
    if (!pendingSlug) return;
    onChange(applyPackSelection(picks, pendingSlug, pendingIds));
    setPendingSlug(null);
  };

  const pendingSku = pendingSlug ? skus.find((s) => s.slug === pendingSlug) : undefined;
  const pendingCount = pendingIds.length;
  const pendingHadHolders = pendingSlug ? holdersOf(pendingSlug).length > 0 : false;
  const applyDisabled = pendingCount === 0 && !pendingHadHolders;
  const applyLabel =
    pendingCount > 0
      ? t("racePack.picker.addPacks", {
          count: pendingCount,
          amount: `$${(pendingCount * (pendingSku?.price ?? 0)).toFixed(2)}`,
        })
      : pendingHadHolders
        ? t("racePack.picker.removePack")
        : t("racePack.picker.selectRacers");

  return (
    <div>
      <div
        className={`grid gap-3 ${skus.length > 1 ? "grid-cols-2" : "mx-auto max-w-[320px] grid-cols-1"}`}
      >
        {skus.map((p) => {
          const holders = picks.filter((x) => x.slug === p.slug);
          const selected = holders.length > 0 || pendingSlug === p.slug;
          const save = p.raceCount * SINGLE_RACE_BASELINE - p.price;
          return (
            <button
              key={p.slug}
              type="button"
              onClick={() => pickTile(p.slug)}
              aria-pressed={selected}
              className={`relative rounded-xl border-2 p-4 text-center transition-all duration-150 ${
                selected
                  ? "border-[#00E2E5] bg-[#00E2E5]/5"
                  : "border-white/10 bg-white/[0.03] hover:border-white/30"
              }`}
            >
              <div className="text-2xl font-extrabold italic">
                {p.raceCount}
                <span className="text-sm font-bold not-italic">
                  {" "}
                  {t("racePack.picker.racesWord")}
                </span>
              </div>
              <div className="mt-1 text-[10px] font-extrabold uppercase tracking-[0.2em] text-white/45">
                {dayLabel(t, p)}
              </div>
              <div className="mt-1 text-xl font-extrabold tabular-nums">${p.price.toFixed(2)}</div>
              <div className="text-xs text-white/50">
                {t("racePack.build.perRace", { price: `$${(p.price / p.raceCount).toFixed(2)}` })}
              </div>
              <div className="mt-0.5 text-xs font-bold text-amber-400">
                {t("racePack.picker.save", { amount: `$${save.toFixed(2)}` })}
              </div>
              {p.dayType === "weekday" && (
                <div className="mt-0.5 text-[10px] text-white/40">
                  {t("racePack.picker.weekdayOnly")}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Multi-racer party: check off EVERYONE who gets this pack, one Add. */}
      {pendingSlug && eligible.length > 1 && (
        <div className="mt-3 rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 p-3">
          <div className="text-[11px] font-bold uppercase tracking-widest text-[#00E2E5]">
            {t("racePack.picker.whoFor")}{" "}
            <span className="font-semibold normal-case tracking-normal text-white/45">
              {t("racePack.picker.whoForHint")}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={toggleEveryone}
              aria-pressed={pendingIds.length === eligible.length}
              className={`rounded-full border border-dashed px-4 py-2 text-sm font-semibold transition-colors ${
                pendingIds.length === eligible.length
                  ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                  : "border-white/25 bg-white/5 text-white/70 hover:border-[#00E2E5] hover:text-white"
              }`}
            >
              {t("racePack.picker.everyone")}
            </button>
            {eligible.map((m) => {
              const on = pendingIds.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggleMember(m.id)}
                  aria-pressed={on}
                  className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                    on
                      ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                      : "border-white/20 bg-white/5 text-white/80 hover:border-[#00E2E5] hover:text-white"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`flex h-[18px] w-[18px] items-center justify-center rounded border text-[11px] font-black ${
                      on ? "border-[#00E2E5] bg-[#00E2E5] text-[#000418]" : "border-white/35"
                    }`}
                  >
                    {on ? "✓" : ""}
                  </span>
                  {m.firstName} {m.lastName ?? ""}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setPendingSlug(null)}
              className="rounded-lg px-3 py-2 text-sm font-semibold text-white/50 transition-colors hover:text-white"
            >
              {t("racePack.picker.cancel")}
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={applyDisabled}
              className="rounded-xl bg-[#00E2E5] px-5 py-2.5 text-sm font-extrabold text-[#000418] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {applyLabel}
            </button>
          </div>
        </div>
      )}

      {showAssignments && picks.length > 0 && (
        <div className="mt-3">
          <PackAssignmentList picks={picks} eligible={eligible} onChange={onChange} />
        </div>
      )}
    </div>
  );
}
