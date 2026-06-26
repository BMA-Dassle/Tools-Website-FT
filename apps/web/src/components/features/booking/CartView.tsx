"use client";

import Link from "next/link";
import { useState } from "react";
import type {
  AttractionItem,
  BookingSession,
  PartyMember,
  RaceHeatAssignment,
  RaceItem,
  SessionItem,
} from "~/features/booking";
import { findOffering } from "~/features/booking";
import { ATTRACTIONS } from "~/features/booking/service/attractions";
import { getRaceProductById, type RaceProduct } from "~/features/booking/service/race-products";
import { LICENSE_PRICE, POV_PRICE } from "~/features/booking/service/race-pricing";
import { getPackage } from "~/features/booking/service/packages";
import { raceItemChargeLines } from "~/features/booking/service/checkout";
import { applyPromoToBillLines, promoFactor } from "~/features/booking/service/promo-pricing";
import { getComboSpecial } from "~/features/combos/combo-specials";
import { modalBackdropProps } from "@/lib/a11y";
import { AdditionalActivities } from "./AdditionalActivities";

/**
 * Session-level cart view.
 *
 * Renders the customer's current items, the AdditionalActivities cross-sell,
 * and a Checkout CTA. Race items get a structured preview pulled from
 * RaceItem state (product registry name + chosen track + per-heat racer
 * assignments + estimated total) so the customer can verify what's in their
 * cart before paying — replaces the generic "High-Speed Electric Racing"
 * placeholder that just read offering displayName.
 *
 * The "All activities" link kills the in-memory session, so it gates on a
 * confirmation modal when the cart has items.
 */
export interface CartViewProps {
  session: BookingSession;
  urlCode?: string | null;
  onEditItem: (id: string) => void;
  onRemoveItem: (id: string) => void;
  /** Remove a single heat (all racer entries for that product + time) from a
   *  race item. Optional — only single races expose per-heat removal. */
  onRemoveHeat?: (itemId: string, productId: string, heatId: string) => void;
  onCheckout: () => void;
  /** Abandon the whole in-progress booking (release vendor holds + clear cart)
   *  and start fresh — wired to the leave modal's "Start new booking" action. */
  onNewBooking: () => Promise<void> | void;
  /** Remove the combo special as a UNIT (both seeded items + the stamp,
   *  vendor holds released). Shown on the combo banner. */
  onRemoveCombo?: () => Promise<void> | void;
}

