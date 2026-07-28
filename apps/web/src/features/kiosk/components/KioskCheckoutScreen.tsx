"use client";

/**
 * Kiosk merged cart + checkout — ONE "review your order" screen (owner
 * 2026-07-21) replacing the separate "Your cart" and "Checkout — contact
 * confirm" screens. Contact is already captured at player-add on the kiosk,
 * so the old contact step was pure re-confirmation; folding it in here frees
 * the post-"Review & Pay" slot for the checkout upsell page.
 *
 * Composition, not reimplementation: the order list reuses CartView's exact
 * blocks (CartComboBanner / CartGameCardsBlock / CartItemCard) inside a
 * .kiosk-zoom wrapper, and the pinned EST. TOTAL sums the same
 * estimateCartItemTotal / comboChargeLines / resolveCartPurchase math the
 * checkout charges from — display can't drift from the charge. Layout is the
 * house k-flow shell: header + scrolling body + pinned action bar, so the
 * pay CTA always sits in the reach band (never the zoom-center hack the old
 * two screens needed). No promo code input by owner decision (2026-07-21) —
 * web checkout keeps it; the pricing seams stay so it can return as a
 * drop-in.
 */

import type { Dispatch } from "react";
import type { Action } from "~/features/booking/state/machine";
import type { BookingSession } from "~/features/booking";
import type { KioskPackSelection } from "~/features/booking/service/race-pack-kiosk";
import {
  CartComboBanner,
  CartGameCardsBlock,
  CartItemCard,
  allItemsReady,
  estimateCartItemTotal,
  itemSortMs,
} from "~/components/features/booking/CartView";
import { contactIsComplete } from "~/components/features/booking/steps/ContactStep";
import { activeComboSpecial, comboChargeLines } from "~/features/combos/combo-pricing";
import { resolveCartPurchase } from "~/features/game-cards/cart-purchase";
import { KioskBookingAsCard } from "./KioskBookingAsCard";
import { KioskRewardsSection } from "./KioskRewardsSection";
import { BrandLogo } from "./BrandLogo";
import { useT } from "../i18n";

