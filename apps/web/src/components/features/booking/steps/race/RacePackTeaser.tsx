"use client";

/**
 * KIOSK race-pack teaser — sits UNDER the premium packages (Rookie Pack) on the
 * race product step, same collapsed-teaser grammar (owner mockup 2026-07-18:
 * https://claude.ai/code/artifact/50e2252a-52ca-4363-9b4e-87e131e31bd0).
 *
 * Sells the CREDIT packs (3-race only on the kiosk; Mon–Thu hidden Fri–Sun —
 * `kioskPackSkus`). Selecting a tile assigns the pack to a racer: a one-person
 * party assigns implicitly; a bigger party gets "whose account?" chips. One
 * pack per racer (replace semantics). Selections are POINTERS on
 * `item.creditPacks` — all money re-derives server-side (race-pack-kiosk.ts).
 *
 * Renders nothing off-kiosk / with the kill switch off / in combo sessions.
 */
import { useState } from "react";
import type { BookingSession, RaceItem } from "~/features/booking";
import { kioskRacePacksEnabled, kioskPackSkus } from "~/features/booking/service/race-pack-kiosk";
import { activeComboSpecial } from "~/features/combos/combo-pricing";

/** Savings baseline = the $26.99 single race (never fold the license in). */
const SINGLE_RACE_BASELINE = 26.99;

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
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);

  if (!racePackTeaserVisible(session)) return null;
  const skus = kioskPackSkus();
  const eligible = session.party.filter((m) => !!m.bmiPersonId);

  const picks = item.creditPacks ?? [];
  const packFor = (memberId: string) => picks.find((p) => p.memberId === memberId);

  const assign = (slug: string, memberId: string) => {
    const cur = picks.filter((p) => p.memberId !== memberId);
    const existing = packFor(memberId);
    // Tapping the same pack for the same person removes it (toggle); a
    // different pack replaces it (one pack per racer — owner).
    const next = existing?.slug === slug ? cur : [...cur, { slug, memberId }];
    onChange({ creditPacks: next.length > 0 ? next : undefined });
    setPendingSlug(null);
  };

  const pickTile = (slug: string) => {
    if (eligible.length === 1) {
      assign(slug, eligible[0].id);
      return;
    }
    setPendingSlug((cur) => (cur === slug ? null : slug));
  };

  const cheapest = skus[0];
  const maxSave = Math.max(...skus.map((p) => p.raceCount * SINGLE_RACE_BASELINE - p.price));
  const nameOf = (memberId: string) => {
    const m = session.party.find((x) => x.id === memberId);
    return m ? `${m.firstName} ${m.lastName ?? ""}`.trim() : "";
  };

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
                      3<span className="text-sm font-bold not-italic"> RACES</span>
                    </div>
                    <div className="mt-1 text-[10px] font-extrabold uppercase tracking-[0.2em] text-white/45">
                      {p.dayType === "weekday" ? "Mon–Thu" : "Any Day"}
                    </div>
                    <div className="mt-1 text-xl font-extrabold tabular-nums">
                      ${p.price.toFixed(2)}
                    </div>
                    <div className="text-xs text-white/50">
                      ${(p.price / p.raceCount).toFixed(2)}/race
                    </div>
                    <div className="mt-0.5 text-xs font-bold text-amber-400">
                      Save ${save.toFixed(2)}
                    </div>
                    {p.dayType === "weekday" && (
                      <div className="mt-0.5 text-[10px] text-white/40">Mon–Thu visits only</div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Multi-racer party: the tapped tile needs an account to land on. */}
            {pendingSlug && eligible.length > 1 && (
              <div className="mt-3 rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 p-3">
                <div className="text-[11px] font-bold uppercase tracking-widest text-[#00E2E5]">
                  Whose account?
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {eligible.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => assign(pendingSlug, m.id)}
                      className="rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold text-white/80 transition-colors hover:border-[#00E2E5] hover:text-white"
                    >
                      {m.firstName} {m.lastName ?? ""}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Current assignments — tap × to remove. */}
            {picks.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {picks.map((p) => {
                  const sku = skus.find((s) => s.slug === p.slug);
                  return (
                    <div
                      key={`${p.memberId}-${p.slug}`}
                      className="flex items-center justify-between rounded-lg border border-[#00E2E5]/40 bg-[#00E2E5]/5 px-3 py-2 text-sm"
                    >
                      <span>
                        <span className="font-bold">{nameOf(p.memberId)}</span>
                        {" — 3 races · "}
                        {sku?.dayType === "weekday" ? "Mon–Thu" : "Any day"} · $
                        {(sku?.price ?? 0).toFixed(2)}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${nameOf(p.memberId)}'s race pack`}
                        onClick={() => assign(p.slug, p.memberId)}
                        className="ml-3 text-base leading-none text-white/50 transition-colors hover:text-red-300"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                <p className="text-xs text-white/45">
                  First credit covers today&rsquo;s race at checkout — the rest bank to their
                  account.
                </p>
              </div>
            )}

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
