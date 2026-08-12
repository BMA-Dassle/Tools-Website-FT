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
 * SIZE and DAY TYPE are two questions, not six answers (owner 2026-08-03: the
 * 3×2 grid of near-identical cards was "excessive"). A day segment picks Mon–Thu
 * or Any-Day, then ONE row of size tiles prices that side of the catalog. On
 * Fri–Sun the weekday SKUs aren't offered at all, so the segment hides itself and
 * the row is simply the three Any-Day sizes. Everything is still catalog-derived:
 * the component renders whatever SKUs it is handed.
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
import { getRacePack, type RacePack, type RacePackDayType } from "~/features/booking/data/packs";
import { useT, type Translate } from "~/features/kiosk/i18n";

/** Savings baseline = the $26.99 single race (never fold the license in). */
export const SINGLE_RACE_BASELINE = 26.99;

export interface PackEligibleMember {
  id: string;
  firstName: string;
  lastName?: string;
  /** Racer tier. Gates tier-restricted SKUs (the BOGO adult/junior split);
   *  undefined reads as "adult", matching every other category read in the flow. */
  category?: "adult" | "junior";
  /** First-time racer. Gates returning-only SKUs (BOGO credit packs — new racers
   *  are offered the BOGO PACKAGE instead, which books both heats outright). */
  isNewRacer?: boolean;
}

/**
 * Can this pack land on this racer? Mirrors the fail-closed checks in
 * `resolveKioskPacks` — the server is the enforcement point, this keeps the
 * guest from ever building a selection it will refuse at payment.
 *
 * A pack with neither restriction (every standing 3/5/10 SKU) matches everyone,
 * so this is a no-op for them.
 */
export function packFitsMember(pack: RacePack, m: PackEligibleMember): boolean {
  if (pack.category && (m.category ?? "adult") !== pack.category) return false;
  if (pack.racerType === "existing" && m.isNewRacer) return false;
  return true;
}

/**
 * What the guest is actually saving, in dollars.
 *
 * Sale SKUs pin their own `regularPrice`; everything else compares against
 * `SINGLE_RACE_BASELINE`. That distinction is load-bearing, not cosmetic: the
 * baseline is the WEEKEND adult rate ($26.99), so running BOGO through it would
 * advertise a $32.99 saving on a deal that actually saves $20.99 — and $37.99 on
 * the junior SKU, which saves $15.99. Overstating a discount is the one thing
 * this page must never do.
 */