export function CartView({
  session,
  urlCode,
  onEditItem,
  onRemoveItem,
  onRemoveHeat,
  onCheckout,
  onNewBooking,
  onRemoveCombo,
}: CartViewProps) {
  // Back-to-landing prefers the validated `appliedPromo.code` (set when the
  // code resolved + matched scope), falls back to the raw `?code=` from
  // the URL so a wrong-domain attempt still travels back to the landing.
  const backCode = session.appliedPromo?.code ?? urlCode ?? null;
  const backToLandingHref = backCode ? `/book/v2?code=${encodeURIComponent(backCode)}` : "/book/v2";

  const hasItems = session.items.length > 0;
  const [leaveConfirm, setLeaveConfirm] = useState(false);

  return (
    <section className="mx-auto max-w-2xl p-4 sm:p-6">
      <div className="mb-4">
        {hasItems ? (
          <button
            type="button"
            onClick={() => setLeaveConfirm(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white/60 transition-colors hover:border-white/30 hover:text-white"
          >
            ← All activities
          </button>
        ) : (
          <Link
            href={backToLandingHref}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white/60 transition-colors hover:border-white/30 hover:text-white"
          >
            ← All activities
          </Link>
        )}
      </div>
      <h1 className="text-2xl font-semibold text-white sm:text-3xl">Your cart</h1>

      {/* Combo special: the combo prices as ONE flat per-person line at
          checkout, and it leaves the cart as one unit too. */}
      {(() => {
        const combo = session.comboSpecialId ? getComboSpecial(session.comboSpecialId) : null;
        if (!combo) return null;
        return (
          <div
            className="mt-4 flex flex-col gap-3 rounded-xl border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            style={{ borderColor: combo.accentColor, backgroundColor: "rgba(7,16,39,0.5)" }}
          >
            <div>
              <span className="font-semibold" style={{ color: combo.accentColor }}>
                {combo.name}:
              </span>{" "}
              <span className="text-white/80">
                ${(combo.price.weekday / 100).toFixed(0)}/person Mon–Thu · $
                {(combo.price.weekend / 100).toFixed(0)}/person Fri–Sun, applied at checkout (plus
                tax).
              </span>
            </div>
            {onRemoveCombo && (
              <button
                type="button"
                onClick={() => void onRemoveCombo()}
                className="shrink-0 self-start rounded-lg border border-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400 sm:self-auto"
              >
                Remove combo
              </button>
            )}
          </div>
        );
      })()}

      {session.items.length === 0 ? (
        <p className="mt-6 text-sm text-white/50">No items yet.</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {[...session.items]
            .sort((a, b) => itemSortMs(a) - itemSortMs(b))
            .map((item) => (
              <CartItemCard
                key={item.id}
                item={item}
                session={session}
                onEdit={() => onEditItem(item.id)}
                onRemove={() => onRemoveItem(item.id)}
                onRemoveHeat={onRemoveHeat}
              />
            ))}
        </ul>
      )}

      {hasItems && (
        <div className="mt-8 flex justify-end">
          <button
            type="button"
            onClick={onCheckout}
            disabled={!allItemsReady(session)}
            title={
              !allItemsReady(session) ? "Finish configuring all items before checkout" : undefined
            }
            className="rounded-xl bg-[#00E2E5] px-8 py-3 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Checkout →
          </button>
        </div>
      )}

      {leaveConfirm && (
        <LeaveConfirmModal
          backHref={backToLandingHref}
          onCancel={() => setLeaveConfirm(false)}
          onNewBooking={onNewBooking}
        />
      )}
    </section>
  );
}

/**
 * Leave-confirmation modal — shown before navigating away from an in-progress
 * booking. Offers three intents:
 *   - Keep editing  → dismiss, stay on the current step (default; guards against
 *     an accidental "All activities" click losing the cart).
 *   - Add more activities → go to the landing keeping the session; the customer
 *     adds another activity via the "Add to your visit" bar (session lives in
 *     sessionStorage), then returns to checkout.
 *   - New booking   → abandon this one: `onNewBooking` releases the early-created
 *     vendor holds (BMI reservation + any QAMF hold) and clears the cart, so a
 *     contact-first booking never orphans a live reservation. Framed as starting
 *     fresh rather than "cancel" per product direction.
 */
export function LeaveConfirmModal({
  backHref,
  onCancel,
  onNewBooking,
}: {
  backHref: string;
  onCancel: () => void;
  onNewBooking: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);

  // onNewBooking navigates away on success; if it returns without navigating
  // (e.g. a release error), clear busy so the customer isn't stuck on a spinner.
  const handleNewBooking = async () => {
    setBusy(true);
    try {
      await onNewBooking();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      {...modalBackdropProps(busy ? () => {} : onCancel)}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 p-6"
        style={{ backgroundColor: "#0a1128" }}
      >
        <h3 className="font-display text-xl tracking-widest text-white uppercase">
          Leave your booking?
        </h3>
        <p className="mt-2 text-sm text-white/60">
          Add more activities and pick up where you left off, or start a new booking — which
          releases the spots you&apos;re currently holding.
        </p>
        <div className="mt-5 space-y-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="w-full rounded-xl bg-[#00E2E5] px-4 py-2.5 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Keep editing
          </button>
          <div className="flex gap-3">
            <Link
              href={backHref}
              aria-disabled={busy}
              tabIndex={busy ? -1 : undefined}
              className={`flex-1 rounded-xl border border-white/20 px-4 py-2.5 text-center text-sm font-semibold text-white/70 transition-colors hover:border-white/40 hover:text-white ${
                busy ? "pointer-events-none opacity-40" : ""
              }`}
            >
              Add more activities
            </Link>
            <button
              type="button"
              onClick={handleNewBooking}
              disabled={busy}
              className="flex-1 rounded-xl border border-amber-400/40 px-4 py-2.5 text-sm font-semibold text-amber-300 transition-colors hover:bg-amber-400/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Starting…" : "New booking"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Per-item cards ─────────────────────────────────────────────────────────

function CartItemCard({
  item,
  session,
  onEdit,
  onRemove,
  onRemoveHeat,
}: {
  item: SessionItem;
  session: BookingSession;
  onEdit: () => void;
  onRemove: () => void;
  onRemoveHeat?: (itemId: string, productId: string, heatId: string) => void;
}) {
  if (item.kind === "race") {
    return (
      <RaceCartCard
        item={item}
        session={session}
        onEdit={onEdit}
        onRemove={onRemove}
        onRemoveHeat={onRemoveHeat}
      />
    );
  }
  if (item.kind === "attraction") {
    return <AttractionCartCard item={item} onEdit={onEdit} onRemove={onRemove} />;
  }
  // Estimated total for bowling/kbf from enriched lineItems
  const bowlingEstimate =
    item.kind === "bowling" || item.kind === "kbf"
      ? item.lineItems.reduce((s, li) => {
          // USA250: reduce priced bowling lines so the cart matches checkout.
          const full = (li.priceCents ?? 0) * li.quantity;
          const f =
            (li.priceCents ?? 0) > 0
              ? promoFactor(
                  { domain: "bowling", visitDate: item.date ?? item.bookedAt?.slice(0, 10) },
                  session.appliedPromo,
                )
              : 1;
          return s + (f === 1 ? full : Math.round(full * f));
        }, 0) /
          100 +
        (item.hasBookingFee ? 2.99 : 0)
      : 0;

  // Combo bowling is configured by the combo wizard (its own steps are
  // hidden) and is charged inside the flat combo line — no Edit, no per-item
  // estimate; Remove removes the whole combo (BookingFlow delegates).
  const isComboBowling = !!session.comboSpecialId && item.kind === "bowling";

  return (
    <li className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm transition-colors hover:border-white/20">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-white">{otherItemTitle(item)}</div>
          <div className="mt-0.5 text-xs text-white/40">{otherItemSummary(item)}</div>
        </div>
        <div className="flex shrink-0 gap-2">
          {!isComboBowling && (
            <button
              type="button"
              onClick={onEdit}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            className="rounded-lg border border-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            {isComboBowling ? "Remove combo" : "Remove"}
          </button>
        </div>
      </div>
      {bowlingEstimate > 0 && !isComboBowling && (
        <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3 text-sm">
          <span className="text-xs uppercase tracking-wider text-white/40">Est. total</span>
          <span className="font-bold text-[#00E2E5]">${bowlingEstimate.toFixed(2)}</span>
        </div>
      )}
    </li>
  );
}

function RaceCartCard({
  item,
  session,
  onEdit,
  onRemove,
  onRemoveHeat,
}: {
  item: RaceItem;
  session: BookingSession;
  onEdit: () => void;
  onRemove: () => void;
  onRemoveHeat?: (itemId: string, productId: string, heatId: string) => void;
}) {
  const pkg = item.packageId ? getPackage(item.packageId) : null;
  const adultProduct = item.productIdAdult ? getRaceProductById(item.productIdAdult) : null;
  const juniorProduct = item.productIdJunior ? getRaceProductById(item.productIdJunior) : null;

  // A racer can book multiple heats across products/tracks (the multi-race
  // loop), and the item only remembers the LAST productIdAdult/Junior — so we
  // group heats by the assigned racer's category, not by a single product id
  // (which would drop heats picked on a different product/track).
  const adultRacerIds = new Set(
    session.party.filter((m) => (m.category ?? "adult") === "adult").map((m) => m.id),
  );
  const juniorRacerIds = new Set(
    session.party.filter((m) => m.category === "junior").map((m) => m.id),
  );
  const adultHeats = item.heats.filter((h) => h.assignedTo && adultRacerIds.has(h.assignedTo));
  const juniorHeats = item.heats.filter((h) => h.assignedTo && juniorRacerIds.has(h.assignedTo));

  // Per-heat removal is offered only for single races; combos/packages keep
  // their fixed bundle of heats, so removing one would break the pack.
  const heatRemover =
    !pkg && !(adultProduct?.raceCount || juniorProduct?.raceCount) && onRemoveHeat
      ? (productId: string, heatId: string) => onRemoveHeat(item.id, productId, heatId)
      : undefined;

  const dateLabel = item.date
    ? new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
    : null;

  // Combo special: the flat per-person price covers the races, license and
  // POV — the banner above the cart carries the pricing, so the card shows
  // "included" rows and NO per-item dollars (a $9.99 license+POV estimate
  // here read as an extra charge).
  const combo = session.comboSpecialId ? getComboSpecial(session.comboSpecialId) : null;

  // Estimate — use the SAME per-item charge builder the checkout uses
  // (raceItemChargeLines: package bundle / combo pack / single), so the cart
  // total can NEVER drift from what Square charges. The package bundle line
  // already includes license + POV; single/combo add session license (new
  // racers) + standalone POV + add-ons on top.
  const newRacerCount = session.party.filter((m) => m.isNewRacer).length;
  const licenseTotal = LICENSE_PRICE * newRacerCount;
  const povTotal = POV_PRICE * item.povQuantity;
  const addonsTotal = item.addons.reduce((sum, a) => sum + estimateAddon(a), 0);

  // USA250: reduce race lines (they carry domain/visitDate) so the cart
  // estimate matches what checkout charges. License/POV/add-ons stay full price.
  const raceLinesTotal = applyPromoToBillLines(
    raceItemChargeLines(item),
    session.appliedPromo,
  ).reduce((s, l) => s + l.amount, 0);
  const estimated = combo
    ? 0
    : pkg
      ? raceLinesTotal + addonsTotal
      : raceLinesTotal + licenseTotal + povTotal + addonsTotal;

  return (
    <li className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm">
      {/* Header: race title + edit/remove */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-white">
            {pkg ? pkg.name : raceTitle(item, adultProduct, juniorProduct)}
          </h3>
          {dateLabel && <p className="mt-0.5 text-xs text-white/50">{dateLabel}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-lg border border-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            Remove
          </button>
        </div>
      </div>

      {/* Heats — package shows all heats; individual races group by category */}
      {pkg && item.heats.length > 0 ? (
        <div className="mt-3 space-y-2">
          <HeatGroup label="Heats" heats={item.heats} party={session.party} accent="cyan" />
        </div>
      ) : adultHeats.length > 0 || juniorHeats.length > 0 ? (
        <div className="mt-3 space-y-2">
          {adultHeats.length > 0 && (
            <HeatGroup
              label={juniorHeats.length > 0 ? "Adult heats" : "Heats"}
              heats={adultHeats}
              party={session.party}
              accent="cyan"
              onRemove={heatRemover}
            />
          )}
          {juniorHeats.length > 0 && (
            <HeatGroup
              label={adultHeats.length > 0 ? "Junior heats" : "Heats"}
              heats={juniorHeats}
              party={session.party}
              accent="amber"
              onRemove={heatRemover}
            />
          )}
        </div>
      ) : null}

      {/* Extras */}
      {combo ? (
        <div className="mt-3 space-y-1 border-t border-white/10 pt-3 text-xs">
          {combo.includesLicense && newRacerCount > 0 && (
            <ExtraRow icon="✓" label="Racing License included" amount={null} />
          )}
          {combo.includedPovPerRacer > 0 && (
            <ExtraRow
              icon="✓"
              label={`POV Race Video included${item.povQuantity > 1 ? ` × ${item.povQuantity}` : ""}`}
              amount={null}
            />
          )}
          {item.addons.map((a) => (
            <ExtraRow key={a.id} icon="➕" label={addonLabel(a)} amount={estimateAddon(a)} />
          ))}
        </div>
      ) : pkg ? (
        <div className="mt-3 space-y-1 border-t border-white/10 pt-3 text-xs">
          {pkg.includesLicense && (
            <ExtraRow icon="✓" label="Racing License included" amount={null} />
          )}
          {pkg.includesPov && <ExtraRow icon="✓" label="POV Race Video included" amount={null} />}
          {pkg.appetizerCode && (
            <>
              <ExtraRow
                icon="✓"
                label={`Free Appetizer at Nemo's (${pkg.appetizerNote ?? "1 per group"})`}
                amount={null}
              />
              {pkg.appetizerItems && (
                <div className="ml-6 space-y-0 text-[11px] text-white/40">
                  {pkg.appetizerItems.map((mi) => (
                    <div key={mi}>· {mi}</div>
                  ))}
                </div>
              )}
            </>
          )}
          {item.addons.map((a) => (
            <ExtraRow key={a.id} icon="➕" label={addonLabel(a)} amount={estimateAddon(a)} />
          ))}
        </div>
      ) : item.povQuantity > 0 || item.rookiePack === true || item.addons.length > 0 ? (
        <div className="mt-3 space-y-1 border-t border-white/10 pt-3 text-xs">
          {item.rookiePack === true && (
            <ExtraRow icon="🎁" label={`Rookie Pack × ${newRacerCount}`} amount={null} />
          )}
          {item.povQuantity > 0 && !item.rookiePack && (
            <ExtraRow
              icon="🎥"
              label={`POV Camera × ${item.povQuantity}`}
              amount={POV_PRICE * item.povQuantity}
            />
          )}
          {item.addons.map((a) => (
            <ExtraRow key={a.id} icon="➕" label={addonLabel(a)} amount={estimateAddon(a)} />
          ))}
        </div>
      ) : null}

      {/* Estimated total */}
      {estimated > 0 && (
        <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3 text-sm">
          <span className="text-xs uppercase tracking-wider text-white/40">Est. total</span>
          <span className="font-bold text-[#00E2E5]">${estimated.toFixed(2)}</span>
        </div>
      )}

      {/* Empty-state nudge: race added but nothing picked yet */}
      {!adultProduct && !juniorProduct && item.heats.length === 0 && (
        <p className="mt-3 text-xs text-amber-300/80">
          Click <strong>Edit</strong> to pick your race details.
        </p>
      )}
    </li>
  );
}

function AttractionCartCard({
  item,
  onEdit,
  onRemove,
}: {
  item: AttractionItem;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const config = item.slug ? ATTRACTIONS[item.slug] : null;
  const isPerPerson = config?.bookingMode === "per-person";

  const product = config?.products.find((p) => p.productId === item.productId);
  const title = product?.name ?? findOffering(item.slug ?? "")?.displayName ?? "Attraction";

  const dateLabel = item.date
    ? new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
    : null;

  const timeLabel = item.slot
    ? new Date(item.slot.replace(/Z$/, "")).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : null;

  const total = isPerPerson ? item.price * item.qty : item.price;

  return (
    <li className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-white">{title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-white/50">
            {dateLabel && <span>{dateLabel}</span>}
            {dateLabel && timeLabel && <span className="text-white/20">·</span>}
            {timeLabel && <span>{timeLabel}</span>}
            {isPerPerson && item.qty > 1 && (
              <>
                <span className="text-white/20">·</span>
                <span>{item.qty} people</span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-lg border border-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            Remove
          </button>
        </div>
      </div>

      {total > 0 && (
        <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3 text-sm">
          <span className="text-xs uppercase tracking-wider text-white/40">Est. total</span>
          <span className="font-bold text-[#00E2E5]">${total.toFixed(2)}</span>
        </div>
      )}

      {!item.productId && (
        <p className="mt-3 text-xs text-amber-300/80">
          Click <strong>Edit</strong> to pick your activity details.
        </p>
      )}
    </li>
  );
}

function HeatGroup({
  label,
  heats,
  party,
  accent,
  onRemove,
}: {
  label: string;
  heats: RaceHeatAssignment[];
  party: PartyMember[];
  accent: "cyan" | "amber";
  onRemove?: (productId: string, heatId: string) => void;
}) {
  // Dedup by product + heatId — state stores one entry per racer × heat, and a
  // racer can hold the same time on different products/tracks (multi-race).
  const byHeat = new Map<string, RaceHeatAssignment[]>();
  for (const h of heats) {
    if (!h.heatId) continue;
    const key = `${h.productId ?? ""}|${h.heatId}`;
    const list = byHeat.get(key) ?? [];
    list.push(h);
    byHeat.set(key, list);
  }
  const sorted = Array.from(byHeat.values()).sort((a, b) =>
    (a[0].heatId ?? "").localeCompare(b[0].heatId ?? ""),
  );
  const labelColor = accent === "cyan" ? "text-[#00E2E5]" : "text-amber-400";

  return (
    <div>
      <p className={`mb-1 text-[10px] font-bold tracking-wider uppercase ${labelColor}`}>{label}</p>
      <ul className="space-y-1 text-xs">
        {sorted.map((entries) => {
          const first = entries[0];
          const heatId = first.heatId!;
          const productId = first.productId;
          const time = formatHeatTime(heatId);
          const track = first.track ?? null;
          const racers = entries
            .map((e) => party.find((m) => m.id === e.assignedTo)?.firstName)
            .filter((n): n is string => !!n);
          return (
            <li
              key={`${productId ?? ""}|${heatId}`}
              className="flex items-baseline justify-between gap-2 rounded-md bg-white/[0.02] px-2.5 py-1.5"
            >
              <span className="text-white/80">
                {time}
                {track && <span className="ml-1.5 text-white/40">· {track} Track</span>}
              </span>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="text-white/50">
                  {racers.length > 0 ? racers.join(", ") : "Unassigned"}
                </span>
                {onRemove && productId && (
                  <button
                    type="button"
                    onClick={() => onRemove(productId, heatId)}
                    aria-label={`Remove ${time} heat`}
                    className="rounded px-1 leading-none text-white/30 transition-colors hover:text-red-400"
                  >
                    ✕
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ExtraRow({ icon, label, amount }: { icon: string; label: string; amount: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-white/70">
      <span>
        <span className="mr-1.5">{icon}</span>
        {label}
      </span>
      {amount !== null && <span className="text-white/50">${amount.toFixed(2)}</span>}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function raceTitle(
  item: RaceItem,
  adultProduct: RaceProduct | null,
  juniorProduct: RaceProduct | null,
): string {
  const trackOf = (track: string | null | undefined) => (track ? ` (${track})` : "");
  const adultLabel = adultProduct
    ? `${adultProduct.name}${trackOf(item.productTrackAdult ?? adultProduct.track)}`
    : null;
  const juniorLabel = juniorProduct
    ? `${juniorProduct.name}${trackOf(item.productTrackJunior ?? juniorProduct.track)}`
    : null;
  if (adultLabel && juniorLabel) return `${adultLabel} + ${juniorLabel}`;
  if (adultLabel) return adultLabel;
  if (juniorLabel) return juniorLabel;
  return findOffering("race")?.displayName ?? "Race";
}

function formatHeatTime(iso: string): string {
  const clean = iso.replace(/Z$/, "");
  return new Date(clean).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// Add-on price estimates — uses the same prices the AddonsStep displays.
// Source-of-truth pricing comes from BMI overview at checkout, but the
// estimate is close enough for cart preview.
const ADDON_ESTIMATES: Record<string, { name: string; price: number }> = {
  "27488020": { name: "FT Shuffly Combo", price: 10 },
  "23345635": { name: "Duckpin Bowling", price: 35 },
  "27488200": { name: "Gel Blaster", price: 10 },
  "8976685": { name: "Laser Tag", price: 10 },
};

function addonLabel(a: { id: string; qty: number }): string {
  const meta = ADDON_ESTIMATES[a.id];
  const name = meta?.name ?? `Add-on ${a.id}`;
  return a.qty > 1 ? `${name} × ${a.qty}` : name;
}

function estimateAddon(a: { id: string; qty: number }): number {
  const meta = ADDON_ESTIMATES[a.id];
  return (meta?.price ?? 0) * a.qty;
}

function allItemsReady(session: BookingSession): boolean {
  return session.items.every((item) => {
    switch (item.kind) {
      case "race":
        return item.heats.some((h) => h.heatId);
      case "attraction":
        return !!item.productId && !!item.slot;
      case "bowling":
      case "kbf":
        return true;
    }
  });
}

function otherItemTitle(item: SessionItem): string {
  if (item.kind === "attraction" && item.slug) {
    return findOffering(item.slug)?.displayName ?? item.slug;
  }
  return findOffering(item.kind)?.displayName ?? item.kind;
}

/** Epoch ms for sorting cart items chronologically. Items without a
 *  resolved time sort last. */
function itemSortMs(item: SessionItem): number {
  const FAR = Number.MAX_SAFE_INTEGER;
  switch (item.kind) {
    case "race": {
      const starts = item.heats
        .map((h) => (h.heatId ? Date.parse(h.heatId.replace(/Z$/, "")) : NaN))
        .filter((n) => Number.isFinite(n));
      return starts.length ? Math.min(...starts) : FAR;
    }
    case "attraction":
      return item.slot ? Date.parse(item.slot.replace(/Z$/, "")) || FAR : FAR;
    case "bowling":
    case "kbf": {
      if (item.bookedAt) return Date.parse(item.bookedAt.replace(/Z$/, "")) || FAR;
      if (item.date && item.hour != null) {
        return Date.parse(`${item.date}T${String(item.hour % 24).padStart(2, "0")}:00:00`) || FAR;
      }
      return FAR;
    }
    default:
      return FAR;
  }
}

function fmtCartDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtCartTime(hour: number | null, minute: number | null): string | null {
  if (hour == null) return null;
  const m = minute ?? 0;
  const ampm = hour % 24 >= 12 ? "PM" : "AM";
  const hr = hour % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

function fmtCartIsoTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso.replace(/Z$/, "")).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function otherItemSummary(item: SessionItem): string {
  switch (item.kind) {
    case "race":
      return "";
    case "attraction":
      return [
        fmtCartDate(item.date),
        fmtCartIsoTime(item.slot),
        `${item.qty} ${item.qty === 1 ? "person" : "people"}`,
      ]
        .filter(Boolean)
        .join(" · ");
    case "bowling":
      return [
        fmtCartDate(item.date),
        fmtCartTime(item.hour, item.minute),
        `${item.laneCount} lane${item.laneCount === 1 ? "" : "s"}`,
        item.playerCount > 0
          ? `${item.playerCount} bowler${item.playerCount === 1 ? "" : "s"}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "kbf":
      return [
        fmtCartDate(item.date),
        fmtCartTime(item.hour, item.minute),
        `${item.bowlers.length} bowler${item.bowlers.length === 1 ? "" : "s"}`,
        item.paidAdults > 0 ? `${item.paidAdults} adult${item.paidAdults === 1 ? "" : "s"}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  }
}
