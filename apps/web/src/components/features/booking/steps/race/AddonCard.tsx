"use client";

import type { BookingSession, RaceItem } from "~/features/booking";
import type { BookingAddon } from "~/features/booking/data/addon-catalog";
import { addonEligibleMembers } from "~/features/booking/service/addon-charge";
import { useT } from "~/features/kiosk/i18n";

/**
 * Name-chip "who's this for?" picker — shared by every card on the extras
 * step (headsock AND the video card, owner 2026-08-10: "I'd like these to
 * look similar to each other"). Pure UI: the caller owns the selection.
 */
export function NameChipPicker({
  members,
  selected,
  onToggle,
}: {
  members: Array<{ id: string; firstName: string; lastName?: string }>;
  selected: ReadonlySet<string>;
  onToggle: (memberId: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {members.map((m) => {
        const on = selected.has(m.id);
        const name = `${m.firstName} ${m.lastName ?? ""}`.trim();
        return (
          <button
            key={m.id}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(m.id)}
            className={`rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
              on
                ? "border-[#00E2E5]/40 bg-[#00E2E5]/15 text-[#00E2E5]"
                : "border-white/20 text-white/50 hover:border-white/40 hover:text-white"
            }`}
          >
            {on ? "✓ " : ""}
            {name}
          </button>
        );
      })}
    </div>
  );
}

/**
 * ONE add-on catalog entry as a card on the "Race Video & Extras" step
 * (below the POV card). Owner-approved mockup 2026-08-10 (rev 3):
 *   - per-racer attribution → "Who needs one?" name-chip picker; each
 *     selected racer = one unit at the catalog price, because fulfillment
 *     grants a Pandora credit on THAT racer's account.
 *   - Selection is OPTIONAL (variant A) — no forced yes/no; the rejected
 *     variant B gate would live in the parent step's canAdvance if revived.
 *
 * State written: `RaceItem.addonSelections` — pointers only ({slug,
 * memberIds}); the price re-derives from the catalog everywhere money moves.
 * Copy comes from the addons i18n fragment via `addon.i18nPrefix` (EN + ES).
 */
export function AddonCard({
  addon,
  item,
  session,
  onChange,
  compact = false,
}: {
  addon: BookingAddon;
  item: RaceItem;
  session: BookingSession;
  onChange: (patch: Partial<RaceItem>) => void;
  /** Kiosk fixed-canvas density — tighter paddings/type so the whole extras
   *  step fits without scrolling (owner 2026-08-10). */
  compact?: boolean;
}) {
  const t = useT();
  // Chips list ELIGIBLE racers only (has-license rule: a racer buying their
  // first license today gets a headsock with it) — the charge applies the
  // same filter, so the card and the money can't disagree.
  const members = addonEligibleMembers(addon, session.party);
  const selections = item.addonSelections ?? [];
  const selected = new Set(
    selections
      .find((s) => s.slug === addon.slug)
      ?.memberIds.filter((id) => members.some((m) => m.id === id)) ?? [],
  );
  const price = addon.priceCents / 100;
  // i18nPrefix keys are typed MessageKey values for the shipped catalog; the
  // cast keeps the catalog data-driven without widening useT's key union.
  const key = (suffix: string) => `${addon.i18nPrefix}.${suffix}` as Parameters<typeof t>[0];

  const toggle = (memberId: string) => {
    const next = new Set(selected);
    if (next.has(memberId)) next.delete(memberId);
    else next.add(memberId);
    // Party order for a stable pointer list (stable Square line order too).
    const memberIds = members.map((m) => m.id).filter((id) => next.has(id));
    onChange({
      addonSelections: [
        ...selections.filter((s) => s.slug !== addon.slug),
        { slug: addon.slug, memberIds },
      ],
    });
  };

  if (addon.attribution !== "per-racer") return null; // qty merch arrives with its first entry
  if (members.length === 0) return null; // nobody eligible (e.g. all-new party) — no card

  return (
    <div
      className={`${compact ? "space-y-3 p-4" : "space-y-4 p-5"} rounded-xl border transition-colors ${
        selected.size > 0 ? "border-[#00E2E5]/30 bg-[#00E2E5]/5" : "border-white/10 bg-white/[0.03]"
      }`}
    >
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-base font-bold text-white">{t(key("name"))}</h3>
          <span className="text-lg font-bold whitespace-nowrap text-[#00E2E5]">
            {t(key("priceEach"), { price: `$${price.toFixed(2)}` })}
          </span>
        </div>
        <p className={`${compact ? "text-xs" : "text-sm"} leading-relaxed text-white/50`}>
          {t(key("blurb"))}
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-bold tracking-widest text-white/40 uppercase">
          {t(key("pickerLabel"))}
        </p>
        <NameChipPicker members={members} selected={selected} onToggle={toggle} />
        {selected.size > 0 ? (
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-white/30">{t(key("perRacerHint"))}</span>
            <span className="text-lg font-bold text-[#00E2E5]">
              ${(price * selected.size).toFixed(2)}
            </span>
          </div>
        ) : (
          <p className="text-xs text-white/30">{t(key("perRacerHint"))}</p>
        )}
      </div>
    </div>
  );
}
