"use client";

import { useState } from "react";
import type { Dispatch } from "react";
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
  applyCreditRedemptionsToOverview,
  type BillOverview,
} from "~/features/booking/service/checkout";
import { eligibleCreditsForMember } from "~/features/booking/data/race-credits";
import { bowlingReserve, buildBowlingQuoteLineItems } from "~/features/booking/service/bowling";
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

interface CheckoutStepProps {
  session: BookingSession;
  dispatch: Dispatch<Action>;
  onBack: () => void;
}

type Phase =
  | { step: "contact" }
  | { step: "booking"; progress: string }
  | { step: "review"; overview: BillOverview; bmiBillId: string }
  | {
      step: "paying";
      overview: BillOverview;
      bmiBillId: string;
      squareCustomerId?: string;
      savedCards?: SavedCard[];
    }
  | { step: "confirming"; bmiBillId: string }
  | { step: "error"; message: string };

function formatTime(iso: string): string {
  const clean = iso.replace(/Z$/, "");
  return new Date(clean).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function CheckoutStep({ session, dispatch, onBack }: CheckoutStepProps) {
  const [phase, setPhase] = useState<Phase>({ step: "contact" });
  const [clickwrapAccepted, setClickwrapAccepted] = useState(false);

  // Contact form local state — pre-fill from session.contact
  const [firstName, setFirstName] = useState(session.contact.firstName ?? "");
  const [lastName, setLastName] = useState(session.contact.lastName ?? "");
  const [email, setEmail] = useState(session.contact.email ?? "");
  const [phone, setPhone] = useState(session.contact.phone ?? "");
  const [smsOptIn, setSmsOptIn] = useState(session.contact.smsOptIn ?? true);

  const contact: ContactInfo = { firstName, lastName, email, phone, smsOptIn };

  // ── Race-credit redemption (explicit per-racer choice) ──────────
  // personId -> chosen depositKindId. Offered ONLY to returning racers / linked
  // family (bmiPersonId && !isNewRacer) who hold a credit eligible for the race
  // day. Credits are non-transferable — each racer spends only their own.
  const [creditChoices, setCreditChoices] = useState<Record<string, string>>({});

  const raceItem = session.items.find((i): i is RaceItem => i.kind === "race") ?? null;
  const raceDate = raceItem?.date ?? null;

  const heatCountForMember = (memberId: string): number => {
    let n = 0;
    for (const it of session.items) {
      if (it.kind !== "race") continue;
      for (const h of it.heats) if (h.assignedTo === memberId) n += 1;
    }
    return n;
  };

  const creditEligible = session.party
    .filter((m) => m.bmiPersonId && !m.isNewRacer)
    .map((m) => ({
      member: m,
      heats: heatCountForMember(m.id),
      credits: eligibleCreditsForMember(m.creditBalances, raceDate),
    }))
    .filter((e) => e.heats > 0 && e.credits.length > 0);

  // Party + session carrying each racer's redemption choice, threaded into the
  // reserve calls. A heat assigned to a member with redeemCreditKindId is charged
  // $0 by Square and draws down one of that member's credits server-side.
  const partyWithChoices = session.party.map((m) =>
    m.bmiPersonId && creditChoices[m.bmiPersonId]
      ? { ...m, redeemCreditKindId: creditChoices[m.bmiPersonId] }
      : { ...m, redeemCreditKindId: null },
  );
  const sessionForReserve: BookingSession = { ...session, party: partyWithChoices };

  function toggleCredit(personId: string, depositKindId: string, on: boolean) {
    setCreditChoices((prev) => {
      const next = { ...prev };
      if (on) next[personId] = depositKindId;
      else delete next[personId];
      return next;
    });
  }

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

      // Bowling line items — include bookedAt time
      for (const item of session.items) {
        if (item.kind !== "bowling" && item.kind !== "kbf") continue;
        for (const li of item.lineItems) {
          reviewLines.push({
            name: li.label ?? `Item #${li.squareProductId}`,
            quantity: li.quantity,
            amount: ((li.priceCents ?? 0) * li.quantity) / 100,
            time: item.bookedAt ?? undefined,
          });
        }
        if (item.hasBookingFee) {
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

      const preTaxSubtotal = reviewLines.reduce((s, l) => s + l.amount, 0);
      const rewardDiscountCents = session.loyalty?.selectedRewardTier?.discountCents ?? 0;

      // KBF: get Square's authoritative tax-inclusive total + the day-of order
      // the reserve step will reuse, so the displayed total IS the charge —
      // county sales tax included. Non-fatal: fall back to the pre-tax estimate
      // if the quote can't be reached. (KBF is 100% deposit; regular bowling
      // keeps its existing deposit flow.)
      let quotedTotal: number | null = null;
      // Only for a bowling/KBF-only cart — that's the path that reuses the
      // quoted day-of order (bowlingReserve). A mixed cart (KBF + race) settles
      // via the unified reserve, so don't override its total with the KBF-only
      // quote.
      const bowlingOnlyCart = session.items.every((i) => i.kind === "bowling" || i.kind === "kbf");
      const kbfItem = session.items.find((i): i is KbfItem => i.kind === "kbf");
      if (kbfItem && bowlingOnlyCart) {
        try {
          const centerId = kbfItem.qamfCenterId ?? 9172;
          const res = await fetch("/api/square/bowling-orders/quote", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              locationId: centerId === 9172 ? "TXBSQN0FEKQ11" : "PPTR5G2N0QXF7",
              lineItems: buildBowlingQuoteLineItems(kbfItem, session),
              depositPct: 100,
            }),
          });
          const data = await res.json();
          if (res.ok && data.dayofOrderId) {
            quotedTotal = data.dayofTotalCents / 100;
            dispatch({
              type: "setBowlingQuote",
              itemId: kbfItem.id,
              dayofOrderId: data.dayofOrderId,
              totalCents: data.dayofTotalCents,
              depositCents: data.depositCents,
            });
          }
        } catch {
          /* non-fatal — display falls back to the estimate below */
        }
      }

      const estTax = bmiOverview?.tax ?? 0;
      const total = quotedTotal ?? preTaxSubtotal + estTax;
      const tax = quotedTotal != null ? Math.max(0, quotedTotal - preTaxSubtotal) : estTax;

      const overview: BillOverview = {
        lines: reviewLines,
        subtotal: preTaxSubtotal,
        tax,
        total,
        cashOwed: Math.max(0, total - rewardDiscountCents / 100),
        creditApplied: bmiOverview?.creditApplied ?? 0,
        isCreditOrder: preTaxSubtotal <= 0,
      };

      if (rewardDiscountCents > 0) {
        overview.lines.push({
          name: "HeadPinz Rewards",
          quantity: 1,
          amount: -(rewardDiscountCents / 100),
        });
      }

      const syntheticBillId = bmiBillId ?? `cart-${session.items[0]?.id ?? "0"}`;
      setPhase({ step: "review", overview, bmiBillId: syntheticBillId });
    } catch (err) {
      setPhase({
        step: "error",
        message: err instanceof Error ? err.message : "Checkout failed",
      });
    }
  }

  // ── Review → Payment transition ───────────────────────────────

  async function handleConfirm(
    reserveSession: BookingSession,
    overview: BillOverview,
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
        clearBookingSession();
        window.location.href = buildConfirmationUrl(reserveSession, bmiBillId, true);
      } catch (err) {
        setPhase({
          step: "error",
          message: err instanceof Error ? err.message : "Credit confirmation failed",
        });
      }
      return;
    }

    // Cash order — resolve Square customer for saved cards
    const hasReturning = reserveSession.party.some((m) => !!m.bmiPersonId);
    let sqCustomer: Awaited<ReturnType<typeof resolveSquareCustomer>> = {};
    if (hasReturning) {
      sqCustomer = await resolveSquareCustomer(contact);
    }

    setPhase({
      step: "paying",
      overview,
      bmiBillId,
      squareCustomerId: sqCustomer.customerId,
      savedCards: sqCustomer.cards,
    });
  }

  // ── Payment success handler ───────────────────────────────────

  function handlePaymentSuccess(result: PaymentResult, bmiBillId: string) {
    try {
      sessionStorage.setItem(
        `payment_${bmiBillId}`,
        JSON.stringify({
          cardBrand: result.cardBrand,
          cardLast4: result.cardLast4,
          amount: result.amount,
          paymentId: result.paymentId,
        }),
      );
    } catch {
      /* non-fatal */
    }

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

    clearBookingSession();
    // Fallback path: PaymentForm only reaches onSuccess when no onTokenize is
    // wired (we always wire handleTokenize, so this is effectively dead today).
    // Route to v2 anyway so a future non-tokenize flow doesn't drop v2 carts on v1.
    window.location.href = buildConfirmationUrl(session, bmiBillId, true);
  }

  // ── Render ────────────────────────────────────────────────────

  if (phase.step === "contact") {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div className="text-center">
          {/* v1 parity — apps/web/app/book/checkout/page.tsx:84-86 verbatim. */}
          <h2 className="font-display text-2xl tracking-widest text-white uppercase">Checkout</h2>
          <p className="mt-1 text-sm text-white/40">Enter your details to complete booking.</p>
        </div>

        <div className="space-y-4">
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
        </div>

        {/* HeadPinz Rewards — earning + redeeming for all HeadPinz bookings */}
        {session.entryBrand === "headpinz" && (
          <LoyaltySection session={session} dispatch={dispatch} phone={phone} />
        )}

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
            <p className="text-sm font-semibold text-white">Pay with a race credit</p>
            {creditEligible.map(({ member, heats, credits }) => {
              const credit = credits[0];
              const personId = member.bmiPersonId as string;
              const checked = creditChoices[personId] === credit.depositKindId;
              const enough = credit.balance >= heats;
              return (
                <label
                  key={member.id}
                  className={`flex items-center justify-between gap-3 ${
                    enough ? "cursor-pointer" : "opacity-50"
                  }`}
                >
                  <span className="min-w-0 text-sm text-white/70">
                    <span className="font-medium text-white">
                      {member.firstName}
                      {member.lastName ? ` ${member.lastName}` : ""}
                    </span>
                    <span className="text-white/40">
                      {" · "}
                      {credit.label} ({credit.balance} available)
                      {heats > 1 ? ` · uses ${heats}` : ""}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    aria-label={`Use a ${credit.label} for ${member.firstName}`}
                    checked={checked}
                    disabled={!enough}
                    onChange={(e) => toggleCredit(personId, credit.depositKindId, e.target.checked)}
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

        {/* Line items */}
        <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-4">
          {overview.lines.map((line, i) => {
            const racers = line.time ? heatRacers.get(line.time) : undefined;
            return (
              <div key={i} className="flex justify-between gap-3 text-sm">
                <div className="min-w-0 flex-1 text-white/60">
                  <div>
                    {line.name}
                    {line.quantity > 1 && <span> x {line.quantity}</span>}
                    {line.time && (
                      <span className="ml-1 text-white/30">{formatTime(line.time)}</span>
                    )}
                  </div>
                  {racers && racers.length > 0 && (
                    <div className="mt-0.5 text-xs text-white/40">{racers.join(", ")}</div>
                  )}
                </div>
                <span className="shrink-0 text-white">
                  {line.amount > 0 ? `$${line.amount.toFixed(2)}` : "Credit"}
                </span>
              </div>
            );
          })}

          <div className="space-y-1 border-t border-white/10 pt-2">
            <div className="flex justify-between text-sm">
              <span className="text-white/60">Subtotal</span>
              <span className="text-white">${overview.subtotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-white/60">Tax</span>
              <span className="text-white">${overview.tax.toFixed(2)}</span>
            </div>
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
            onClick={() => setPhase({ step: "contact" })}
            className="text-sm text-white/40 transition-colors hover:text-white/70"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => handleConfirm(sessionForReserve, overview, bmiBillId)}
            disabled={!clickwrapAccepted}
            title={!clickwrapAccepted ? "Please agree to the cancellation policy above" : undefined}
            className="inline-flex items-center gap-2 rounded-xl bg-[#00E2E5] px-8 py-4 text-base font-bold text-[#000418] shadow-lg shadow-[#00E2E5]/25 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {overview.isCreditOrder
              ? "Confirm Booking (Credit)"
              : `Pay $${overview.cashOwed.toFixed(2)} →`}
          </button>
        </div>
      </div>
    );
  }

  if (phase.step === "paying") {
    const { overview, bmiBillId, squareCustomerId, savedCards } = phase;
    const locationId =
      typeof window !== "undefined" && window.location.hostname.includes("headpinz")
        ? "headpinz"
        : "fasttrax";

    async function handleTokenize(params: {
      cardNonce: string | null;
      savedCardId: string | null;
      giftCardNonce: string | null;
    }) {
      setPhase({ step: "confirming", bmiBillId });
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
            cardToken: params.cardNonce ?? undefined,
            giftCardNonce: params.giftCardNonce ?? undefined,
            squareCustomerId: squareCustomerId ?? session.loyalty?.customerId,
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

          await saveBookingDetails(session, `bowl-${result.qamfReservationId}`, overview, contact);
          clearBookingSession();

          const confirmBase =
            bowlingItem.kind === "kbf"
              ? "/hp/book/kids-bowl-free/confirmation"
              : "/hp/book/bowling/confirmation";
          window.location.href = result.shortCode
            ? `${confirmBase}?code=${result.shortCode}&neonId=${result.neonId}`
            : `${confirmBase}?neonId=${result.neonId}`;
        } else {
          // Mixed or BMI-only: unified reserve (one Square order for everything).
          // sessionForReserve carries each racer's credit-redemption choice so the
          // server zeroes those race lines + deducts the credits.
          const sessionWithBill = {
            ...sessionForReserve,
            bmiBillId: bmiBillId || session.bmiBillId,
          };
          const result = await reserveAll({
            session: sessionWithBill,
            contact,
            cardSourceId: params.savedCardId ?? params.cardNonce ?? undefined,
            giftCardNonce: params.giftCardNonce ?? undefined,
            squareCustomerId: squareCustomerId ?? session.loyalty?.customerId,
            loyaltyAccountId: session.loyalty?.accountId,
            rewardTierId: session.loyalty?.selectedRewardTier?.id,
            rewardDiscountCents: session.loyalty?.selectedRewardTier?.discountCents,
          });

          const effectiveBillId = session.bmiBillId ?? bmiBillId;

          void recordClickwrap({
            billId: effectiveBillId,
            email: contact.email,
            phone: contact.phone,
            firstName: contact.firstName,
            amountCents: Math.round(overview.cashOwed * 100),
            bookingType: hasBmi ? "racing" : "bowling",
          });

          await saveBookingDetails(sessionForReserve, effectiveBillId, overview, contact);
          clearBookingSession();

          // Mixed cart: use /book/confirmation (race confirmation) which shows all items
          if (hasBmi && effectiveBillId) {
            window.location.href = buildConfirmationUrl(sessionForReserve, effectiveBillId, true);
          } else if (result.shortCodes.length > 0) {
            const bowlingItem = session.items.find((i) => i.kind === "bowling" || i.kind === "kbf");
            const confirmBase =
              bowlingItem?.kind === "kbf"
                ? "/hp/book/kids-bowl-free/confirmation"
                : "/hp/book/bowling/confirmation";
            window.location.href = `${confirmBase}?code=${result.shortCodes[0]}`;
          } else {
            // Fallback: bowling confirmation with neonId
            const bowlingItem = session.items.find((i) => i.kind === "bowling" || i.kind === "kbf");
            const confirmBase =
              bowlingItem?.kind === "kbf"
                ? "/hp/book/kids-bowl-free/confirmation"
                : "/hp/book/bowling/confirmation";
            window.location.href = `${confirmBase}?neonId=${result.neonIds[0] ?? ""}`;
          }
        }
      } catch (err) {
        setPhase({
          step: "error",
          message: err instanceof Error ? err.message : "Reservation failed",
        });
      }
    }

    return (
      <div className="mx-auto max-w-md">
        <PaymentForm
          amount={overview.cashOwed}
          itemName="Deposit"
          billId={bmiBillId}
          contact={contact}
          locationId={locationId}
          squareCustomerId={squareCustomerId}
          savedCards={savedCards}
          allowSaveCard={!!squareCustomerId}
          onTokenize={handleTokenize}
          onSuccess={(result) => handlePaymentSuccess(result, bmiBillId)}
          onError={(msg) => setPhase({ step: "error", message: msg })}
          onCancel={() => setPhase({ step: "review", overview, bmiBillId })}
        />
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
