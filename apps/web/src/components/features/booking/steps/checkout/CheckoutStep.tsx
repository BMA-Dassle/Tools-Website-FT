"use client";

import { useEffect, useRef, useState } from "react";
import type { Dispatch } from "react";
import { clarityEvent, clarityTag } from "~/lib/clarity";
import type { Action } from "~/features/booking/state/machine";
import type { BookingSession, BowlingItem, KbfItem, RaceItem } from "~/features/booking";
import type { ContactInfo } from "~/features/booking/types";
import {
  runCheckout,
  recordClickwrap,
  saveBookingDetails,
  resolveSquareCustomer,
  buildConfirmationUrl,
  reserveBooking,
  reserveAll,
  rebuildRaceBillIfExpired,
  applyCreditRedemptionsToOverview,
  type BillOverview,
} from "~/features/booking/service/checkout";
import {
  memberEligibleCreditTotal,
  memberEligibleBreakdown,
  creditBalancesFromDeposits,
} from "~/features/booking/data/race-credits";
import {
  bowlingReserve,
  bowlingTerminalPrepare,
  buildBowlingQuoteLineItems,
} from "~/features/booking/service/bowling";
import { applyPromoToAmount } from "~/features/booking/service/promo-pricing";
import { calculateTax } from "~/features/booking/service/race-pricing";
import { activeComboSpecial } from "~/features/combos/combo-pricing";
import {
  KBF_GAMES_PER_SESSION,
  kbfAdultGamesTotalCents,
  kbfVipUpchargeTotalCents,
  isFridayYmd,
} from "~/features/booking/service/kbf-pricing";
import { clearBookingSession } from "~/features/booking/hooks";
import PaymentForm, { type PaymentResult } from "@/components/square/PaymentForm";
import type { SavedCard } from "@/components/square/SavedCardSelector";
import ClickwrapCheckbox from "@/components/booking/ClickwrapCheckbox";
import { LoyaltySection } from "./LoyaltySection";
import { PromoCodeInput } from "./PromoCodeInput";
import {
  sessionVouchers,
  voucherDisplayName,
  voucherRedeemEnabled,
  voucherReviewLines,
} from "~/features/booking/service/voucher-redeem";
import { contactIsComplete } from "../ContactStep";
import { kioskGzCartEnabled } from "~/features/kiosk/flags";
import { playNowActive } from "~/features/booking/flags";
import { resolveCartPurchase } from "~/features/game-cards/cart-purchase";
import { centerCodeFor } from "~/config/intercard-centers";
import {
  qamfCenterCode,
  HEADPINZ_FM_CENTER_ID,
  HEADPINZ_FM_CENTER_CODE,
  isFastTraxDuckpinCenter,
} from "@/lib/qamf-centers";
import { stashGzFulfillment as stashKioskGameCards } from "~/features/kiosk/service/gz-fulfillment";
import { stashRacePackConfirmation } from "~/features/kiosk/service/race-pack-confirmation";
import { stashPovConfirmation } from "~/features/kiosk/service/pov-confirmation";
import { stashVipVoucherConfirmation } from "~/features/kiosk/service/vip-voucher-confirmation";
import { stashKioskHasRacing } from "~/features/kiosk/service/racing-confirmation";
import {
  kioskRacePacksEnabled,
  resolveKioskPacks,
  computePackCoverage,
} from "~/features/booking/service/race-pack-kiosk";
import { buildRaceChargeLines } from "~/features/booking/service/checkout";
import { redeemedHeatSet } from "~/features/booking/data/race-credits";
import type { RaceHeatAssignment } from "~/features/booking";
import dynamic from "next/dynamic";

// Kiosk direct-Terminal charge gate (owner: NO saved card). Dynamically imported
// so the kiosk feature isn't bundled into the web checkout and there's no
// booking↔kiosk import cycle.
const KioskTerminalCheckoutGate = dynamic(
  () =>
    import("~/features/kiosk/components/KioskTerminalCheckoutGate").then(
      (m) => m.KioskTerminalCheckoutGate,
    ),
  { ssr: false },
);

interface CheckoutStepProps {
  session: BookingSession;
  dispatch: Dispatch<Action>;
  onBack: () => void;
  /** Abandon the booking: release vendor holds + clear the cart, then leave. */
  onStartOver: () => void | Promise<void>;
  /**
   * Post-payment navigation override. Default = window.location.href (the web
   * confirmation pages). The KIOSK passes a mapper that wraps the same URL in
   * /kiosk/confirmation so guests never leave the kiosk shell.
   */
  navigate?: (url: string) => void;
  /**
   * Card-on-file surfaces (saved-card list + "save this card" consent).
   * Default true (web). The kiosk passes FALSE — a shared public device must
   * never show or store anyone's card.
   */
  allowCardVault?: boolean;
  /** sessionStorage key to clear after a successful reserve (kiosk uses its own). */
  storageKey?: string;
  /**
   * Kiosk card-present: when set (device cardInputMethod "reader"/"swipe"),
   * the paying phase captures the card on this Square reader (SAVE_CARD) and
   * charges it through the SAME reserve rail as a saved card — instead of the
   * typed-card iframe.
   */
  readerDeviceId?: string | null;
  /**
   * Kiosk: hide HeadPinz/FastTrax Rewards — loyalty is handled at the Square
   * reader, not on the kiosk (owner 2026-07-18). Web default = shown.
   */
  hideRewards?: boolean;
  /** Kiosk: hide Apple/Google Pay (shared public device). Web default = shown. */
  hideWallets?: boolean;
  /**
   * KIOSK merged cart+checkout: the merged screen already confirmed the
   * contact (and rewards/promo), so skip the contact phase entirely — mount
   * straight into booking with session.contact and land on review. Review's
   * "Back" then returns to the caller (onBack → the merged screen) instead of
   * the contact phase. Web default = false (contact phase unchanged).
   */
  skipContactPhase?: boolean;
}

type Phase =
  | { step: "contact" }
  | { step: "booking"; progress: string }
  | { step: "review"; overview: BillOverview; bmiBillId: string }
  | {
      step: "paying";
      overview: BillOverview;
      // The FULL-PRICE review overview (before per-racer credit redemption is
      // applied). Kept so a "back"/cancel from payment restores review to its
      // un-redeemed base — the review render re-derives credit $0 lines from the
      // LIVE toggle each render, and applyCreditRedemptionsToOverview only ADDS
      // credit lines (it can't strip them). If we restored the credit-APPLIED
      // overview here instead, a later UNCHECK could never undo the credit.
      reviewOverview: BillOverview;
      bmiBillId: string;
      squareCustomerId?: string;
      savedCards?: SavedCard[];
    }
  | { step: "confirming"; bmiBillId: string }
  | { step: "error"; message: string }
  // Charged via /api/square/pay but NO reservation was made (should be
  // unreachable — see handlePaymentSuccess). Never offer Retry here: the
  // customer's money is already taken and retrying double-charges them.
  | { step: "paid-unconfirmed"; amount: number };