export function KioskCheckoutScreen({
  session,
  dispatch,
  brand,
  center,
  onEditItem,
  onRemoveItem,
  onRemoveHeat,
  onRemoveCombo,
  onRemoveGameCards,
  onAllActivities,
  onReviewAndPay,
  onUpdateRacePacks,
}: {
  session: BookingSession;
  dispatch: Dispatch<Action>;
  brand: "fasttrax" | "headpinz";
  center: "fort-myers" | "naples";
  onEditItem: (id: string) => void;
  onRemoveItem: (id: string) => void;
  onRemoveHeat?: (itemId: string, productId: string, heatId: string) => void;
  onRemoveCombo?: () => Promise<void> | void;
  onRemoveGameCards?: () => void;
  onAllActivities: () => void;
  onReviewAndPay: () => void;
  onUpdateRacePacks?: (itemId: string, creditPacks: KioskPackSelection[] | undefined) => void;
}) {
  const t = useT();
  const items = [...session.items].sort((a, b) => itemSortMs(a) - itemSortMs(b));

  // EST. TOTAL — the same builders checkout charges from. Per-item estimates
  // are 0 in combo mode by design (flat per-person pricing), so the combo's
  // own charge lines fill that in; Game Zone cards ride the deposit untaxed.
  const gz = (() => {
    try {
      return resolveCartPurchase(session.gameCardPurchase);
    } catch {
      return null;
    }
  })();
  const comboEstimate = activeComboSpecial(session)
    ? (comboChargeLines(session) ?? []).reduce((s, l) => s + l.amount, 0)
    : 0;
  // A selected reward tier reduces the charge (CheckoutStep nets it the same
  // way) — the displayed estimate must drop with it or the tier tap reads as
  // a no-op.
  const rewardDiscount = (session.loyalty?.selectedRewardTier?.discountCents ?? 0) / 100;
  const estTotal = Math.max(
    0,
    items.reduce((s, i) => s + estimateCartItemTotal(i, session), 0) +
      comboEstimate +
      (gz?.totalCents ?? 0) / 100 -
      rewardDiscount,
  );
  // Coupon savings — the estimate builders above already price WITH the
  // applied code (promoFactor runs inside them), so the guest-visible saving
  // is the same math re-run WITHOUT the code, minus the discounted figure.
  // Display-only; the charge derives its own numbers server-side.
  const promo = session.appliedPromo ?? null;
  const promoSavings = (() => {
    if (!promo) return 0;
    const bare = { ...session, appliedPromo: null };
    const undiscounted =
      items.reduce((s, i) => s + estimateCartItemTotal(i, bare), 0) +
      (activeComboSpecial(bare)
        ? (comboChargeLines(bare) ?? []).reduce((s, l) => s + l.amount, 0)
        : 0);
    const discounted =
      items.reduce((s, i) => s + estimateCartItemTotal(i, session), 0) + comboEstimate;
    return Math.max(0, undiscounted - discounted);
  })();

  const itemsReady = items.length > 0 && allItemsReady(session);
  const contactOk = contactIsComplete(session.contact);

  return (
    <>
      <div className="k-flow-head">
        <div className="k-fh-top">
          <BrandLogo brand={brand} className="h-[60px] w-auto" />
          <span className="k-fh-activity">{t("checkout.eyebrow")}</span>
        </div>
        <h1 className="k-display k-fh-title">{t("checkout.title")}</h1>
      </div>

      <div className="k-flow-body">
        <div className="mx-auto w-full max-w-[880px] space-y-[28px] pb-[24px]">
          {items.length === 0 ? (
            <div className="k-glass p-[44px] text-center text-[30px] text-white/60">
              {t("checkout.empty")}
            </div>
          ) : (
            // CartView's own cards, web-rem sized → zoomed to kiosk scale.
            <div className="kiosk-step-content kiosk-zoom">
              <CartComboBanner session={session} onRemoveCombo={onRemoveCombo} />
              <CartGameCardsBlock session={session} onRemoveGameCards={onRemoveGameCards} />
              <ul className="mt-4 space-y-3">
                {items.map((item) => (
                  <CartItemCard
                    key={item.id}
                    item={item}
                    session={session}
                    onEdit={() => onEditItem(item.id)}
                    onRemove={() => onRemoveItem(item.id)}
                    onRemoveHeat={onRemoveHeat}
                    onUpdateRacePacks={onUpdateRacePacks}
                  />
                ))}
              </ul>
            </div>
          )}

          {items.length > 0 && (
            <>
              <KioskBookingAsCard session={session} dispatch={dispatch} />
              <KioskRewardsSection
                session={session}
                dispatch={dispatch}
                center={center}
                estTotal={estTotal}
              />
              {!itemsReady && (
                <p className="text-center text-[24px] text-white/45">{t("checkout.finishFirst")}</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Two-row action zone (owner 7/21: total + CTA in one row squeezed the
          button into a two-line wrap): estimate on its own right-aligned line,
          full-width no-wrap CTA under it. */}
      <div className="k-z-actions">
        <div className="flex w-full flex-col gap-[16px]">
          {items.length > 0 && promo && promoSavings > 0.004 && (
            <div className="flex items-baseline justify-end pr-[8px]">
              <span className="k-display text-[24px] text-[#e8b14c]">
                {t("checkout.codeSavings", {
                  code: promo.code,
                  amount: `$${promoSavings.toFixed(2)}`,
                })}
              </span>
            </div>
          )}
          {items.length > 0 && (
            <div className="flex items-baseline justify-end gap-[14px] pr-[8px]">
              <span className="text-[23px] font-bold uppercase tracking-[0.16em] text-white/45">
                {t("checkout.estTotal")}
              </span>
              <span className="k-num text-[48px] font-extrabold leading-none text-[#00e2e5]">
                ${estTotal.toFixed(2)}
              </span>
              <span className="text-[22px] text-white/35">{t("checkout.plusTax")}</span>
            </div>
          )}
          <div className="flex items-center gap-[24px]">
            <button type="button" onClick={onAllActivities} className="k-btn-ghost k-tap">
              ← {t("checkout.allActivities")}
            </button>
            {items.length > 0 && (
              <button
                type="button"
                onClick={onReviewAndPay}
                disabled={!itemsReady || !contactOk}
                className="k-btn-primary k-tap whitespace-nowrap"
              >
                {t("checkout.reviewAndPay")} →
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