export function packSavings(pack: RacePack): number {
  if (typeof pack.regularPrice === "number") return pack.regularPrice - pack.price;
  return pack.raceCount * SINGLE_RACE_BASELINE - pack.price;
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
  ineligibleNames = [],
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
  /** Party members WITHOUT a racer account (web mixed party: packs grant onto
   *  a BMI account, so new racers can't hold one until they sign in as
   *  returning). Named in a hint so their absence from the chips doesn't read
   *  as a bug. */
  ineligibleNames?: string[];
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

  /**
   * Who the OPEN tile's pack may actually land on. A tier/history-restricted SKU
   * (the BOGO variants) narrows the checkbox row to matching racers, so the
   * guest can't build a selection `resolveKioskPacks` will refuse at payment —
   * the server stays the enforcement point, this just stops the dead end.
   * Unrestricted packs return the full list, unchanged.
   *
   * Declared as a plain function (hoisted) rather than a const arrow because
   * `toggleEveryone` below closes over it — a const would be in the temporal
   * dead zone for any earlier closure.
   */
  function assignableFor(slug: string | null): PackEligibleMember[] {
    const pack = slug ? getRacePack(slug) : null;
    return pack ? eligible.filter((m) => packFitsMember(pack, m)) : eligible;
  }

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
    const ids = assignableFor(pendingSlug).map((m) => m.id);
    setPendingIds((cur) => (cur.length === ids.length ? [] : ids));
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

  // Which day type the size row is pricing. Seeded from an existing pick so the
  // panel opens on what the guest already holds, else the cheapest side offered
  // (catalog order puts Mon–Thu first).
  const dayTypes = [...new Set(skus.map((p) => p.dayType))];
  const heldDay = picks.map((p) => getRacePack(p.slug)?.dayType).find(Boolean);
  const [day, setDay] = useState<RacePackDayType>(heldDay ?? dayTypes[0] ?? "anytime");
  // Hide a tier/history-restricted SKU when NOBODY in the party could receive
  // it — an all-adult party never sees the junior BOGO tile, and a party of
  // first-timers never sees the returning-only one. Without this the row grows
  // two near-identical "2 races" tiles that differ only by price, and half of
  // them refuse every racer on the panel.
  const shown = skus.filter((p) => p.dayType === day && eligible.some((m) => packFitsMember(p, m)));
  /** Racers the OPEN tile's pack can land on — the checkbox row's source. */
  const assignable = assignableFor(pendingSlug);

  return (
    <div>
      {ineligibleNames.length > 0 && (
        <p className="mb-2 text-xs leading-relaxed text-white/45">
          {t("racePack.picker.returningOnly", { names: ineligibleNames.join(" & ") })}
        </p>
      )}
      {dayTypes.length > 1 && (
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <div className="inline-flex gap-1 rounded-full border border-white/12 bg-white/[0.06] p-1">
            {dayTypes.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDay(d)}
                aria-pressed={day === d}
                className={`rounded-full px-4 py-1.5 text-sm font-bold transition-colors ${
                  day === d ? "bg-[#00E2E5] text-[#04252b]" : "text-white/60 hover:text-white"
                }`}
              >
                {d === "weekday" ? t("racePack.build.monThu") : t("racePack.build.anyDay")}
              </button>
            ))}
          </div>
          <span className="text-xs text-white/40">
            {day === "weekday"
              ? t("racePack.picker.dayNoteWeekday")
              : t("racePack.picker.dayNoteAny")}
          </span>
        </div>
      )}
      <div
        className={`grid gap-3 ${
          shown.length > 2
            ? "grid-cols-3"
            : shown.length === 2
              ? "grid-cols-2"
              : "mx-auto max-w-[320px] grid-cols-1"
        }`}
      >
        {shown.map((p) => {
          const holders = picks.filter((x) => x.slug === p.slug);
          const selected = holders.length > 0 || pendingSlug === p.slug;
          const save = packSavings(p);
          return (
            <button
              key={p.slug}
              type="button"
              onClick={() => pickTile(p.slug)}
              aria-pressed={selected}
              className={`relative rounded-xl border-2 px-3 text-center transition-all duration-150 ${
                p.badge ? "pb-2.5 pt-4" : "py-2.5"
              } ${
                selected
                  ? p.badge
                    ? "border-amber-400 bg-amber-400/10"
                    : "border-[#00E2E5] bg-[#00E2E5]/5"
                  : p.badge
                    ? "border-amber-400/60 bg-amber-400/5 hover:border-amber-400"
                    : "border-white/10 bg-white/[0.03] hover:border-white/30"
              }`}
            >
              {/* Sale ribbon. Amber, not the picker's cyan, so a limited-time
                  SKU is distinguishable at a glance from the standing packs —
                  the ONLY visual difference between them otherwise is price.
                  Copy goes through the catalog: `p.badge` is the registry's
                  English marker, never printed raw on a Spanish kiosk. */}
              {p.badge && (
                <span className="absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-amber-400 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] text-[#3d2600]">
                  {t("racePack.picker.flashSale")}
                </span>
              )}
              {/* Deliberately squat: this row has to fit under three product
                  cards without the body scrolling (owner 2026-08-04). Count and
                  price on one line, savings under it, per-race price dropped —
                  it said the same thing as the savings. */}
              <div className="flex items-baseline justify-center gap-2">
                <span className="text-2xl font-extrabold italic leading-none">{p.raceCount}</span>
                <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-white/45">
                  {t("racePack.picker.racesWord")}
                </span>
              </div>
              {/* Tier marker — only on a tier-restricted SKU. A mixed party sees
                  the adult AND junior BOGO tiles side by side, and they are
                  otherwise identical but for price. Standing packs carry no
                  category, so nothing changes for them. */}
              {p.category === "junior" && (
                <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/50">
                  {t("racePack.picker.juniorTier")}
                </div>
              )}
              <div className="mt-1 flex items-baseline justify-center gap-1.5 leading-tight">
                {typeof p.regularPrice === "number" && (
                  <span className="text-xs font-semibold tabular-nums text-white/40 line-through">
                    ${p.regularPrice.toFixed(2)}
                  </span>
                )}
                <span className="text-xl font-extrabold tabular-nums">${p.price.toFixed(2)}</span>
              </div>
              <div className="text-xs font-bold text-amber-400">
                {t("racePack.picker.save", { amount: `$${save.toFixed(2)}` })}
              </div>
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
              aria-pressed={pendingIds.length === assignable.length}
              className={`rounded-full border border-dashed px-4 py-2 text-sm font-semibold transition-colors ${
                pendingIds.length === assignable.length
                  ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                  : "border-white/25 bg-white/5 text-white/70 hover:border-[#00E2E5] hover:text-white"
              }`}
            >
              {t("racePack.picker.everyone")}
            </button>
            {assignable.map((m) => {
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