function formatTime(iso: string): string {
  const clean = iso.replace(/Z$/, "");
  return new Date(clean).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function CheckoutStep({
  session,
  dispatch,
  onBack,
  onStartOver,
  navigate,
  allowCardVault = true,
  storageKey,
  readerDeviceId,
  hideRewards = false,
  hideWallets = false,
  skipContactPhase = false,
}: CheckoutStepProps) {
  // Post-payment redirect — kiosk overrides this to stay inside /kiosk.
  const go =
    navigate ??
    ((url: string) => {
      window.location.href = url;
    });
  const [phase, setPhase] = useState<Phase>(() =>
    // Merged kiosk checkout skips the contact phase: mount on the booking
    // spinner (the auto-submit effect below runs the actual submit). Falls
    // back to the contact form when the contact is somehow incomplete.
    skipContactPhase && contactIsComplete(session.contact)
      ? { step: "booking", progress: "Preparing your order…" }
      : { step: "contact" },
  );
  const [clickwrapAccepted, setClickwrapAccepted] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Microsoft Clarity funnel milestones for the checkout phases. The "confirmed"
  // outcome is tagged on the confirmation page (see ClarityAnalytics).
  useEffect(() => {
    if (phase.step === "review") clarityEvent("checkout:review");
    else if (phase.step === "paying") clarityEvent("checkout:payment");
    else if (phase.step === "confirming") clarityEvent("checkout:submitting");
    else if (phase.step === "error") {
      clarityTag("checkout_error", phase.message?.slice(0, 60) || "unknown");
      clarityEvent("checkout:error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.step]);

  // Contact form local state — pre-fill from session.contact
  const [firstName, setFirstName] = useState(session.contact.firstName ?? "");
  const [lastName, setLastName] = useState(session.contact.lastName ?? "");
  const [email, setEmail] = useState(session.contact.email ?? "");
  const [phone, setPhone] = useState(session.contact.phone ?? "");
  const [smsOptIn, setSmsOptIn] = useState(session.contact.smsOptIn ?? true);
  // We've usually already collected contact in the wizard, so on checkout we
  // COLLAPSE it to a summary (expand to edit) and lead with HeadPinz Rewards.
  // Start expanded only when we don't yet have complete contact.
  const [editingContact, setEditingContact] = useState(() => !contactIsComplete(session.contact));

  const contact: ContactInfo = { firstName, lastName, email, phone, smsOptIn };

  // ── Race-credit redemption (per-racer) ──────────────────────────
  // Returning racers / linked family (bmiPersonId && !isNewRacer) pay for their
  // heats with their OWN race credits (non-transferable). Defaults ON when a
  // racer has eligible credits; PARTIAL is allowed — a racer with fewer credits
  // than heats redeems what they have and pays cash for the rest.
  const raceItem = session.items.find((i): i is RaceItem => i.kind === "race") ?? null;
  const raceDate = raceItem?.date ?? null;

  // Combo special active: the session charges the flat combo price (one line,
  // built inside buildRaceChargeLines). The bowling item's own line items are
  // suppressed from the review (the charge path suppresses them identically in
  // buildCombinedLineItems), and race-credit redemption is hidden — credits
  // don't combine with the flat price.
  const comboActive = activeComboSpecial(session) != null;

  const heatCountForMember = (memberId: string): number => {
    let n = 0;
    for (const it of session.items) {
      if (it.kind !== "race") continue;
      for (const h of it.heats) if (h.assignedTo === memberId) n += 1;
    }
    return n;
  };

  // personId -> redeem-with-credits opt-in. Default ON: pre-enable each eligible
  // racer so their credits apply automatically (they can untick it). At charge time
  // their heats are covered by combining their eligible credits in priority order
  // (Membership → Weekday → Anytime → Comp; see race-credits.ts).
  const [creditChoices, setCreditChoices] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    if (comboActive) return init; // flat combo price — no credit redemption
    for (const m of session.party) {
      if (!m.bmiPersonId || m.isNewRacer) continue;
      if (heatCountForMember(m.id) <= 0) continue;
      if (memberEligibleCreditTotal(m.creditBalances, raceDate) > 0) init[m.bmiPersonId] = true;
    }
    return init;
  });

  const creditEligible = comboActive
    ? []
    : session.party
        .filter((m) => m.bmiPersonId && !m.isNewRacer)
        .map((m) => ({
          member: m,
          heats: heatCountForMember(m.id),
          available: memberEligibleCreditTotal(m.creditBalances, raceDate),
          breakdown: memberEligibleBreakdown(m.creditBalances, raceDate),
        }))
        .filter((e) => e.heats > 0 && e.available > 0);

  // Party + session carrying each racer's opt-in, threaded into the reserve calls.
  // Heats of a member with redeemCredits are covered by their combined eligible
  // credits (priority order) — charged $0 by Square, one credit deducted each.
  const partyWithChoices = session.party.map((m) => ({
    ...m,
    redeemCredits: !!(m.bmiPersonId && creditChoices[m.bmiPersonId]),
  }));
  const sessionForReserve: BookingSession = { ...session, party: partyWithChoices };

  function toggleCredit(personId: string, on: boolean) {
    setCreditChoices((prev) => {
      const next = { ...prev };
      if (on) next[personId] = true;
      else delete next[personId];
      return next;
    });
  }

  // Live credit-balance refresh at checkout (owner 2026-07-19: kiosk checkout
  // offered no credits option): members can arrive with MISSING or STALE
  // creditBalances — the kiosk's linked-family add never fetches them, and
  // credits granted earlier the same visit (a race pack) postdate the sign-in
  // snapshot. The charge path validates LIVE balances, so the display reads
  // them too. One sweep per mount; every failure is soft (the capture-time
  // snapshot stands — same as today).
  const creditRefreshDone = useRef(false);
  // personIds whose redeem opt-in was already defaulted ON (mount initializer
  // or this sweep) — an untick must stick, so each pid is seeded at most once.
  const creditSeeded = useRef<Set<string> | null>(null);
  if (creditSeeded.current === null) creditSeeded.current = new Set(Object.keys(creditChoices));
  useEffect(() => {
    if (creditRefreshDone.current || !raceItem || comboActive) return;
    creditRefreshDone.current = true;
    const seeded = creditSeeded.current;
    const members = session.party.flatMap((m) =>
      m.bmiPersonId && !m.isNewRacer && heatCountForMember(m.id) > 0
        ? [{ id: m.id, pid: m.bmiPersonId }]
        : [],
    );
    void Promise.allSettled(
      members.map(async ({ id, pid }) => {
        const res = await fetch(
          `/api/bmi-office?action=deposits&personId=${encodeURIComponent(pid)}`,
        );
        if (!res.ok) return;
        const fresh = creditBalancesFromDeposits(await res.json());
        dispatch({ type: "updatePartyMember", id, patch: { creditBalances: fresh } });
        // Newly eligible → default their opt-in ON (the creditChoices mount
        // initializer ran before this fetch landed).
        if (seeded && !seeded.has(pid) && memberEligibleCreditTotal(fresh, raceDate) > 0) {
          seeded.add(pid);
          setCreditChoices((prev) => ({ ...prev, [pid]: true }));
        }
      }),
    );
  });

  const isValidContact =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    email.includes("@") &&
    phone.replace(/\D/g, "").length >= 10;

  // ── Contact phase ─────────────────────────────────────────────

  const hasBmi = session.items.some((i) => i.kind === "race" || i.kind === "attraction");

  async function handleContactSubmit() {
    if (!isValidContact) return;
    dispatch({ type: "setContact", patch: contact });
    setPhase({ step: "booking", progress: "Preparing your order…" });

    try {
      // Step 1: Book BMI heats (if any race/attraction items)
      let bmiBillId: string | null = null;
      let bmiOverview: BillOverview | null = null;
      if (hasBmi) {
        setPhase({ step: "booking", progress: "Booking activities…" });
        const result = await runCheckout(session, contact, dispatch, (msg) =>
          setPhase({ step: "booking", progress: msg }),
        );
        bmiBillId = result.bmiBillId;
        bmiOverview = result.overview;
      }

      // Step 2: Build combined review from all items with schedule info
      setPhase({ step: "booking", progress: "Calculating your total…" });
      const reviewLines: BillOverview["lines"] = [];

      // Bowling line items — include bookedAt time. In combo mode the combo
      // line (inside bmiOverview, via buildRaceChargeLines) is the whole
      // race+bowl charge, so the bowling items are NOT separately listed —
      // identical suppression to buildCombinedLineItems (booking fee stays).
      for (const item of session.items) {
        if (item.kind !== "bowling" && item.kind !== "kbf") continue;
        const bowlVisitDate = item.date ?? item.bookedAt?.slice(0, 10) ?? undefined;
        for (const li of comboActive ? [] : item.lineItems) {
          const fullAmount = ((li.priceCents ?? 0) * li.quantity) / 100;
          // USA250: reduce the displayed bowling line so it matches the charge
          // (buildCombinedLineItems / the reused quote both reduce the same way).
          const promo = applyPromoToAmount(
            fullAmount,
            { domain: "bowling", visitDate: bowlVisitDate },
            session.appliedPromo,
          );
          reviewLines.push({
            name: li.label ?? `Item #${li.squareProductId}`,
            quantity: li.quantity,
            amount: promo.amount,
            time: item.bookedAt ?? undefined,
            ...(promo.applied
              ? {
                  originalAmount: promo.originalAmount,
                  promoPct: session.appliedPromo?.amountPct ?? undefined,
                }
              : {}),
          });
        }
        // Combo special is all-inclusive at the flat per-person price (no
        // separate booking fee) — the split day-of orders don't add one, so
        // the review mustn't either (displayed == charged).
        if (item.hasBookingFee && !comboActive) {
          reviewLines.push({ name: "Booking Fee", quantity: 1, amount: 2.99 });
        }
        // KBF extras the server charges but item.lineItems (free games) don't
        // carry: the VIP lane upcharge ($2/free bowler) and per-game adult fees.
        // Computed from the SAME kbf-pricing helpers the reserve route uses, so
        // the displayed total matches the charge. See kbf-pricing.ts.
        if (item.kind === "kbf") {
          const isVip = item.tier === "vip";
          const ymd = item.date ?? item.bookedAt?.slice(0, 10) ?? "";
          const friday = ymd ? isFridayYmd(ymd) : false;
          const freeBowlerCount = item.bowlers.length;
          const vipUpchargeCents = kbfVipUpchargeTotalCents(freeBowlerCount, isVip);
          if (vipUpchargeCents > 0) {
            reviewLines.push({
              name: "VIP Lane",
              quantity: freeBowlerCount,
              amount: vipUpchargeCents / 100,
            });
          }
          const adultGamesCents = kbfAdultGamesTotalCents(item.paidAdults, isVip, friday);
          if (adultGamesCents > 0) {
            reviewLines.push({
              name: `Adult Games${isVip ? " (VIP)" : ""}`,
              quantity: item.paidAdults * KBF_GAMES_PER_SESSION,
              amount: adultGamesCents / 100,
            });
          }
        }
      }

      // Attractions are NOT added from the cart here: they book onto the SAME
      // BMI bill as races, so they already appear in `bmiOverview.lines` below
      // (with the BMI product name + slot time). Adding them from the cart too
      // double-counted them on the review (the "Shuffly listed twice" bug).
      // Bowling/KBF are QAMF-vendored — NOT on the BMI bill — so they still come
      // from the cart loop above.

      // BMI line items (from the overview — races + license + attractions, each
      // already carrying its heat/slot time).
      if (bmiOverview) {
        for (const line of bmiOverview.lines) {
          reviewLines.push(line);
        }
      }

      // KIOSK race packs riding this cart (owner final design 2026-07-18): the
      // pack is a DAY-OF revenue line (taxed like everything else on that
      // order), so it joins the review BEFORE the subtotal/tax math — unlike
      // the Game Zone cards, which ride the untaxed deposit order below. The
      // assignee's covered today-heats show as ONE negative line whose amount
      // is DIFFERENCED from the same buildRaceChargeLines call the reserve's
      // charge uses, so display and charge cannot drift.
      if (session.context?.kiosk && kioskRacePacksEnabled() && !activeComboSpecial(session)) {
        const packSelections = session.items.flatMap((i) =>
          i.kind === "race" ? (i.creditPacks ?? []) : [],
        );
        if (packSelections.length > 0) {
          try {
            const packs = resolveKioskPacks(packSelections, session.party);
            for (const p of packs) {
              reviewLines.push({
                name: `Race Pack — ${p.label} · ${p.memberName}`,
                quantity: 1,
                amount: p.priceCents / 100,
              });
            }
            const redeemed = redeemedHeatSet(session);
            const coverage = computePackCoverage(session, packs, redeemed);
            if (coverage.heats.size > 0) {
              const sumLines = (ex: Set<RaceHeatAssignment>) =>
                buildRaceChargeLines(session, ex).reduce((s, l) => s + l.amount, 0);
              const covered =
                Math.round(
                  (sumLines(redeemed) - sumLines(new Set([...redeemed, ...coverage.heats]))) * 100,
                ) / 100;
              if (covered > 0) {
                reviewLines.push({
                  name: "Today's races — covered by race pack",
                  quantity: 1,
                  amount: -covered,
                });
              }
            }
          } catch {
            /* bad pointers → the reserve rejects the charge; review shows without packs */
          }
        }
      }

      // BMI vouchers — one negative line PER voucher, amounts from the same
      // coverage plan + line-builder the reserve charges with (see
      // voucher-redeem.ts voucherReviewLines).
      if (sessionVouchers(session).length > 0 && !activeComboSpecial(session)) {
        try {
          let base = redeemedHeatSet(session);
          if (session.context?.kiosk && kioskRacePacksEnabled()) {
            const packSel = session.items.flatMap((i) =>
              i.kind === "race" ? (i.creditPacks ?? []) : [],
            );
            if (packSel.length > 0) {
              const packs = resolveKioskPacks(packSel, session.party);
              const cov = computePackCoverage(session, packs, base);
              if (cov.heats.size > 0) base = new Set([...base, ...cov.heats]);
            }
          }
          const vLines = voucherReviewLines(session, base, (ex) =>
            buildRaceChargeLines(session, ex).reduce((s, l) => s + l.amount, 0),
          );
          for (const vl of vLines) {
            if (vl.amount <= 0) continue;
            reviewLines.push({
              name: `${voucherDisplayName(vl.name)} — …${vl.code.slice(-4)}`,
              quantity: 1,
              amount: -vl.amount,
            });
          }
        } catch {
          /* voucher display is best-effort; the reserve verifies coverage */
        }
      }

      // Combo with `flatCartDisplay`: collapse its per-center revenue lines into
      // ONE all-inclusive package line so the customer sees one price, not a
      // parts list. Display only — the charge stays split across the two day-of
      // orders; the collapsed amount is the exact sum, so the displayed total
      // still equals the charge. Non-combo lines (e.g. an add-on attraction) stay
      // itemized. Both center lines are named for the combo itself
      // ("Ultimate VIP Experience"), so name === combo.name catches them.
      const flatCombo = activeComboSpecial(session);
      if (flatCombo?.combo.flatCartDisplay) {
        const isComboLine = (l: BillOverview["lines"][number]) => l.name === flatCombo.combo.name;
        const comboLines = reviewLines.filter(isComboLine);
        if (comboLines.length > 0) {
          const amount = Math.round(comboLines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
          // Preserve the USA250 savings on the collapsed line so the combo
          // still shows a strikethrough (its split lines arrive pre-discounted).
          const hasPromo = comboLines.some((l) => l.originalAmount != null);
          const originalAmount = hasPromo
            ? Math.round(comboLines.reduce((s, l) => s + (l.originalAmount ?? l.amount), 0) * 100) /
              100
            : undefined;
          const others = reviewLines.filter((l) => !isComboLine(l));
          reviewLines.length = 0;
          reviewLines.push(
            {
              name: flatCombo.combo.name,
              quantity: flatCombo.racerIds.length,
              amount,
              time: comboLines[0].time,
              ...(hasPromo
                ? { originalAmount, promoPct: session.appliedPromo?.amountPct ?? undefined }
                : {}),
            },
            ...others,
          );
        }
      }

      const preTaxSubtotal = reviewLines.reduce((s, l) => s + l.amount, 0);
      const rewardDiscountCents = session.loyalty?.selectedRewardTier?.discountCents ?? 0;

      // Bowling/KBF: get Square's authoritative tax-inclusive total + the day-of
      // order the reserve step will reuse, so the displayed total IS the charge —
      // county sales tax included. Bowling is 100% online (no balance), so the
      // deposit must be the FULL tax-inclusive total: quoting here (depositPct=100)
      // makes both the displayed total and the reserve charge tax-inclusive.
      // Without this, regular bowling fell back to a pre-tax deposit and left the
      // sales tax as a phantom balance. Non-fatal: fall back to the pre-tax
      // estimate if the quote can't be reached.
      let quotedTotal: number | null = null;
      // Only for a bowling/KBF-only cart — that's the path that reuses the quoted
      // day-of order (bowlingReserve). A mixed cart (KBF + race) settles via the
      // unified reserve, so don't override its total with the bowling-only quote.
      const bowlingOnlyCart = session.items.every((i) => i.kind === "bowling" || i.kind === "kbf");
      if (bowlingOnlyCart) {
        const bowlingItems = session.items.filter(
          (i): i is BowlingItem | KbfItem => i.kind === "bowling" || i.kind === "kbf",
        );
        let quotedSum = 0;
        let anyQuoted = false;
        for (const bi of bowlingItems) {
          if (bi.lineItems.length === 0) continue; // no package picked yet — skip
          try {
            const centerId = bi.qamfCenterId ?? HEADPINZ_FM_CENTER_ID;
            const res = await fetch("/api/square/bowling-orders/quote", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                locationId: qamfCenterCode(centerId) ?? HEADPINZ_FM_CENTER_CODE,
                lineItems: buildBowlingQuoteLineItems(bi, session),
                depositPct: 100,
              }),
            });
            const data = await res.json();
            if (res.ok && data.dayofOrderId) {
              quotedSum += data.dayofTotalCents / 100;
              anyQuoted = true;
              dispatch({
                type: "setBowlingQuote",
                itemId: bi.id,
                dayofOrderId: data.dayofOrderId,
                totalCents: data.dayofTotalCents,
                depositCents: data.depositCents,
              });
            }
          } catch {
            /* non-fatal — display falls back to the estimate below */
          }
        }
        if (anyQuoted) quotedTotal = quotedSum;

        // ── Tax-plausibility guard (the USA250 incident signature) ────────
        // The displayed Tax is derived as quotedTotal − displayed subtotal, so
        // ANY disagreement between the quote order and the displayed lines
        // (dropped discount, builder drift, stale quote) silently lands in the
        // tax line instead of the total. Real sales tax is 6/6.5%; if the
        // implied tax exceeds ~7.5% + $1, the quote is mispricing — discard it
        // AND clear the stored quote ids so the reserve takes its fallback
        // path (which re-derives promos server-side) instead of reusing the
        // mispriced order. Displayed falls back to the estimate; never blocks.
        if (quotedTotal != null && quotedTotal - preTaxSubtotal > preTaxSubtotal * 0.075 + 1) {
          const impliedTax = (quotedTotal - preTaxSubtotal).toFixed(2);
          console.error(
            `[checkout] quote/display mismatch: quoted $${quotedTotal.toFixed(2)} implies ` +
              `$${impliedTax} tax on a $${preTaxSubtotal.toFixed(2)} subtotal — discarding quote`,
          );
          void fetch("/api/debug-log", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              messages: [
                `TAX-PLAUSIBILITY GUARD tripped: quoted=$${quotedTotal.toFixed(2)} subtotal=$${preTaxSubtotal.toFixed(2)} impliedTax=$${impliedTax} promo=${session.appliedPromo?.code ?? "none"}`,
              ],
            }),
          }).catch(() => {});
          for (const bi of bowlingItems) {
            dispatch({
              type: "setBowlingQuote",
              itemId: bi.id,
              dayofOrderId: "",
              totalCents: 0,
              depositCents: 0,
            });
          }
          quotedTotal = null;
        }
      }

      // Display tax must cover EVERY line Square will tax (LOCATION_TAX is
      // ORDER-scope): the BMI-side tax as computed, PLUS 6.5% on the non-BMI
      // review lines (bowling line items, the $2.99 booking fee, KBF extras).
      // Without the second term a mixed cart displayed ~19¢ less than the
      // charge (caught on the first Ultimate VIP booking: review $82.87,
      // charged $83.06 — the fee's tax). Bowling-only carts use the quoted
      // tax-inclusive total below instead; race-only carts add 0 here.
      const nonBmiSubtotal = Math.max(0, preTaxSubtotal - (bmiOverview?.subtotal ?? 0));
      const estTax = (bmiOverview?.tax ?? 0) + calculateTax(nonBmiSubtotal);
      const rewardDiscount = rewardDiscountCents / 100;
      const grossTotal = quotedTotal ?? preTaxSubtotal + estTax;
      // The HeadPinz Rewards $-off reduces the charge, so the DISPLAYED Total
      // reflects it too — not just cashOwed (which left the Total showing the
      // full amount + a confusing "Credit" line). The reward is shown as its own
      // discount row in the totals block (rendered from session.loyalty), so it's
      // NOT pushed into the line items. displayed Total === cashOwed === charged.
      const total = Math.max(0, grossTotal - rewardDiscount);
      const tax = quotedTotal != null ? Math.max(0, quotedTotal - preTaxSubtotal) : estTax;

      // KIOSK: Game Zone cards riding this cart (owner 2026-07-18) — flat
      // charge lines on the DEPOSIT order (no tax, matching the standalone
      // Game Zone checkout). Added AFTER subtotal/tax so the booking math is
      // untouched; cashOwed (what the reader charges + the server verifies)
      // includes them, so displayed == charged end to end.
      let gzCartDollars = 0;
      if (session.context?.kiosk && kioskGzCartEnabled() && session.gameCardPurchase) {
        try {
          const gz = resolveCartPurchase(session.gameCardPurchase);
          if (gz) {
            for (const l of gz.orderLines) {
              const qty = Number(l.quantity) || 1;
              reviewLines.push({
                name: `Game Zone — ${l.name}`,
                quantity: qty,
                amount: (l.amountCents * qty) / 100,
              });
            }
            gzCartDollars = gz.totalCents / 100;
          }
        } catch {
          /* bad pointers → the server rejects the charge; show without cards */
        }
      }

      // USA250: total saved across all reviewed lines (race/attraction lines
      // arrive pre-discounted from bmiOverview; bowling + combo stamped above).
      const promoSavings =
        Math.round(
          reviewLines.reduce(
            (s, l) => s + (l.originalAmount != null ? l.originalAmount - l.amount : 0),
            0,
          ) * 100,
        ) / 100;

      const overview: BillOverview = {
        lines: reviewLines,
        subtotal: preTaxSubtotal,
        tax,
        total: total + gzCartDollars,
        cashOwed: total + gzCartDollars,
        creditApplied: bmiOverview?.creditApplied ?? 0,
        isCreditOrder: preTaxSubtotal <= 0,
        promoCode: session.appliedPromo?.code ?? null,
        promoSavings: promoSavings > 0 ? promoSavings : undefined,
      };

      const syntheticBillId = bmiBillId ?? `cart-${session.items[0]?.id ?? "0"}`;
      setPhase({ step: "review", overview, bmiBillId: syntheticBillId });
    } catch (err) {
      setPhase({
        step: "error",
        message: err instanceof Error ? err.message : "Checkout failed",
      });
    }
  }

  // Merged kiosk checkout (skipContactPhase): the merged screen gates its
  // Review & Pay on a complete contact, so submit immediately on mount — one
  // submit per mount (re-mounting after a Back re-runs it; runCheckout reuses
  // session.bmiBillId, the same path web exercises on review→contact→review).
  // The contact-form fallback is a defensive net for an incomplete contact.
  const autoSubmitted = useRef(false);
  useEffect(() => {
    if (!skipContactPhase || autoSubmitted.current) return;
    autoSubmitted.current = true;
    if (isValidContact) void handleContactSubmit();
    else setPhase({ step: "contact" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Review → Payment transition ───────────────────────────────

  async function handleConfirm(
    reserveSession: BookingSession,
    overview: BillOverview,
    // Full-price base (credits NOT applied) — carried into the paying phase so a
    // cancel/back returns review to its un-redeemed base, keeping the credit
    // toggle honest. `overview` above is the credit-applied charge overview.
    reviewOverview: BillOverview,
    bmiBillId: string,
  ) {
    void recordClickwrap({
      billId: bmiBillId,
      email: contact.email,
      phone: contact.phone,
      firstName: contact.firstName,
      amountCents: Math.round(overview.cashOwed * 100),
      bookingType: "racing",
    });

    await saveBookingDetails(reserveSession, bmiBillId, overview, contact);

    if (overview.isCreditOrder) {
      setPhase({ step: "confirming", bmiBillId });
      try {
        await reserveBooking({
          session: reserveSession,
          bmiBillId,
          overview,
          contact,
        });
        clearBookingSession(storageKey);
        go(buildConfirmationUrl(reserveSession, bmiBillId, true));
      } catch (err) {
        setPhase({
          step: "error",
          message: err instanceof Error ? err.message : "Credit confirmation failed",
        });
      }
      return;
    }

    // Cash order — resolve Square customer for saved cards. Skipped entirely on
    // the kiosk (allowCardVault === false): a shared public device must not fetch
    // or charge anyone's stored card-on-file — every kiosk payment is a fresh
    // typed/card-present entry (owner 2026-07-18).
    const hasReturning = allowCardVault && reserveSession.party.some((m) => !!m.bmiPersonId);
    let sqCustomer: Awaited<ReturnType<typeof resolveSquareCustomer>> = {};
    if (hasReturning) {
      sqCustomer = await resolveSquareCustomer(contact);
    }

    setPhase({
      step: "paying",
      overview,
      reviewOverview,
      bmiBillId,
      squareCustomerId: sqCustomer.customerId,
      savedCards: sqCustomer.cards,
    });
  }

  // ── Payment success handler ───────────────────────────────────

  function handlePaymentSuccess(result: PaymentResult, bmiBillId: string) {
    // PaymentForm only reaches onSuccess when a payment ran through
    // /api/square/pay WITHOUT onTokenize — meaning the customer was charged
    // but NO reservation was created (the June 2026 Apple Pay orphan-charge
    // incident). We always wire onTokenize, so this should be unreachable.
    // If it ever fires again: alert loudly, keep the session (ops needs the
    // cart contents), and show a "don't pay again" screen — the old silent
    // redirect to a broken confirmation is what drove double/triple retries.
    void fetch("/api/debug-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          `${new Date().toISOString()} [checkout] ALERT: charge WITHOUT reserve — ` +
            `ref=${bmiBillId} amount=$${result.amount} paymentId=${result.paymentId} ` +
            `email=${contact.email} — wallet bypass regression, no booking was created`,
        ],
      }),
    }).catch(() => {});

    void recordClickwrap({
      billId: bmiBillId,
      email: contact.email,
      phone: contact.phone,
      firstName: contact.firstName,
      amountCents: Math.round(result.amount * 100),
      bookingType: "racing",
      cardLast4: result.cardLast4 ?? undefined,
      cardBrand: result.cardBrand ?? undefined,
    });

    setPhase({ step: "paid-unconfirmed", amount: result.amount });
  }

  // ── Render ────────────────────────────────────────────────────

  // Cancel + clear: release the BMI/QAMF holds and empty the cart, then leave.
  // Available on review + pay so a customer who changes their mind after booking
  // (holds already exist) can bail cleanly instead of orphaning reservations.
  const cancelControl = (
    <div className="pt-2 text-center">
      {cancelConfirm ? (
        <div className="inline-flex flex-col items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3">
          <p className="text-xs text-white/60">
            This releases the spots you&apos;re holding and clears your cart.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setCancelConfirm(false)}
              disabled={cancelling}
              className="rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold text-white/70 transition-colors hover:text-white disabled:opacity-50"
            >
              Keep editing
            </button>
            <button
              type="button"
              onClick={async () => {
                setCancelling(true);
                try {
                  await onStartOver();
                } finally {
                  setCancelling(false);
                }
              }}
              disabled={cancelling}
              className="rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs font-semibold text-amber-300 transition-colors hover:bg-amber-400/10 disabled:opacity-50"
            >
              {cancelling ? "Cancelling…" : "Yes, cancel & clear"}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCancelConfirm(true)}
          className="text-xs text-white/35 underline transition-colors hover:text-white/60"
        >
          Cancel &amp; clear cart
        </button>
      )}
    </div>
  );

  if (phase.step === "contact") {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div className="text-center">
          <h2 className="font-display text-2xl tracking-widest text-white uppercase">Checkout</h2>
          <p className="mt-1 text-sm text-white/40">Confirm your details &amp; unlock rewards.</p>
        </div>

        {/* Your info — collapsed to a summary once we have it (from the wizard),
            expandable to edit. The full form only shows when incomplete or on
            "Change", so the rewards block below is the focus of this step. */}
        {editingContact ? (
          <div className="space-y-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-white/40">
              Your info
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="checkout-first-name"
                  className="mb-1 block text-xs font-semibold text-white/50"
                >
                  First name
                </label>
                <input
                  id="checkout-first-name"
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-[#00E2E5]/60"
                  placeholder="First name"
                />
              </div>
              <div>
                <label
                  htmlFor="checkout-last-name"
                  className="mb-1 block text-xs font-semibold text-white/50"
                >
                  Last name
                </label>
                <input
                  id="checkout-last-name"
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-[#00E2E5]/60"
                  placeholder="Last name"
                />
              </div>
            </div>
            <div>
              <label
                htmlFor="checkout-email"
                className="mb-1 block text-xs font-semibold text-white/50"
              >
                Email
              </label>
              <input
                id="checkout-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-[#00E2E5]/60"
                placeholder="email@example.com"
              />
            </div>
            <div>
              <label
                htmlFor="checkout-phone"
                className="mb-1 block text-xs font-semibold text-white/50"
              >
                Phone
              </label>
              <input
                id="checkout-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-[#00E2E5]/60"
                placeholder="(555) 555-1234"
              />
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={smsOptIn}
                onChange={(e) => setSmsOptIn(e.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-white/5 accent-[#00E2E5]"
              />
              <span className="text-xs text-white/50">
                Send me a text confirmation &amp; check-in reminder
              </span>
            </label>
            {isValidContact && (
              <button
                type="button"
                onClick={() => setEditingContact(false)}
                className="text-xs font-semibold text-[#00E2E5] hover:text-white"
              >
                Done
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditingContact(true)}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-left transition-colors hover:border-white/20"
          >
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-white/40">
                Booking as
              </p>
              <p className="mt-0.5 truncate text-sm font-semibold text-white">
                {firstName} {lastName}
              </p>
              <p className="truncate text-xs text-white/50">
                {[email, phone].filter(Boolean).join(" · ")}
              </p>
              {smsOptIn && (
                <p className="mt-0.5 text-[11px] text-emerald-400/80">✓ Text reminders on</p>
              )}
            </div>
            <span className="shrink-0 text-xs font-semibold text-[#00E2E5]">Change</span>
          </button>
        )}

        {/* HeadPinz / FastTrax Rewards — the focus of this step. One Square loyalty
            program spans both brands (same merchant); points earn and $-off rewards
            redeem regardless of brand. LoyaltySection labels itself per session brand.
            Kiosk hides it — loyalty is applied at the Square reader instead. */}
        {!hideRewards && <LoyaltySection session={session} dispatch={dispatch} phone={phone} />}

        {/* USA250-style promo entry. The ?promo= URL seed sets this too; this
            field lets a guest who hears the code apply it at checkout. The savings
            render on the review (strikethrough + "You saved" line). */}
        <PromoCodeInput
          appliedCode={session.appliedPromo?.code ?? null}
          onApply={(promo) => dispatch({ type: "applyPromo", promo })}
          onClear={() => dispatch({ type: "applyPromo", promo: null })}
          // BMI vouchers ride the same field (owner 2026-07-27: web must
          // reutilize the kiosk's voucher rail). Flag-gated; a voucher-shaped
          // code applies to the live bill via /api/booking/v2/voucher.
          voucher={
            voucherRedeemEnabled() || session.context?.voucherRedeem
              ? {
                  billId: session.bmiBillId,
                  center: session.center ?? session.context?.center ?? null,
                  applied: sessionVouchers(session),
                  onApplied: (voucher) => dispatch({ type: "applyVoucher", voucher }),
                  onCleared: (code) => dispatch({ type: "removeVoucher", code }),
                }
              : undefined
          }
        />

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg border border-white/15 px-5 py-2.5 text-sm font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
          >
            ← Back to cart
          </button>
          <button
            type="button"
            onClick={handleContactSubmit}
            disabled={!isValidContact}
            className="rounded-xl bg-[#00E2E5] px-8 py-3 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Review & Pay →
          </button>
        </div>
      </div>
    );
  }

  if (phase.step === "booking") {
    return (
      <div className="flex min-h-100 flex-col items-center justify-center gap-4">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
        <p className="text-sm text-white/60">{phase.progress}</p>
      </div>
    );
  }

  if (phase.step === "review") {
    const { overview: baseOverview, bmiBillId } = phase;
    // Recompute the displayed charge with any per-racer credit redemptions applied
    // (redeemed race lines → $0). The SAME overview is sent to the reserve call,
    // so the displayed price always equals what's charged.
    const overview = applyCreditRedemptionsToOverview(baseOverview, sessionForReserve);
    // Build a heatId -> [racer names] map from session.items so we can
    // append "— Alex, Sarah" to each race line in the review pane.
    // Without this the cart shows just "Starter Race Red x 1" with no
    // indication of WHICH party member is racing that heat.
    const heatRacers = new Map<string, string[]>();
    for (const it of session.items) {
      if (it.kind !== "race") continue;
      for (const h of it.heats) {
        if (!h.heatId) continue;
        const member = session.party.find((m) => m.id === h.assignedTo);
        const name = member ? [member.firstName, member.lastName].filter(Boolean).join(" ") : null;
        if (!name) continue;
        const list = heatRacers.get(h.heatId) ?? [];
        if (!list.includes(name)) list.push(name);
        heatRacers.set(h.heatId, list);
      }
    }
    // Unified itinerary — every timed activity (race heats, attractions,
    // bowling) with its time + who's assigned. This owns the times + names so
    // the bill below can read like a plain Square receipt (no times). Race heats
    // deduped by (product, time); ordered by start.
    const titleCase = (s: string) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const partyName = new Map(
      session.party.map(
        (m) => [m.id, [m.firstName, m.lastName].filter(Boolean).join(" ")] as const,
      ),
    );
    const lineup: Array<{ time: string; label: string; who: string }> = [];
    const seenHeatKeys = new Set<string>();
    for (const it of session.items) {
      if (it.kind === "race") {
        for (const h of it.heats) {
          if (!h.heatId) continue;
          const key = `${h.productId ?? ""}|${h.heatId}`;
          if (seenHeatKeys.has(key)) continue;
          seenHeatKeys.add(key);
          lineup.push({
            time: h.heatId,
            label: h.track ? `${h.track} Track` : "Race",
            who: (heatRacers.get(h.heatId) ?? []).join(", "),
          });
        }
      } else if (it.kind === "attraction") {
        if (!it.slot) continue;
        const who =
          it.assignedTo
            .map((id) => partyName.get(id))
            .filter(Boolean)
            .join(", ") || (it.qty > 1 ? `${it.qty} people` : "");
        lineup.push({ time: it.slot, label: it.slug ? titleCase(it.slug) : "Activity", who });
      } else if (it.kind === "bowling" || it.kind === "kbf") {
        if (!it.bookedAt) continue;
        lineup.push({
          time: it.bookedAt,
          label: it.experienceSlug ? titleCase(it.experienceSlug) : "Bowling",
          who: "",
        });
      }
    }
    lineup.sort((a, b) => a.time.localeCompare(b.time));
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div className="text-center">
          <h2 className="font-display text-2xl tracking-widest text-white uppercase">
            {overview.isCreditOrder ? "Review & Confirm" : "Review & Pay"}
          </h2>
          <p className="mt-1 text-sm text-white/50">
            Your activities are reserved. Complete your booking below.
          </p>
        </div>

        {/* Contact bar */}
        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm">
          <div>
            <span className="font-semibold text-white">
              {firstName} {lastName}
            </span>
            <span className="mx-2 text-white/30">&middot;</span>
            <span className="text-white/50">{email}</span>
          </div>
        </div>

        {/* Pay with a race credit — returning racers / linked family only.
            Non-transferable: each racer can spend only their own credits. */}
        {creditEligible.length > 0 && (
          <div className="space-y-3 rounded-xl border border-[#00E2E5]/25 bg-[#00E2E5]/5 p-4">
            <p className="text-sm font-semibold text-white">Pay with race credits</p>
            {creditEligible.map(({ member, heats, available, breakdown }) => {
              const personId = member.bmiPersonId as string;
              const checked = creditChoices[personId] === true;
              // Combined across kinds (priority order), capped at the total balance;
              // any heats beyond it are paid in cash.
              const used = Math.min(available, heats);
              const partial = used < heats;
              const summary = breakdown.map((b) => `${b.balance} ${b.label}`).join(" · ");
              return (
                <label
                  key={member.id}
                  className="flex cursor-pointer items-center justify-between gap-3"
                >
                  <span className="min-w-0 text-sm text-white/70">
                    <span className="font-medium text-white">
                      {member.firstName}
                      {member.lastName ? ` ${member.lastName}` : ""}
                    </span>
                    <span className="text-white/40">
                      {` · covers ${used} of ${heats} heat${heats !== 1 ? "s" : ""}`}
                    </span>
                    <span className="mt-0.5 block text-xs text-white/40">{summary} available</span>
                    {partial && checked && (
                      <span className="mt-0.5 block text-xs text-amber-400/80">
                        {heats - used} heat{heats - used !== 1 ? "s" : ""} paid in cash
                      </span>
                    )}
                  </span>
                  <input
                    type="checkbox"
                    aria-label={`Use race credits for ${member.firstName}`}
                    checked={checked}
                    onChange={(e) => toggleCredit(personId, e.target.checked)}
                    className="h-4 w-4 shrink-0 rounded border-white/20 bg-white/5 accent-[#00E2E5]"
                  />
                </label>
              );
            })}
            <p className="text-xs text-white/40">
              Credits aren&apos;t transferable — each racer can only use their own.
            </p>
          </div>
        )}

        {/* Your lineup — every timed activity (heats + attractions + bowling)
            with its time + assignment. This owns the schedule, so the bill below
            is a plain receipt (names + amounts, no times). */}
        {lineup.length > 0 && (
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/40">
              Your lineup
            </p>
            <ul className="space-y-1.5">
              {lineup.map((e, i) => (
                <li key={i} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-white">
                    {formatTime(e.time)}
                    <span className="text-white/40"> · {e.label}</span>
                  </span>
                  {e.who && <span className="truncate text-xs text-white/50">{e.who}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Bill — plain Square receipt: line name + amount, no times (the
            lineup above owns the schedule). */}
        <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-4">
          {overview.lines.map((line, i) => (
            <div key={i} className="flex justify-between gap-3 text-sm">
              <span
                className={`min-w-0 flex-1 ${line.amount < 0 ? "text-green-400" : "text-white/60"}`}
              >
                {line.name}
                {line.quantity > 1 && <span> x {line.quantity}</span>}
              </span>
              <span className={`shrink-0 ${line.amount < 0 ? "text-green-400" : "text-white"}`}>
                {line.originalAmount != null && line.originalAmount > line.amount && (
                  <span className="mr-1.5 text-white/40 line-through">
                    ${line.originalAmount.toFixed(2)}
                  </span>
                )}
                {/* amount < 0 = a deduction line (pack coverage) — show the signed
                    dollars; exactly $0 = a credit-redeemed heat, labeled "Credit". */}
                {line.amount > 0
                  ? `$${line.amount.toFixed(2)}`
                  : line.amount < 0
                    ? `-$${Math.abs(line.amount).toFixed(2)}`
                    : "Credit"}
              </span>
            </div>
          ))}

          <div className="space-y-1 border-t border-white/10 pt-2">
            <div className="flex justify-between text-sm">
              <span className="text-white/60">Subtotal</span>
              <span className="text-white">${overview.subtotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-white/60">Tax</span>
              <span className="text-white">${overview.tax.toFixed(2)}</span>
            </div>
            {overview.promoSavings != null && overview.promoSavings > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-green-400">{overview.promoCode ?? "Promo"} applied</span>
                <span className="text-green-400">
                  You saved ${overview.promoSavings.toFixed(2)}
                </span>
              </div>
            )}
            {session.loyalty?.selectedRewardTier &&
              session.loyalty.selectedRewardTier.discountCents > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-green-400">
                    {session.entryBrand === "headpinz" ? "HeadPinz Rewards" : "FastTrax Rewards"} (
                    {session.loyalty.selectedRewardTier.name})
                  </span>
                  <span className="text-green-400">
                    -${(session.loyalty.selectedRewardTier.discountCents / 100).toFixed(2)}
                  </span>
                </div>
              )}
            <div className="flex justify-between border-t border-white/10 pt-2 font-bold">
              <span className="text-white">Total</span>
              <span className="text-lg text-[#00E2E5]">${overview.total.toFixed(2)}</span>
            </div>
            {overview.creditApplied > 0 && (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-green-400">Credits Applied</span>
                  <span className="text-green-400">
                    -{overview.creditApplied} credit{overview.creditApplied !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="flex justify-between border-t border-white/10 pt-2 font-bold">
                  <span className="text-white">
                    {overview.cashOwed > 0 ? "Due Now" : "Amount Due"}
                  </span>
                  <span
                    className={`text-lg ${overview.cashOwed > 0 ? "text-[#00E2E5]" : "text-green-400"}`}
                  >
                    {overview.cashOwed > 0 ? `$${overview.cashOwed.toFixed(2)}` : "$0.00"}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Info notes */}
        <div className="space-y-1 rounded-xl border border-white/8 bg-white/3 p-4 text-xs text-white/40">
          <p>
            &middot; Arrive <strong className="text-white/60">30 minutes early</strong> for
            check-in.
          </p>
          {session.party.some((m) => m.isNewRacer) &&
            !overview.lines.some((l) => l.name.toLowerCase().includes("license")) && (
              <p>
                &middot; A <strong className="text-white/60">$4.99 license fee</strong> per driver
                applies at first check-in.
              </p>
            )}
        </div>

        <ClickwrapCheckbox checked={clickwrapAccepted} onChange={setClickwrapAccepted} />

        <div className="flex items-center justify-between gap-4">
          <button
            type="button"
            // Merged kiosk checkout has no contact phase — Back returns to the
            // merged cart+checkout screen instead (re-entering Review & Pay
            // re-books onto the same held bill).
            onClick={() => (skipContactPhase ? onBack() : setPhase({ step: "contact" }))}
            className="text-sm text-white/40 transition-colors hover:text-white/70"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => handleConfirm(sessionForReserve, overview, baseOverview, bmiBillId)}
            disabled={!clickwrapAccepted}
            title={!clickwrapAccepted ? "Please agree to the cancellation policy above" : undefined}
            className="inline-flex items-center gap-2 rounded-xl bg-[#00E2E5] px-8 py-4 text-base font-bold text-[#000418] shadow-lg shadow-[#00E2E5]/25 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {overview.isCreditOrder
              ? "Confirm Booking (Credit)"
              : overview.cashOwed <= 0
                ? "Confirm Booking →"
                : `Pay $${overview.cashOwed.toFixed(2)} →`}
          </button>
        </div>

        {cancelControl}
      </div>
    );
  }

  if (phase.step === "paying") {
    const { overview, reviewOverview, bmiBillId, squareCustomerId, savedCards } = phase;
    // Square location for the payment SDK (and any /api/square/pay fallback).
    // Must come from the SESSION's center first — the hostname can't tell
    // Naples from Fort Myers, which mis-located every fallback charge.
    const locationId =
      session.center === "naples"
        ? "naples"
        : typeof window !== "undefined" && window.location.hostname.includes("headpinz")
          ? "headpinz"
          : "fasttrax";

    async function handleTokenize(params: {
      cardNonce: string | null;
      savedCardId: string | null;
      giftCardNonce: string | null;
      /** PaymentForm source tag — rides to the reserve routes so the server's
       *  card-vault capture knows whether the token is a storable card. */
      sourceKind: "card" | "wallet" | "saved" | "gift_card";
      /** "Save this card to my account for faster checkout" opt-in. */
      saveCardConsent: boolean;
      /** Kiosk reader: the card-on-file's owning Square customer (SAVE_CARD). */
      squareCustomerIdOverride?: string;
      /** Kiosk direct-Terminal (owner: NO saved card): the reader already captured
       *  the card against OUR prepared deposit order. When set, reserve records it
       *  as collected and no card token is sent. `seed` lets the bowling route
       *  recreate the exact order the reader paid (racing re-derives it from the
       *  bill and ignores this field). */
      externalPayment?: {
        paymentId: string;
        /** Gift-card checkouts: every captured payment (GC + tap). */
        paymentIds?: string[];
        depositOrderId: string;
        amountCents: number;
        seed: string;
      };
    }) {
      setPhase({ step: "confirming", bmiBillId });
      const effectiveCustomerId =
        params.squareCustomerIdOverride ?? squareCustomerId ?? session.loyalty?.customerId;
      try {
        const bowlingOnly = session.items.every((i) => i.kind === "bowling" || i.kind === "kbf");

        if (bowlingOnly) {
          // Bowling-only: use the proven v1 bowling reserve route (QAMF + Square)
          const bowlingItem = session.items.find(
            (i) => i.kind === "bowling" || i.kind === "kbf",
          ) as BowlingItem | KbfItem;

          const result = await bowlingReserve({
            session,
            item: bowlingItem,
            contact,
            // A kiosk-reader card-on-file id (SAVE_CARD) charges as a source_id
            // with the customer set — same as a nonce for Square CreatePayment.
            // Kiosk reader (SAVE_CARD → card-on-file id) charges via savedCardId.
            // Gated to the reader path so WEB behavior is byte-identical to main
            // (a web saved-card bowling deposit keeps its prior path — no
            // untested web money change on merge).
            cardToken:
              params.cardNonce ?? (readerDeviceId ? (params.savedCardId ?? undefined) : undefined),
            giftCardNonce: params.giftCardNonce ?? undefined,
            // Kiosk direct-Terminal: reader already paid our prepared deposit
            // order — reserve finalizes it (funds the gift card, never re-charges).
            externalPayment: params.externalPayment,
            sourceKind: params.sourceKind,
            saveCardConsent: params.saveCardConsent,
            squareCustomerId: effectiveCustomerId,
            loyaltyAccountId: session.loyalty?.accountId,
            loyaltyAction: session.loyalty
              ? session.loyalty.isNewSignup
                ? "signup"
                : "existing"
              : undefined,
            rewardTierId: session.loyalty?.selectedRewardTier?.id,
            rewardDiscountCents: session.loyalty?.selectedRewardTier?.discountCents,
            smsOptIn: contact.smsOptIn,
          });

          void recordClickwrap({
            billId: `bowl-${result.qamfReservationId}`,
            email: contact.email,
            phone: contact.phone,
            firstName: contact.firstName,
            amountCents: Math.round(overview.cashOwed * 100),
            bookingType: "bowling",
          });

          stashKioskGameCards((result as { gameCards?: unknown }).gameCards);
          await saveBookingDetails(session, `bowl-${result.qamfReservationId}`, overview, contact);
          clearBookingSession(storageKey);

          // Duckpin is a FastTrax product, so its confirmation lives on the
          // FastTrax DOMAIN (owner 2026-07-26) — the page self-brands FastTrax
          // and the route only exists at /book/bowling-confirmation. Booking
          // happens on headpinz.com (Fort Myers), so we send an ABSOLUTE
          // fasttraxent.com URL here; `go` uses window.location.href on web
          // (cross-origin ok) and the kiosk shell only parses code/neonId out of
          // this string, so an absolute URL is safe there too. Play Now (per-lane
          // duckpin QR) is always duckpin → same route + ?playNow=1 auto-open.
          const playNow = playNowActive(session);
          const isFtDuckpin =
            bowlingItem.kind !== "kbf" &&
            (playNow || isFastTraxDuckpinCenter(bowlingItem.qamfCenterId ?? null));
          const confirmBase =
            bowlingItem.kind === "kbf"
              ? "/hp/book/kids-bowl-free/confirmation"
              : isFtDuckpin
                ? "https://fasttraxent.com/book/bowling-confirmation"
                : "/hp/book/bowling/confirmation";
          const playNowQ = playNow ? "&playNow=1" : "";
          go(
            result.shortCode
              ? `${confirmBase}?code=${result.shortCode}&neonId=${result.neonId}${playNowQ}`
              : `${confirmBase}?neonId=${result.neonId}${playNowQ}`,
          );
        } else {
          // Mixed or BMI-only: unified reserve (one Square order for everything).
          // sessionForReserve carries each racer's credit-redemption choice so the
          // server zeroes those race lines + deducts the credits.

          // BMI auto-cancels held bills after 20 min. If ours lapsed during the
          // customer's dwell, rebuild the heats into a FRESH bill BEFORE charging
          // (never charge a dead bill). Returns the original id when still live;
          // throws only when a heat's time is gone → show "pick again", no charge.
          let effectiveBillId: string;
          if (params.externalPayment) {
            // TERMINAL: the reader already paid the deposit order tied to the
            // PREPARE-time session seed. Rebuilding the bill here would change the
            // seed → reserve re-derives a DIFFERENT (unpaid) deposit order and the
            // reader's captured payment wouldn't match it (orphan charge). Prepare
            // already validated the bill was live, so keep the same bill — no rebuild.
            effectiveBillId = bmiBillId ?? session.bmiBillId ?? "";
          } else {
            let liveBillId: string | null;
            try {
              liveBillId = await rebuildRaceBillIfExpired(sessionForReserve, contact, dispatch);
            } catch (rebuildErr) {
              setPhase({
                step: "error",
                message:
                  rebuildErr instanceof Error
                    ? rebuildErr.message
                    : "Your held time expired — please go back and pick a time again.",
              });
              return;
            }
            effectiveBillId = liveBillId ?? bmiBillId ?? session.bmiBillId ?? "";
          }

          const sessionWithBill = {
            ...sessionForReserve,
            bmiBillId: effectiveBillId,
          };
          const reserveParams = {
            session: sessionWithBill,
            contact,
            // Terminal path: the reader already captured the card → NO token.
            cardSourceId: params.externalPayment
              ? undefined
              : (params.savedCardId ?? params.cardNonce ?? undefined),
            giftCardNonce: params.giftCardNonce ?? undefined,
            sourceKind: params.sourceKind,
            saveCardConsent: params.saveCardConsent,
            squareCustomerId: params.externalPayment ? undefined : effectiveCustomerId,
            loyaltyAccountId: session.loyalty?.accountId,
            rewardTierId: session.loyalty?.selectedRewardTier?.id,
            rewardDiscountCents: session.loyalty?.selectedRewardTier?.discountCents,
            externalPayment: params.externalPayment,
          };
          // The externalPayment path is fully idempotent (the reader charged once;
          // finalize replays via the deterministic baseKey and never re-charges), so
          // a transient reserve failure AFTER the reader charged must be retried, not
          // surfaced as an orphan. Retry a few times before giving up.
          let result: Awaited<ReturnType<typeof reserveAll>>;
          if (params.externalPayment) {
            let lastErr: unknown = null;
            let ok: Awaited<ReturnType<typeof reserveAll>> | null = null;
            for (let attempt = 0; attempt < 3 && !ok; attempt++) {
              if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
              try {
                ok = await reserveAll(reserveParams);
              } catch (e) {
                lastErr = e;
              }
            }
            if (!ok) throw lastErr instanceof Error ? lastErr : new Error("Reservation failed");
            result = ok;
          } else {
            result = await reserveAll(reserveParams);
          }

          void recordClickwrap({
            billId: effectiveBillId,
            email: contact.email,
            phone: contact.phone,
            firstName: contact.firstName,
            amountCents: Math.round(overview.cashOwed * 100),
            bookingType: hasBmi ? "racing" : "bowling",
          });

          stashKioskGameCards((result as { gameCards?: unknown }).gameCards);
          stashRacePackConfirmation((result as { racePacks?: unknown }).racePacks);
          stashPovConfirmation((result as { povCodes?: unknown }).povCodes);
          stashVipVoucherConfirmation((result as { comboVoucher?: unknown }).comboVoucher);
          // Booked heats only (race packs are credits, not a visit today) — the
          // kiosk confirmation's racing "what's next" banner keys off this.
          stashKioskHasRacing(session.items.some((i) => i.kind === "race"));
          await saveBookingDetails(sessionForReserve, effectiveBillId, overview, contact);
          clearBookingSession(storageKey);

          // Mixed cart: use /book/confirmation (race confirmation) which shows all items
          if (hasBmi && effectiveBillId) {
            go(buildConfirmationUrl(sessionForReserve, effectiveBillId, true));
          } else if (result.shortCodes.length > 0) {
            const bowlingItem = session.items.find((i) => i.kind === "bowling" || i.kind === "kbf");
            const confirmBase =
              bowlingItem?.kind === "kbf"
                ? "/hp/book/kids-bowl-free/confirmation"
                : "/hp/book/bowling/confirmation";
            // neonId rides along so the kiosk confirmation can drive the
            // self-service lane-open prompt (same param the pure-bowling path carries).
            go(
              result.neonIds[0]
                ? `${confirmBase}?code=${result.shortCodes[0]}&neonId=${result.neonIds[0]}`
                : `${confirmBase}?code=${result.shortCodes[0]}`,
            );
          } else {
            // Fallback: bowling confirmation with neonId
            const bowlingItem = session.items.find((i) => i.kind === "bowling" || i.kind === "kbf");
            const confirmBase =
              bowlingItem?.kind === "kbf"
                ? "/hp/book/kids-bowl-free/confirmation"
                : "/hp/book/bowling/confirmation";
            go(`${confirmBase}?neonId=${result.neonIds[0] ?? ""}`);
          }
        }
      } catch (err) {
        // Terminal path: the reader already captured the card, and reserve was
        // already retried with the same payment above. Land on the no-Retry
        // paid-unconfirmed screen — the generic error screen's Retry re-runs
        // checkout, REMOUNTS the terminal gate, re-prepares a fresh seed and
        // re-arms the reader, and a second tap captures the card AGAIN
        // (2026-07-19: two $72.41 captures for one 10:30 PM lane). Staff / the
        // terminal-orphan reconcile completes or refunds from the anchor.
        if (params.externalPayment) {
          setPhase({
            step: "paid-unconfirmed",
            amount: params.externalPayment.amountCents / 100,
          });
        } else {
          setPhase({
            step: "error",
            message: err instanceof Error ? err.message : "Reservation failed",
          });
        }
      }
    }

    // Nothing due (vouchers/credits covered the whole order) → NEVER arm a
    // payment surface. The Square reader cannot process a $0 order (the terminal
    // gate would dead-end at "see the front desk") and the web card form can't
    // tokenize $0 either. Reserve directly instead: the server charges nothing
    // at a $0 deposit and refuses a chargeless reserve that actually owes money
    // ("Card or gift card required"), so displayed==charged still holds.
    if (Math.round(overview.cashOwed * 100) <= 0) {
      return (
        <div className="mx-auto max-w-md space-y-5 py-8 text-center">
          <div className="rounded-2xl border border-white/15 bg-white/5 px-6 py-5">
            <p className="text-lg font-semibold text-white">Nothing to pay today</p>
            <p className="mt-1 text-sm text-white/60">
              Your vouchers and credits cover this booking in full.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              void handleTokenize({
                cardNonce: null,
                savedCardId: null,
                giftCardNonce: null,
                sourceKind: "card",
                saveCardConsent: false,
              })
            }
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#00E2E5] px-8 py-4 text-base font-bold text-[#000418] shadow-lg shadow-[#00E2E5]/25 transition-colors hover:bg-white"
          >
            Confirm booking →
          </button>
          {cancelControl}
        </div>
      );
    }

    // Kiosk card-present on the paired reader.
    if (readerDeviceId) {
      const bowlingOnlyReader = session.items.every(
        (i) => i.kind === "bowling" || i.kind === "kbf",
      );
      // Terminal DIRECT charge (owner: NO saved card). The reader charges OUR
      // deposit order → reserve records the completed paymentId. Racing/mixed
      // prepare via the unified rail; a bowling/KBF-only cart prepares via the
      // bowling rail (bowlingTerminalPrepare) so it reuses this exact reader UX
      // + server-side verification while keeping the proven bowling reserve route.
      {
        const bowlingItemForTerminal = bowlingOnlyReader
          ? (session.items.find((i) => i.kind === "bowling" || i.kind === "kbf") as
              | BowlingItem
              | KbfItem
              | undefined)
          : undefined;
        // KIOSK: the deposit order must live at the KIOSK'S location — the paired
        // reader can only charge its own device's location. (Web never gets here;
        // this branch is kiosk-terminal only, but derive defensively anyway.)
        const kioskDepositLocationId = session.context?.kiosk
          ? session.center === "naples"
            ? "PPTR5G2N0QXF7"
            : session.entryBrand === "headpinz"
              ? "TXBSQN0FEKQ11"
              : "LAB52GY480CJF"
          : undefined;
        const bowlingPrepare = bowlingItemForTerminal
          ? () =>
              bowlingTerminalPrepare({
                item: bowlingItemForTerminal,
                rewardDiscountCents: session.loyalty?.selectedRewardTier?.discountCents,
                depositLocationId: kioskDepositLocationId,
                // Game Zone cards riding this cart join the deposit order.
                gameCardPurchase:
                  kioskGzCartEnabled() && session.context?.kiosk
                    ? session.gameCardPurchase
                    : undefined,
                gameCardLocationCode:
                  kioskGzCartEnabled() && session.context?.kiosk && session.gameCardPurchase
                    ? centerCodeFor(session.center ?? "fort-myers", session.entryBrand)
                    : undefined,
              })
          : undefined;
        return (
          <div className="mx-auto max-w-md">
            <KioskTerminalCheckoutGate
              session={sessionForReserve}
              contact={contact}
              brand={session.entryBrand}
              deviceId={readerDeviceId}
              bmiBillId={bmiBillId}
              depositCentsExpected={Math.round(overview.cashOwed * 100)}
              prepareFn={bowlingPrepare}
              onCaptured={(ep) =>
                void handleTokenize({
                  cardNonce: null,
                  savedCardId: null,
                  giftCardNonce: null,
                  sourceKind: "card",
                  saveCardConsent: false,
                  externalPayment: ep,
                })
              }
              onCancel={() => setPhase({ step: "review", overview: reviewOverview, bmiBillId })}
            />
            {cancelControl}
          </div>
        );
      }
      // A kiosk with a paired reader ALWAYS returns above. Only a readerless
      // device / web falls through to the typed card path below. (The interim
      // SAVE_CARD reader-capture path is retired — owner 2026-07-31, no flags.)
    }

    return (
      <div className={hideWallets ? "mx-auto max-w-2xl" : "mx-auto max-w-md"}>
        <PaymentForm
          amount={overview.cashOwed}
          itemName="Deposit"
          billId={bmiBillId}
          contact={contact}
          locationId={locationId}
          squareCustomerId={squareCustomerId}
          savedCards={allowCardVault ? savedCards : undefined}
          allowSaveCard={allowCardVault && !!squareCustomerId}
          hideWallets={hideWallets}
          onTokenize={handleTokenize}
          onSuccess={(result) => handlePaymentSuccess(result, bmiBillId)}
          onError={(msg) => setPhase({ step: "error", message: msg })}
          onCancel={() => setPhase({ step: "review", overview: reviewOverview, bmiBillId })}
        />
        {cancelControl}
      </div>
    );
  }

  if (phase.step === "confirming") {
    return (
      <div className="flex min-h-100 flex-col items-center justify-center gap-4">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
        <p className="text-sm text-white/60">Confirming your booking…</p>
      </div>
    );
  }

  // Paid-but-unconfirmed phase: money was taken via the /api/square/pay
  // fallback with no reservation. The one thing this screen must prevent is
  // the customer paying AGAIN — no Retry, no back-to-cart.
  if (phase.step === "paid-unconfirmed") {
    return (
      <div className="mx-auto flex min-h-100 max-w-md flex-col items-center justify-center gap-4 text-center">
        <div className="text-4xl">✓</div>
        <p className="text-lg font-bold text-white">
          Payment received — ${phase.amount.toFixed(2)}
        </p>
        <p className="text-sm text-white/70">
          Your card was charged, but we hit a snag finalizing the reservation. Our team has been
          notified and will confirm your booking shortly.
        </p>
        <p className="text-sm font-semibold text-amber-300">
          Please do NOT pay again — your payment went through. If you don&apos;t hear from us within
          the hour, call the center and mention this screen.
        </p>
      </div>
    );
  }

  // Error phase
  return (
    <div className="mx-auto flex min-h-100 max-w-md flex-col items-center justify-center gap-4 text-center">
      <div className="text-4xl">!</div>
      <p className="text-lg font-bold text-white">Booking Failed</p>
      <p className="text-sm text-red-400">{phase.message}</p>
      <button
        type="button"
        onClick={() => {
          setPhase({ step: "booking", progress: "Retrying…" });
          runCheckout(session, contact, dispatch, (msg) =>
            setPhase({ step: "booking", progress: msg }),
          ).then(
            (result) =>
              setPhase({ step: "review", overview: result.overview, bmiBillId: result.bmiBillId }),
            (err) =>
              setPhase({
                step: "error",
                message: err instanceof Error ? err.message : "Retry failed",
              }),
          );
        }}
        className="rounded-lg border border-white/15 px-5 py-2.5 text-sm font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
      >
        Retry
      </button>
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-white/30 transition-colors hover:text-white/50"
      >
        ← Back to cart
      </button>
    </div>
  );
}
