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
import { findOffering, packageIdForCategory, raceItemFullyPackaged } from "~/features/booking";
import { ATTRACTIONS } from "~/features/booking/service/attractions";
import { getRaceProductById, type RaceProduct } from "~/features/booking/service/race-products";
import { LICENSE_PRICE, POV_PRICE } from "~/features/booking/service/race-pricing";
import { getPackage } from "~/features/booking/service/packages";
import { raceItemChargeLines } from "~/features/booking/service/checkout";
import { isBookableBowlingLeg } from "~/features/booking/service/bookable";
import { planVoucherCoverage, sessionVouchers } from "~/features/booking/service/voucher-redeem";
import { applyPromoToBillLines, promoFactor } from "~/features/booking/service/promo-pricing";
import {
  computePackCoverage,
  packSkusForRaceDate,
  kioskPacksTotalCents,
  kioskRacePacksEnabled,
  resolveKioskPacks,
  type KioskPackSelection,
} from "~/features/booking/service/race-pack-kiosk";
import { computeBogoScheduledFree } from "~/features/booking/service/bogo-scheduled";
import { redeemedHeatSet } from "~/features/booking/data/race-credits";
import { getBookingAddon } from "~/features/booking/data/addon-catalog";
import {
  estimateAddonsTotal,
  offerableAddonsForParty,
} from "~/features/booking/service/addon-charge";
import { getComboSpecial } from "~/features/combos/combo-specials";
import { getRaceSimProduct, getRaceSimTrack, raceSimPriceFor } from "~/features/race-sims/products";
import { resolveCartPurchase } from "~/features/game-cards/cart-purchase";
import { racerNeedsLicense } from "~/features/booking/service/license";
import { useT } from "~/features/kiosk/i18n";
import { racePackTeaserVisible } from "./steps/race/RacePackTeaser";
import { PackAssignmentList, RacePackPicker } from "./steps/race/RacePackPicker";
import { modalBackdropProps } from "@/lib/a11y";
/**
 * Session-level cart view.
 *
 * Renders the customer's current items and a Checkout CTA. Race items get a
 * structured preview pulled from RaceItem state (product registry name +
 * chosen track + per-heat racer assignments + estimated total) so the
 * customer can verify what's in their cart before paying — replaces the
 * generic "High-Speed Electric Racing" placeholder that just read offering
 * displayName.
 *
 * The "All activities" link kills the in-memory session, so it gates on a
 * confirmation modal when the cart has items (web); the kiosk passes
 * `onAllActivities` and goes straight back to its category chooser instead.
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
  /**
   * KIOSK: "← All activities" goes HERE directly — no leave-confirm modal, no
   * /book/v2 navigation (the kiosk's anchor guard blocks web links, which made
   * the modal's "Add more activities" a dead button — owner 2026-07-18). The
   * kiosk wires this to its category chooser; the session/cart is kept, exactly
   * like the web modal's "Add more activities" intent. Absent = web behavior
   * (confirm modal + landing link) unchanged.
   */
  onAllActivities?: () => void;
  /** KIOSK: remove the Game Zone cards riding this cart (session.gameCardPurchase). */
  onRemoveGameCards?: () => void;
  /**
   * KIOSK: edit a race item's credit-pack selections (`item.creditPacks`) from
   * the cart — add packs for racers who don't have one / remove one — without
   * re-entering the wizard (packs are session pointers; money re-derives
   * server-side at charge, so this is pure state — no vendor calls). Absent =
   * web behavior unchanged (the block never renders).
   */
  onUpdateRacePacks?: (itemId: string, creditPacks: KioskPackSelection[] | undefined) => void;
  /** KIOSK: drop a premium package off a race item, keeping the booking. */
  onRemovePackage?: (itemId: string, category: "adult" | "junior") => void;
  /** KIOSK: reopen the package screen for this item/category so the guest can
   *  swap bundles instead of removing one and rebuilding. */
  onChangePackage?: (itemId: string, category: "adult" | "junior") => void;
  /** KIOSK: the ONE edit affordance for everything on the extras step (video
   *  + headsock) — reopens that step, whose chip pickers add AND remove
   *  (owner 2026-08-10: one clearly-labeled "Change add-ons" button replaced
   *  the per-row Change/Remove pairs). Web hosts don't pass it. */
  onChangeAddons?: (itemId: string) => void;
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
  onAllActivities,
  onRemoveGameCards,
  onUpdateRacePacks,
  onRemovePackage,
  onChangePackage,
  onChangeAddons,
}: CartViewProps) {
  // Back-to-landing prefers the validated `appliedPromo.code` (set when the
  // code resolved + matched scope), falls back to the raw `?code=` from
  // the URL so a wrong-domain attempt still travels back to the landing.
  const backCode = session.appliedPromo?.code ?? urlCode ?? null;
  const backToLandingHref = backCode ? `/book/v2?code=${encodeURIComponent(backCode)}` : "/book/v2";

  const hasItems = session.items.length > 0;
  const unreadyItem = firstUnreadyItem(session);
  const [leaveConfirm, setLeaveConfirm] = useState(false);

  return (
    <section className="mx-auto max-w-2xl p-4 sm:p-6">
      <div className="mb-4">
        {onAllActivities ? (
          // Kiosk: straight back to the category chooser, session kept — no
          // modal, no web navigation.
          <button
            type="button"
            onClick={onAllActivities}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white/60 transition-colors hover:border-white/30 hover:text-white"
          >
            ← All activities
          </button>
        ) : hasItems ? (
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
      <CartComboBanner session={session} onRemoveCombo={onRemoveCombo} />

      {/* KIOSK: Game Zone cards riding this cart — paid with the deposit at
          checkout, dispensed/loaded on the confirmation screen. Web sessions
          never carry gameCardPurchase, so this renders nothing on web. */}
      <CartGameCardsBlock session={session} onRemoveGameCards={onRemoveGameCards} />

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
                onUpdateRacePacks={onUpdateRacePacks}
                onRemovePackage={onRemovePackage}
                onChangePackage={onChangePackage}
                onChangeAddons={onChangeAddons}
              />
            ))}
        </ul>
      )}

      {hasItems && (
        <div className="mt-8 flex justify-end">
          {/* An unfinished item doesn't dead-end the guest on a greyed-out
              button (a title tooltip is invisible on a kiosk touchscreen) — the
              button becomes the way BACK to the step that's missing. */}
          {unreadyItem ? (
            <button
              type="button"
              onClick={() => onEditItem(unreadyItem.id)}
              className="rounded-xl bg-[#00E2E5] px-8 py-3 text-sm font-bold text-[#000418] transition-colors hover:bg-white"
            >
              Finish setting up {otherItemTitle(unreadyItem)} →
            </button>
          ) : (
            <button
              type="button"
              onClick={onCheckout}
              className="rounded-xl bg-[#00E2E5] px-8 py-3 text-sm font-bold text-[#000418] transition-colors hover:bg-white"
            >
              Checkout →
            </button>
          )}
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

// ── Shared cart blocks (also composed by the kiosk merged checkout) ─────────

/** Combo-special banner — flat per-person pricing note + "Remove combo".
 *  Renders nothing when no combo is stamped on the session. */
export function CartComboBanner({
  session,
  onRemoveCombo,
}: {
  session: BookingSession;
  onRemoveCombo?: () => Promise<void> | void;
}) {
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
          {(combo.price.weekend / 100).toFixed(0)}/person Fri–Sun, applied at checkout (plus tax).
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
}

/** Game Zone cards riding this cart (kiosk-only session state) — line list +
 *  "paid with your booking" total + Remove. Renders nothing without a purchase
 *  (web sessions never carry one) or on bad pointers (the server rejects the
 *  charge in that case; the cart just shows without cards). */
export function CartGameCardsBlock({
  session,
  onRemoveGameCards,
}: {
  session: BookingSession;
  onRemoveGameCards?: () => void;
}) {
  if (!session.gameCardPurchase) return null;
  let gz: ReturnType<typeof resolveCartPurchase>;
  try {
    gz = resolveCartPurchase(session.gameCardPurchase);
  } catch {
    gz = null;
  }
  if (!gz) return null;
  return (
    <div
      className="mt-4 rounded-xl border p-3 text-sm"
      style={{ borderColor: "rgba(248,0,198,0.4)", backgroundColor: "rgba(7,16,39,0.5)" }}
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold" style={{ color: "#f800c6" }}>
          Game Zone cards
        </span>
        {onRemoveGameCards && (
          <button
            type="button"
            onClick={onRemoveGameCards}
            className="shrink-0 rounded-lg border border-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            Remove
          </button>
        )}
      </div>
      <ul className="mt-1.5 space-y-0.5 text-white/70">
        {gz.orderLines.map((l, i) => {
          const qty = Number(l.quantity) || 1;
          return (
            <li key={i} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">
                {l.name}
                {qty > 1 ? ` ×${qty}` : ""}
              </span>
              <span className="shrink-0 tabular-nums">
                ${((l.amountCents * qty) / 100).toFixed(2)}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-1.5 flex justify-between border-t border-white/10 pt-1.5 font-bold text-white">
        <span>Cards total — paid with your booking</span>
        <span className="tabular-nums">${(gz.totalCents / 100).toFixed(2)}</span>
      </div>
    </div>
  );
}

// ── Per-item cards ─────────────────────────────────────────────────────────

export function CartItemCard({
  item,
  session,
  onEdit,
  onRemove,
  onRemoveHeat,
  onUpdateRacePacks,
  onRemovePackage,
  onChangePackage,
  onChangeAddons,
}: {
  item: SessionItem;
  session: BookingSession;
  onEdit: () => void;
  onRemove: () => void;
  onRemoveHeat?: (itemId: string, productId: string, heatId: string) => void;
  onUpdateRacePacks?: (itemId: string, creditPacks: KioskPackSelection[] | undefined) => void;
  onRemovePackage?: (itemId: string, category: "adult" | "junior") => void;
  onChangePackage?: (itemId: string, category: "adult" | "junior") => void;
  onChangeAddons?: (itemId: string) => void;
}) {
  if (item.kind === "race") {
    return (
      <RaceCartCard
        item={item}
        session={session}
        onEdit={onEdit}
        onRemove={onRemove}
        onRemoveHeat={onRemoveHeat}
        onUpdateRacePacks={onUpdateRacePacks}
        onRemovePackage={onRemovePackage}
        onChangePackage={onChangePackage}
        onChangeAddons={onChangeAddons}
      />
    );
  }
  if (item.kind === "attraction") {
    return <AttractionCartCard item={item} session={session} onEdit={onEdit} onRemove={onRemove} />;
  }
  // Estimated total for bowling/kbf from enriched lineItems
  const bowlingEstimate = estimateCartItemTotal(item, session);

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
  onUpdateRacePacks,
  onRemovePackage,
  onChangePackage,
  onChangeAddons,
}: {
  item: RaceItem;
  session: BookingSession;
  onEdit: () => void;
  onRemove: () => void;
  onRemoveHeat?: (itemId: string, productId: string, heatId: string) => void;
  onUpdateRacePacks?: (itemId: string, creditPacks: KioskPackSelection[] | undefined) => void;
  /** KIOSK: drop a premium package (Rookie Pack / Ultimate Qualifier) off this
   *  item and keep the booking. Without it the cart's only undo is Remove, which
   *  deletes the whole race. Web hosts don't pass it (their guests can walk back
   *  to the product step freely). */
  onRemovePackage?: (itemId: string, category: "adult" | "junior") => void;
  onChangePackage?: (itemId: string, category: "adult" | "junior") => void;
  /** KIOSK: the ONE button for everything on the extras step (video +
   *  headsock): reopens that step, where chips toggle off = remove (owner
   *  2026-08-10: "combine add-ons into one change button and remove the
   *  remove button"). */
  onChangeAddons?: (itemId: string) => void;
}) {
  const t = useT();
  // Per-category packages (adult/junior variants are separate ids); `pkg` is
  // the shared display handle — every real family shares its display name +
  // extras flags across variants, so the first non-null one drives the card.
  const pkgAdult = getPackage(item.packageIdAdult);
  const pkgJunior = getPackage(item.packageIdJunior);
  const pkg = pkgAdult ?? pkgJunior;
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

  // Estimate — the SAME per-item charge builder the checkout uses (see
  // estimateCartItemTotal), so the cart total can NEVER drift from what
  // Square charges. Combo mode shows no per-item dollars (flat combo line).
  const newRacerCount = session.party.filter((m) => m.isNewRacer).length;
  const estimated = estimateCartItemTotal(item, session);

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
            {/* "Edit races", not "Edit" — the extras got their own clearly-
                labeled button below, so this one names its scope too (owner
                2026-08-10). On the kiosk it jumps to the race-picking step. */}
            {t("cart.editRaces")}
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

      {/* Heats — a single-category package shows one flat list; anything with
          both categories (mixed-party packages included) groups adult/junior */}
      {pkg && item.heats.length > 0 && (adultHeats.length === 0 || juniorHeats.length === 0) ? (
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
          {/* A partially-packaged item (e.g. adult bundle + junior singles)
              charges povQuantity too — same !raceItemFullyPackaged seam as
              checkout — so the POV row must render here as well, not only in
              the no-package branch below. */}
          {item.povQuantity > 0 && !raceItemFullyPackaged(item, session.party) && (
            <PovExtras item={item} />
          )}
          {/* Retail add-ons charge regardless of packaging (a headsock is never
              package-covered), so the rows show on packaged carts too. */}
          <AddonExtras item={item} session={session} />
          <ChangeAddonsButton item={item} session={session} onChangeAddons={onChangeAddons} />
          {/* Undo the bundle without losing the booking. One button per selected
              variant, because adult and junior are separate purchases — a family
              can drop the junior Rookie Pack and keep the adult one. */}
          {onRemovePackage &&
            (["adult", "junior"] as const).map((cat) => {
              const catPkg = cat === "adult" ? pkgAdult : pkgJunior;
              if (!catPkg) return null;
              const label =
                pkgAdult && pkgJunior
                  ? `${catPkg.name} (${cat === "adult" ? "Adult" : "Junior"})`
                  : catPkg.name;
              return (
                <div key={cat} className="mt-2 flex items-stretch gap-2">
                  {/* Change first: swapping bundles is the common intent, and
                      removing to rebuild was the only way to do it (owner
                      2026-08-04). It reopens the package screen for THIS
                      category with the current pick still selected. */}
                  {onChangePackage && (
                    <button
                      type="button"
                      onClick={() => onChangePackage(item.id, cat)}
                      className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-[#00E2E5]/40 px-3 py-2 text-[11px] font-semibold text-[#00E2E5] transition-colors hover:bg-[#00E2E5]/10"
                    >
                      {t("racePackage.change")}
                      <span aria-hidden>›</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemovePackage(item.id, cat)}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-[11px] font-semibold text-white/60 transition-colors hover:border-red-400/40 hover:text-red-300"
                  >
                    <span aria-hidden>✕</span>
                    {t("racePackage.remove", { name: label })}
                  </button>
                </div>
              );
            })}
        </div>
      ) : item.povQuantity > 0 ||
        item.addons.length > 0 ||
        (item.addonSelections?.some((s) => s.memberIds.length > 0) ?? false) ? (
        <div className="mt-3 space-y-1 border-t border-white/10 pt-3 text-xs">
          {item.povQuantity > 0 && <PovExtras item={item} />}
          {item.addons.map((a) => (
            <ExtraRow key={a.id} icon="➕" label={addonLabel(a)} amount={estimateAddon(a)} />
          ))}
          <AddonExtras item={item} session={session} />
          <ChangeAddonsButton item={item} session={session} onChangeAddons={onChangeAddons} />
        </div>
      ) : null}

      {/* Video & extras teaser (owner 2026-08-10, cart screenshot): a guest
          who skipped the extras step gets add buttons right here, mirroring
          the race-pack row below. Each button reopens the extras step — the
          purpose-built controls (capped stepper / who-picker) live there, and
          it's the wizard's last step so Continue lands back on this screen.
          Kiosk-only (needs onChangeAddons); hidden once both are in the cart
          — the single "Change add-ons" button above then owns the editing. */}
      {onChangeAddons &&
        !combo &&
        (() => {
          const povMissing = item.povQuantity === 0 && !raceItemFullyPackaged(item, session.party);
          // Party-aware: never tease an add-on nobody in this party can buy
          // (all-new party vs the headsock's has-license rule).
          const cartAddons = offerableAddonsForParty("race", item, session.party).filter(
            (a) => !item.addonSelections?.some((s) => s.slug === a.slug && s.memberIds.length > 0),
          );
          if (!povMissing && cartAddons.length === 0) return null;
          return (
            <div className="mt-3 border-t border-white/10 pt-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-bold tracking-wider text-[#00E2E5] uppercase">
                  {t("addons.cart.teaserEyebrow")}
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  {povMissing && (
                    <button
                      type="button"
                      onClick={() => onChangeAddons(item.id)}
                      className="rounded-lg border border-[#00E2E5]/40 px-3 py-1.5 text-xs font-semibold text-[#00E2E5] transition-colors hover:bg-[#00E2E5]/10"
                    >
                      {t("addons.cart.addVideo")}
                    </button>
                  )}
                  {cartAddons.map((a) => (
                    <button
                      key={a.slug}
                      type="button"
                      onClick={() => onChangeAddons(item.id)}
                      className="rounded-lg border border-[#00E2E5]/40 px-3 py-1.5 text-xs font-semibold text-[#00E2E5] transition-colors hover:bg-[#00E2E5]/10"
                    >
                      {t(`${a.i18nPrefix}.cart.add` as Parameters<typeof t>[0])}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}

      {/* Race packs on this booking — visible AND editable right here, so
          "the pack only landed on one racer" is a two-tap cart fix instead of a
          wizard re-entry (manager report 2026-07-27). Same gates as the product
          step's teaser. Web hosts pass the callback too since 2026-08-10
          (returning racers buy packs in the web flow now). */}
      {onUpdateRacePacks && !combo && racePackTeaserVisible(session, item.date) && (
        <RacePackCartBlock
          item={item}
          session={session}
          onChange={(packs) => onUpdateRacePacks(item.id, packs)}
        />
      )}

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

/**
 * KIOSK-only "Race packs" block on the cart's race card. Collapsed: the
 * assigned packs by name (with remove ×) + an add/edit button that names who's
 * still without one. Open: the same shared RacePackPicker the product step's
 * teaser uses (tiles + multi-select "who's this pack for?"). Pure session
 * state — the charge re-derives everything from the slugs at pay time.
 */
function RacePackCartBlock({
  item,
  session,
  onChange,
}: {
  item: RaceItem;
  session: BookingSession;
  onChange: (packs: KioskPackSelection[] | undefined) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const picks = item.creditPacks ?? [];
  const skus = packSkusForRaceDate(item.date);
  const eligible = session.party.filter((m) => !!m.bmiPersonId);
  const missing = eligible.filter((m) => !picks.some((p) => p.memberId === m.id));
  const missingNames = missing.map((m) => m.firstName).join(" & ");

  return (
    <div className="mt-3 border-t border-white/10 pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-bold tracking-wider uppercase text-amber-400">
          {t("racePack.cart.eyebrow")}
        </p>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs font-semibold text-amber-300 transition-colors hover:bg-amber-400/10"
        >
          {open
            ? t("racePack.cart.done")
            : picks.length > 0
              ? t("racePack.cart.addEdit")
              : t("racePack.cart.add")}
        </button>
      </div>

      {open ? (
        <div className="mt-3">
          {/* autoOpen: land straight on the "who's this pack for?" checkboxes —
              bare tiles with a collapsed selector read as a dead end here
              (owner preview feedback 2026-07-27). */}
          <RacePackPicker
            skus={skus}
            eligible={eligible}
            ineligibleNames={session.party.filter((m) => !m.bmiPersonId).map((m) => m.firstName)}
            picks={picks}
            onChange={onChange}
            autoOpen
          />
        </div>
      ) : picks.length > 0 ? (
        <div className="mt-2 space-y-2">
          <PackAssignmentList picks={picks} eligible={eligible} onChange={onChange} />
          {missing.length > 0 && (
            <p className="text-xs text-amber-300/80">
              {t("racePack.cart.missingLead", {
                names: missingNames,
                count: missing.length,
              })}{" "}
              <strong>{t("racePack.cart.addEdit")}</strong> {t("racePack.cart.missingTail")}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-xs text-white/45">{t("racePack.cart.blurb")}</p>
      )}
    </div>
  );
}

function AttractionCartCard({
  item,
  session,
  onEdit,
  onRemove,
}: {
  item: AttractionItem;
  session: BookingSession;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const config = item.slug ? ATTRACTIONS[item.slug] : null;
  const isPerPerson = config?.bookingMode === "per-person";
  // WHO is on this attraction. The kiosk collects a roster for waiver-gated
  // attractions (item.participants) but the card only ever showed a head count,
  // so the review screen couldn't answer "who's on it" (owner 2026-08-04).
  const participantNames = (item.participants ?? [])
    .map((id) => session.party.find((m) => m.id === id)?.firstName)
    .filter(Boolean)
    .join(" · ");

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

  const total = estimateCartItemTotal(item, session);

  return (
    <li className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-white">{title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-white/50">
            {dateLabel && <span>{dateLabel}</span>}
            {dateLabel && timeLabel && <span className="text-white/20">·</span>}
            {timeLabel && <span>{timeLabel}</span>}
            {isPerPerson && item.qty > 1 && !participantNames && (
              <>
                <span className="text-white/20">·</span>
                <span>{item.qty} people</span>
              </>
            )}
            {participantNames && (
              <>
                <span className="text-white/20">·</span>
                <span className="text-white/75">{participantNames}</span>
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

/** The standalone POV camera row — display only. All editing goes through the
 *  ONE "Change add-ons" button below the extras rows (owner 2026-08-10:
 *  per-row Change/Remove read as clutter; deselecting the chips on the extras
 *  step IS the remove). */
function PovExtras({ item }: { item: RaceItem }) {
  const t = useT();
  return (
    <ExtraRow
      icon="🎥"
      label={t("pov.cart.rowLabel", { count: item.povQuantity })}
      amount={POV_PRICE * item.povQuantity}
    />
  );
}

/** The ONE edit affordance for everything the extras step sells (video +
 *  headsock): reopens that step, where the chip pickers add AND remove.
 *  Kiosk-only (web hosts don't pass onChangeAddons). Rendered whenever any
 *  extras row is showing above it. */
function ChangeAddonsButton({
  item,
  session,
  onChangeAddons,
}: {
  item: RaceItem;
  session: BookingSession;
  onChangeAddons?: (itemId: string) => void;
}) {
  const t = useT();
  if (!onChangeAddons) return null;
  const hasPovRow = item.povQuantity > 0 && !raceItemFullyPackaged(item, session.party);
  const hasAddonRows = item.addonSelections?.some((s) => s.memberIds.length > 0) ?? false;
  if (!hasPovRow && !hasAddonRows) return null;
  return (
    <div className="mt-2 flex items-stretch gap-2">
      <button
        type="button"
        onClick={() => onChangeAddons(item.id)}
        className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-[#00E2E5]/40 px-3 py-2 text-[11px] font-semibold text-[#00E2E5] transition-colors hover:bg-[#00E2E5]/10"
      >
        {t("addons.cart.changeAddons")}
        <span aria-hidden>›</span>
      </button>
    </div>
  );
}

/** Retail add-on rows (data/addon-catalog.ts; v1 the replacement headsock) —
 *  ONE row per selected racer ("Replacement Headsock · Dana", same name the
 *  Square line carries). Display only — editing goes through the single
 *  "Change add-ons" button (ChangeAddonsButton). Invalid slugs / departed
 *  party members render nothing — the charge builder drops them identically. */
function AddonExtras({ item, session }: { item: RaceItem; session: BookingSession }) {
  const t = useT();
  const rows: Array<{
    slug: string;
    memberId: string;
    name: string;
    price: number;
    i18nPrefix: string;
  }> = [];
  for (const sel of item.addonSelections ?? []) {
    const addon = getBookingAddon(sel.slug);
    if (!addon) continue;
    for (const memberId of sel.memberIds) {
      const m = session.party.find((p) => p.id === memberId);
      if (!m) continue;
      rows.push({
        slug: sel.slug,
        memberId,
        name: `${m.firstName} ${m.lastName ?? ""}`.trim(),
        price: addon.priceCents / 100,
        i18nPrefix: addon.i18nPrefix,
      });
    }
  }
  if (rows.length === 0) return null;
  // Every shipped catalog entry has typed `${i18nPrefix}.cart.rowLabel` keys
  // (parts/addons.ts) — the cast keeps this data-driven for future merch.
  const rowKey = (prefix: string) => `${prefix}.cart.rowLabel` as Parameters<typeof t>[0];
  return (
    <>
      {rows.map((r) => (
        <div
          key={`${r.slug}:${r.memberId}`}
          className="flex items-baseline justify-between gap-2 text-white/70"
        >
          <span>
            <span className="mr-1.5">➕</span>
            {t(rowKey(r.i18nPrefix), { name: r.name })}
          </span>
          <span className="text-white/50">${r.price.toFixed(2)}</span>
        </div>
      ))}
    </>
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

/**
 * Per-item cart estimate in DOLLARS — the SAME charge builders checkout uses
 * (raceItemChargeLines + the promo factors), so a summed cart total can never
 * drift from what Square charges. Combo-priced items return 0: the combo's
 * flat per-person price is charged as ONE line at checkout (see
 * CartComboBanner), so per-item dollars would read as extra charges.
 *
 * Race math mirrors buildRaceChargeLines exactly: the package bundle line
 * already includes license + POV; single/combo add session license (new
 * racers with a heat, in categories without a package) + standalone POV +
 * add-ons on top. USA250-style promos reduce race lines AND the license/POV
 * add-ons (gated on the item's date); bowling lines reduce per line.
 */
export function estimateCartItemTotal(item: SessionItem, session: BookingSession): number {
  if (item.kind === "race") {
    if (session.comboSpecialId && getComboSpecial(session.comboSpecialId)) return 0;
    const racingIds = new Set(
      item.heats.filter((h) => h.heatId && h.assignedTo).map((h) => h.assignedTo!),
    );
    // Verified licence state — same helper the charge builder uses, so the
    // estimate can't quote a total the checkout won't charge.
    const nonPackageNewRacers = session.party.filter(
      (m) =>
        racerNeedsLicense(m) &&
        racingIds.has(m.id) &&
        !packageIdForCategory(item, m.category ?? "adult"),
    ).length;
    const raceAddonFactor = promoFactor(
      { domain: "racing", visitDate: item.date },
      session.appliedPromo,
    );
    const licenseTotal =
      Math.round(LICENSE_PRICE * nonPackageNewRacers * raceAddonFactor * 100) / 100;
    const standalonePov = raceItemFullyPackaged(item, session.party) ? 0 : item.povQuantity;
    const povTotal = Math.round(POV_PRICE * standalonePov * raceAddonFactor * 100) / 100;
    const addonsTotal = item.addons.reduce((sum, a) => sum + estimateAddon(a), 0);
    // Retail add-ons (headsock etc.) — the SAME catalog walk the charge lines
    // use (service/addon-charge.ts), promo-immune by design, so no factor.
    const retailAddonsTotal = estimateAddonsTotal(item, session);
    const raceLinesTotal = applyPromoToBillLines(
      raceItemChargeLines(item),
      session.appliedPromo,
    ).reduce((s, l) => s + l.amount, 0);
    // KIOSK credit packs riding this item: the pack price joins the estimate
    // and the heats it covers today come OFF it — mirroring CheckoutStep's
    // review lines (pack line + negative covered line) so the cart's Est.
    // total can't drift from the pay screen. Bad pointers → estimate shows
    // without packs, same as the review's fail-open.
    let packsTotal = 0;
    let packCoveredTotal = 0;
    if (kioskRacePacksEnabled() && (item.creditPacks?.length ?? 0) > 0) {
      try {
        const packs = resolveKioskPacks(item.creditPacks ?? [], session.party, {
          raceDate: item.date ?? null,
        });
        packsTotal = kioskPacksTotalCents(packs) / 100;
        const coverage = computePackCoverage(session, packs, redeemedHeatSet(session));
        if (coverage.heats.size > 0) {
          const sumLines = (ex?: Set<RaceHeatAssignment>) =>
            applyPromoToBillLines(raceItemChargeLines(item, ex), session.appliedPromo).reduce(
              (s, l) => s + l.amount,
              0,
            );
          packCoveredTotal = Math.round((sumLines() - sumLines(coverage.heats)) * 100) / 100;
        }
      } catch {
        /* unsellable slug / missing racer — reserve rejects the charge anyway */
      }
    }
    // BMI vouchers — the plan's comp-covered heats come off THIS item's
    // estimate the same way (differenced from the identical line builder the
    // charge uses; see voucher-redeem.ts). Credits + pack heats stay excluded
    // first so vouchers never double-count an already-$0 heat.
    let voucherCoveredTotal = 0;
    if (sessionVouchers(session).length > 0 && !session.comboSpecialId) {
      try {
        let base = redeemedHeatSet(session);
        if (kioskRacePacksEnabled() && (item.creditPacks?.length ?? 0) > 0) {
          const packs = resolveKioskPacks(item.creditPacks ?? [], session.party, {
            raceDate: item.date ?? null,
          });
          const cov = computePackCoverage(session, packs, base);
          if (cov.heats.size > 0) base = new Set([...base, ...cov.heats]);
        }
        const covered = planVoucherCoverage(session, base).raceHeats;
        if (covered.size > 0) {
          const sumLines = (ex: Set<RaceHeatAssignment>) =>
            applyPromoToBillLines(raceItemChargeLines(item, ex), session.appliedPromo).reduce(
              (s, l) => s + l.amount,
              0,
            );
          voucherCoveredTotal =
            Math.round((sumLines(base) - sumLines(new Set([...base, ...covered]))) * 100) / 100;
        }
      } catch {
        /* same fail-open as packs — the reserve is the enforcement point */
      }
    }
    // BOGO Wednesdays — every 2nd scheduled race free: the same rule the
    // charge builder prices with, differenced against THIS item's own lines
    // (the packs/vouchers pattern above), so the Est. total can't drift from
    // the pay screen. Same coverage order too: credits → packs → vouchers →
    // BOGO on the cash remainder.
    let bogoFreeTotal = 0;
    if (!session.comboSpecialId) {
      try {
        let base = redeemedHeatSet(session);
        if (kioskRacePacksEnabled() && (item.creditPacks?.length ?? 0) > 0) {
          const packs = resolveKioskPacks(item.creditPacks ?? [], session.party, {
            raceDate: item.date ?? null,
          });
          const cov = computePackCoverage(session, packs, base);
          if (cov.heats.size > 0) base = new Set([...base, ...cov.heats]);
        }
        if (sessionVouchers(session).length > 0) {
          const vHeats = planVoucherCoverage(session, base).raceHeats;
          if (vHeats.size > 0) base = new Set([...base, ...vHeats]);
        }
        const bogo = computeBogoScheduledFree(session.items, session.party, base);
        if (bogo.heats.size > 0) {
          const sumLines = (ex: Set<RaceHeatAssignment>) =>
            applyPromoToBillLines(raceItemChargeLines(item, ex), session.appliedPromo).reduce(
              (s, l) => s + l.amount,
              0,
            );
          bogoFreeTotal =
            Math.round((sumLines(base) - sumLines(new Set([...base, ...bogo.heats]))) * 100) / 100;
        }
      } catch {
        /* same fail-open — the reserve prices authoritatively */
      }
    }
    return (
      raceLinesTotal +
      packsTotal -
      packCoveredTotal -
      voucherCoveredTotal -
      bogoFreeTotal +
      licenseTotal +
      povTotal +
      addonsTotal +
      retailAddonsTotal
    );
  }
  if (item.kind === "attraction") {
    const config = item.slug ? ATTRACTIONS[item.slug] : null;
    const base = config?.bookingMode === "per-person" ? item.price * item.qty : item.price;
    // Attraction vouchers — the plan's covered units come off the matched item
    // (identical figures to the reserve's quantity reduction).
    if (!session.comboSpecialId && sessionVouchers(session).length > 0) {
      const plan = planVoucherCoverage(session, redeemedHeatSet(session));
      const units = plan.attractionUnits.get(item.id) ?? 0;
      if (units > 0) {
        const cents = plan.picks
          .filter((p) => p.attractionItemId === item.id)
          .reduce((s, p) => s + (p.attractionUnitCents ?? 0), 0);
        return Math.max(0, base - cents / 100);
      }
    }
    return base;
  }
  if (item.kind === "racesim") {
    // Same catalog + day-of-week helper the charge builder reads
    // (race-sims/products.ts), so the estimate can't drift from the charge.
    const product = getRaceSimProduct(item.productSlug);
    return product
      ? raceSimPriceFor(product) * Math.max(1, item.racerCount) * item.sessions.length
      : 0;
  }
  // bowling / kbf — combo bowling is charged inside the flat combo line.
  if (session.comboSpecialId && item.kind === "bowling") return 0;
  return (
    item.lineItems.reduce((s, li) => {
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
  );
}

export function allItemsReady(session: BookingSession): boolean {
  return session.items.every((item) => {
    switch (item.kind) {
      case "race":
        return item.heats.some((h) => h.heatId);
      case "attraction":
        return !!item.productId && !!item.slot;
      case "bowling":
      case "kbf":
        // A lane hold, or a picked slot (bookedAt + webOfferId). This used to be
        // a hardcoded `true` while race and attraction were both gated — so an
        // unconfigured bowling leg was the ONE thing that could reach the pay
        // screen. On 2026-07-28 one did: a duckpin draft with no time and no
        // offer priced at $0 (invisible in the cart total), passed this gate,
        // and 400'd QAMF *after* $234.21 was captured, taking a paid race
        // booking down with it.
        return isBookableBowlingLeg(item);
      case "racesim":
        // Slot required (attraction parity): a sim leg with no session time
        // must never reach the pay screen (the 2026-07-28 phantom-leg class).
        return !!item.productSlug && item.sessions.length > 0 && item.racerCount > 0;
    }
  });
}

/** The first cart item that isn't ready — what the pay button should send the
 *  guest back to finish. Null when everything is ready. */
export function firstUnreadyItem(session: BookingSession): SessionItem | null {
  return session.items.find((item) => !allItemsReady({ ...session, items: [item] })) ?? null;
}

function otherItemTitle(item: SessionItem): string {
  if (item.kind === "attraction" && item.slug) {
    return findOffering(item.slug)?.displayName ?? item.slug;
  }
  // FastTrax duckpin is a bowling item (QAMF 11542) but the guest tapped a tile
  // labelled "Duck Pin" — name it back the way they chose it.
  if (item.kind === "bowling" && item.isDuckpin) {
    return findOffering("duck-pin")?.displayName ?? "Duck Pin";
  }
  // Race Sims has no catalog offering (kiosk-owned tile) — findOffering misses.
  if (item.kind === "racesim") return "Race Sims";
  return findOffering(item.kind)?.displayName ?? item.kind;
}

/** Epoch ms for sorting cart items chronologically. Items without a
 *  resolved time sort last. */
export function itemSortMs(item: SessionItem): number {
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
    case "racesim": {
      const starts = item.sessions
        .map((s) => Date.parse(s.slot.replace(/Z$/, "")))
        .filter((n) => Number.isFinite(n));
      return starts.length ? Math.min(...starts) : FAR;
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
    case "racesim":
      return [
        fmtCartDate(item.date),
        ...[...item.sessions]
          .sort((a, b) => a.slot.localeCompare(b.slot))
          .map((s) =>
            `${fmtCartIsoTime(s.slot) ?? ""} ${getRaceSimTrack(s.trackKey)?.name ?? ""}`.trim(),
          ),
        `${item.racerCount} racer${item.racerCount === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join(" · ");
  }
}
