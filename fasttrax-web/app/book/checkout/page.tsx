"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import BrandNav from "@/components/BrandNav";
import PaymentForm from "@/components/square/PaymentForm";
import type { PaymentResult } from "@/components/square/PaymentForm";
import ClickwrapCheckbox from "@/components/booking/ClickwrapCheckbox";
import LoyaltySection from "@/components/booking/LoyaltySection";
import { useLoyalty } from "@/hooks/useLoyalty";
import { CURRENT_POLICY_VERSION } from "@/lib/clickwrap";
import ContactForm from "@/app/book/race/components/ContactForm";
import type { ContactInfo } from "@/app/book/race/components/ContactForm";
import { getBookingLocation, getBookingClientKey } from "@/lib/booking-location";
// MiniCart is rendered globally in root layout

/**
 * Unified multi-item checkout page (v2).
 *
 * Reads from sessionStorage:
 *   - attractionOrderId + attractionCart → BMI items (attractions, racing)
 *   - bowlingHold → QAMF bowling reservation
 *
 * At least one must be present. Both can coexist for mixed carts.
 * All items → one Square deposit order → one checkout.
 */

interface CartItem {
  attraction: string;
  attractionName: string;
  product: { name: string; productId: number };
  date: string;
  time: { block: { start: string } };
  quantity: number;
  billLineId: string | null;
  color: string;
}

/** Shape of racerAssignments sessionStorage blob (saved by racing wizard). */
interface RacerAssignment {
  racerName: string;
  personId: string | null;
  product: string;
  productId: string;
  tier: string;
  track: string;
  category: string;
  heatName: string;
  heatStart: string;
  heatStop: string | null;
}

/** Shape of the bowlingHold sessionStorage blob (saved by BowlingWizard). */
interface BowlingHoldData {
  qamfReservationId: string;
  centerId: number;
  locationKey: string;
  squareCenterCode: string;
  webOfferId: string;
  optionId?: string;
  optionType?: string;
  bookedAt: string;
  service: string;
  players: Array<{ name?: string; shoeSize?: string | null }>;
  /** Guest contact — optional; contact is collected at unified checkout. */
  guest?: { name: string; email: string; phone: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lineItems: any[];
  /** Square-format line items (name + string qty + catalogObjectId) for checkout. */
  squareLineItems?: Array<{ name: string; quantity: string; catalogObjectId: string }>;
  totalCents: number;
  depositCents: number;
  notes?: string;
  kind: string;
  experienceName: string;
  timeLabel: string;
  expiresAt: string;
  /** Pre-created day-of order from the bowling wizard's quote step. */
  dayofOrderId?: string;
  dayofTotalCents?: number;
  quoteDepositCents?: number;
  squareCustomerId?: string;
  loyaltyAccountId?: string;
  loyaltyAction?: "signup" | "existing";
  rewardTierId?: string;
  rewardDiscountCents?: number;
}

interface BmiLine {
  name: string;
  quantity: number;
  amount: number;
  time: string | null;
}

type PageStep = "loading" | "contact" | "review" | "card-form" | "submitting" | "error";

export default function CheckoutPage() {
  const [orderId, setOrderId] = useState<string | null>(null);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [bowlingHold, setBowlingHold] = useState<BowlingHoldData | null>(null);
  const [racerAssignments, setRacerAssignments] = useState<RacerAssignment[]>([]);
  const [primaryPersonId, setPrimaryPersonId] = useState<string | null>(null);
  const [contact, setContact] = useState<ContactInfo | null>(null);
  const [step, setStep] = useState<PageStep>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [loyaltyPhone, setLoyaltyPhone] = useState("");

  // Review state
  const [bmiLines, setBmiLines] = useState<BmiLine[]>([]);
  const [bmiTotal, setBmiTotal] = useState(0);
  const [bmiSubtotal, setBmiSubtotal] = useState(0);
  const [bmiTax, setBmiTax] = useState(0);
  const [quoteOrderId, setQuoteOrderId] = useState<string | null>(null);
  const [quoteTotalCents, setQuoteTotalCents] = useState(0);
  const [quoteDepositCents, setQuoteDepositCents] = useState(0);
  const [clickwrapAccepted, setClickwrapAccepted] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const v2ConfirmPathRef = useRef("");

  const locationKey = getBookingLocation() || "fasttrax";
  const loyalty = useLoyalty({ locationKey: locationKey as string });

  useEffect(() => {
    const stored = sessionStorage.getItem("attractionOrderId");
    let bowlingRaw: BowlingHoldData | null = null;
    try {
      const bh = sessionStorage.getItem("bowlingHold");
      bowlingRaw = bh ? JSON.parse(bh) : null;
    } catch { /* bad JSON */ }

    if (!stored && !bowlingRaw) {
      setStep("error");
      setErrorMsg("No booking found. Start by picking an activity.");
      return;
    }
    if (stored) setOrderId(stored);
    if (bowlingRaw) setBowlingHold(bowlingRaw);
    try {
      const items = JSON.parse(sessionStorage.getItem("attractionCart") || "[]");
      setCartItems(items);
    } catch { /* empty cart */ }
    // Read racer data (racing wizard stores these for the post-confirm pipeline)
    try {
      const ra = sessionStorage.getItem("racerAssignments");
      if (ra) setRacerAssignments(JSON.parse(ra));
    } catch { /* no racer data */ }
    try {
      const pid = sessionStorage.getItem("primaryPersonId");
      if (pid) setPrimaryPersonId(pid);
    } catch { /* ignore */ }

    setStep("contact");
  }, []);

  async function handleContactSubmit(c: ContactInfo) {
    // Enroll in rewards if checkbox was checked
    if (loyalty.rewardsSignup && !loyalty.account) {
      await loyalty.enroll(c.phone, `${c.firstName} ${c.lastName}`, c.email);
    }
    setContact(c);
    setStep("review");
    // Load pricing
    await loadReview(c);
  }

  async function loadReview(c: ContactInfo) {
    if (!orderId && !bowlingHold) return;
    setReviewLoading(true);
    try {
      const ck = getBookingClientKey();
      let bmiCashTotalAmount = 0;
      let freshBmiLines: BmiLine[] = [];

      // ── BMI pricing (if attractions / racing on the bill) ──────
      if (orderId) {
        // 1. Register contact person on the BMI bill
        const regQs = new URLSearchParams({
          endpoint: "person/registerContactPerson",
          ...(ck ? { clientKey: ck } : {}),
        });
        const regBody = JSON.stringify({
          firstName: c.firstName,
          lastName: c.lastName,
          email: c.email,
          phone: c.phone.replace(/\D/g, ""),
        });
        const rawRegJson = `{"orderId":${orderId},` + regBody.slice(1);
        await fetch(`/api/bmi?${regQs.toString()}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: rawRegJson,
        });

        // 2. Get BMI bill overview for line items + pricing
        const smsQs = ck
          ? `endpoint=bill%2Foverview&billId=${orderId}&clientKey=${ck}`
          : `endpoint=bill%2Foverview&billId=${orderId}`;
        const overviewRes = await fetch(`/api/sms?${smsQs}`);
        const overview = await overviewRes.json();

        const cashTotal = overview.total?.find((t: { depositKind: number }) => t.depositKind === 0);
        const cashSub = overview.subTotal?.find((t: { depositKind: number }) => t.depositKind === 0);
        const cashTax = overview.totalTax?.find((t: { depositKind: number }) => t.depositKind === 0);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        freshBmiLines = (overview.lines || []).map((l: any) => {
          const cashPrice = l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 0);
          const lineTime = l.scheduledTime?.start || l.schedules?.[0]?.start;
          return {
            name: l.name,
            quantity: l.quantity,
            amount: cashPrice?.amount ?? 0,
            time: lineTime || null,
          };
        });

        setBmiLines(freshBmiLines);
        bmiCashTotalAmount = cashTotal?.amount ?? 0;
        setBmiTotal(bmiCashTotalAmount);
        setBmiSubtotal(cashSub?.amount ?? 0);
        setBmiTax(cashTax?.amount ?? 0);
      }

      // ── Build merged line items for Square quote ───────────────
      // Use squareLineItems (Square-format: name + string qty + catalogObjectId).
      // Falls back to lineItems for older holds, though those will fail at Square.
      const bowlingQuoteItems = bowlingHold?.squareLineItems ?? [];
      const bmiQuoteItems = freshBmiLines
        .filter((l) => l.amount > 0)
        .map((l) => ({
          name: l.name,
          quantity: String(l.quantity),
          basePriceMoney: {
            amount: Math.round((l.amount / l.quantity) * 100),
            currency: "USD",
          },
        }));

      // ── Reuse existing day-of order or create a new quote ─────
      // Bowling-only: the wizard already created a quote with dayofOrderId.
      // Mixed carts: need a merged quote with all items from both sources.
      const hasBmiQuoteItems = bmiQuoteItems.length > 0;
      const mergedPreTaxCents = (bowlingHold?.totalCents ?? 0) + Math.round(bmiCashTotalAmount * 100);

      if (!hasBmiQuoteItems && bowlingHold?.dayofOrderId) {
        // Bowling-only: reuse the wizard's existing quote order
        setQuoteOrderId(bowlingHold.dayofOrderId);
        setQuoteTotalCents(bowlingHold.dayofTotalCents ?? bowlingHold.totalCents);
        setQuoteDepositCents(bowlingHold.quoteDepositCents ?? bowlingHold.depositCents);
      } else if (mergedPreTaxCents > 0 && (bowlingQuoteItems.length > 0 || hasBmiQuoteItems)) {
        // Mixed cart or BMI-only: create a merged quote
        const mergedQuoteItems = [...bowlingQuoteItems, ...bmiQuoteItems];
        const quoteRes = await fetch("/api/attractions/v2/reserve/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ locationKey, lineItems: mergedQuoteItems, depositPct: 100 }),
        });
        if (quoteRes.ok) {
          const q = await quoteRes.json();
          setQuoteOrderId(q.dayofOrderId);
          setQuoteTotalCents(q.dayofTotalCents);
          setQuoteDepositCents(q.depositCents);
        }
      }
    } catch (err) {
      console.error("[checkout] Review load failed:", err);
    } finally {
      setReviewLoading(false);
    }
  }

  function handleBack() {
    if (step === "review" || step === "card-form") {
      setStep("contact");
      return;
    }
    const returnPath = sessionStorage.getItem("checkoutReturnPath") || "/book";
    window.location.href = returnPath;
  }

  async function handlePay() {
    if ((!orderId && !bowlingHold) || !contact) return;

    // Log clickwrap
    void fetch("/api/clickwrap/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ts: new Date().toISOString(),
        billId: orderId || bowlingHold?.qamfReservationId || "",
        email: contact.email,
        phone: contact.phone,
        firstName: contact.firstName,
        amountCents: quoteTotalCents || computedTotalCents,
        bookingType: bowlingHold ? (orderId ? "unified-cart" : "bowling") : "attractions-cart",
        policyVersion: CURRENT_POLICY_VERSION,
      }),
    }).catch(() => {});

    const totalCentsToCharge = quoteTotalCents || computedTotalCents;
    const rewardDiscount = loyalty.selectedRewardTier?.discountCents ?? 0;
    const effectiveTotal = Math.max(0, totalCentsToCharge - rewardDiscount);

    // $0 total — skip card form
    if (effectiveTotal === 0) {
      setStep("submitting");
      try {
        const res = await callCheckoutV2(undefined);
        if (!res.ok) throw new Error((await res.json()).error || "Checkout failed");
        const data = await res.json();
        saveConfirmationData(data);
        cleanupCart();
        window.location.href = data.shortCode
          ? `/book/checkout/confirmation?code=${data.shortCode}`
          : "/book/checkout/confirmation";
      } catch (err) {
        setStep("error");
        setErrorMsg(err instanceof Error ? err.message : "Checkout failed");
      }
      return;
    }

    setStep("card-form");
  }

  async function callCheckoutV2(squareToken?: string): Promise<Response> {
    if (!orderId && !bowlingHold) throw new Error("Missing orderId and bowlingHold");
    if (!contact) throw new Error("Missing contact");

    const ck = getBookingClientKey();
    const rewardDiscount = loyalty.selectedRewardTier?.discountCents ?? 0;

    // BMI line items (attractions + racing)
    const bmiLineItems = bmiLines
      .filter((l) => l.amount > 0)
      .map((l) => ({
        name: l.name,
        quantity: String(l.quantity),
        basePriceMoney: {
          amount: Math.round((l.amount / l.quantity) * 100),
          currency: "USD",
        },
      }));

    const requestBody = {
      // BMI fields — optional for bowling-only
      ...(orderId ? {
        bmiBillId: orderId,
        bmiCreditOnly: bmiTotalCents === 0, // true when credits cover entire BMI portion
        items: cartItems.map((item) => ({
          attractionSlug: item.attraction,
          name: item.attractionName || item.product.name,
          quantity: item.quantity,
          bookedAt: item.time?.block?.start || item.date,
          billLineId: item.billLineId || undefined,
        })),
        lineItems: bmiLineItems,
      } : {}),
      locationKey,
      guest: {
        name: `${contact.firstName} ${contact.lastName}`,
        email: contact.email,
        phone: contact.phone,
      },
      squareToken,
      squareCustomerId: loyalty.account?.customerId || undefined,
      totalCents: quoteTotalCents || computedTotalCents,
      existingDayofOrderId: quoteOrderId || undefined,
      existingDayofTotalCents: quoteTotalCents || undefined,
      existingDepositCents: quoteDepositCents || undefined,
      clientKey: ck || undefined,
      smsOptIn: contact.smsOptIn,
      // Bowling hold — optional for attractions-only
      ...(bowlingHold ? { bowlingHold } : {}),
      // Racing data — racer assignments + primary person ID for post-confirm pipeline
      ...(racerAssignments.length > 0
        ? {
            racerData: racerAssignments.map((r) => ({
              name: r.racerName,
              personId: r.personId || undefined,
              product: r.product,
              track: r.track || undefined,
              heatStart: r.heatStart || undefined,
            })),
          }
        : {}),
      ...(primaryPersonId ? { primaryPersonId } : {}),
      // Loyalty
      ...(loyalty.selectedRewardTier && loyalty.account
        ? {
            rewardTierId: loyalty.selectedRewardTier.id,
            loyaltyAccountId: loyalty.account.id,
            rewardDiscountCents: rewardDiscount,
            loyaltyAction: loyalty.isNewSignup ? "signup" as const : "existing" as const,
          }
        : loyalty.account
          ? { loyaltyAction: loyalty.isNewSignup ? "signup" as const : "existing" as const }
          : {}),
    };

    return fetch("/api/checkout/v2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
  }

  function cleanupCart() {
    sessionStorage.removeItem("attractionCart");
    sessionStorage.removeItem("attractionOrderId");
    sessionStorage.removeItem("bowlingHold");
    sessionStorage.removeItem("racerAssignments");
    sessionStorage.removeItem("primaryPersonId");
    sessionStorage.removeItem("checkoutReturnPath");
    try { window.dispatchEvent(new CustomEvent("cart:changed")); } catch { /* SSR */ }
  }

  /** Save confirmation data so the confirmation page can display it without another API call. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function saveConfirmationData(apiResponse: any) {
    try {
      // Strip internal gift card info — customers should never see the GAN.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { squareGiftCardGan: _gan, squareGiftCardId: _gid, ...safeResponse } = apiResponse;

      // Determine what's in the cart for the confirmation page sections
      const isRacingCart = racerAssignments.length > 0;
      const hasBowling = !!bowlingHold;

      sessionStorage.setItem("checkoutConfirmation", JSON.stringify({
        ...safeResponse,
        // Add display data from cart (cart is about to be cleared)
        bowling: hasBowling ? {
          experienceName: bowlingHold!.experienceName,
          timeLabel: bowlingHold!.timeLabel,
          bookedAt: bowlingHold!.bookedAt,
          locationKey: bowlingHold!.locationKey,
          kind: bowlingHold!.kind,
          players: bowlingHold!.players || [],
          totalCents: bowlingHold!.totalCents,
          depositCents: bowlingHold!.depositCents,
          lineItems: (bowlingHold!.squareLineItems || []).map((li) => ({
            name: li.name,
            quantity: li.quantity,
          })),
        } : null,
        attractions: cartItems.map((item) => ({
          name: item.attractionName || item.product.name,
          quantity: item.quantity,
          date: item.date,
          time: item.time?.block?.start || null,
        })),
        guestName: contact?.firstName ? `${contact.firstName} ${contact.lastName}` : null,
        guestEmail: contact?.email || null,
        // ── Phase 3 additions for dynamic confirmation page ──
        // Bowling: first Neon ID + short code for useBowlingConfirmation hook
        bowlingNeonId: hasBowling && safeResponse.neonIds?.[0] ? safeResponse.neonIds[0] : null,
        bowlingShortCode: safeResponse.shortCode ?? null,
        bowlingKind: hasBowling ? bowlingHold!.kind : null,
        // Racing: bill ID + racer assignments for useRacingConfirmation hook
        bmiBillId: orderId ?? null,
        racerAssignments: isRacingCart ? racerAssignments : null,
        primaryPersonId: primaryPersonId ?? null,
        isRacingCart,
      }));
    } catch { /* non-fatal — confirmation page has fallback */ }
  }

  function handlePaymentSuccess(_result: PaymentResult) {
    cleanupCart();
    // v2ConfirmPathRef is set by customPaymentHandler before onSuccess fires.
    // Fallback to /book in the unlikely case it's empty (shouldn't happen).
    window.location.href = v2ConfirmPathRef.current || "/book";
  }

  function handlePaymentError(error: string) {
    setStep("error");
    setErrorMsg(error);
  }

  // ── Computed values ──────────────────────────────────────────────
  const bowlingTotalCents = bowlingHold?.totalCents ?? 0;
  const bmiTotalCents = Math.round(bmiTotal * 100);
  const computedTotalCents = bowlingTotalCents + bmiTotalCents;
  const displayTotalCents = quoteTotalCents || computedTotalCents;
  const rewardDiscount = loyalty.selectedRewardTier?.discountCents ?? 0;
  const effectiveTotalCents = Math.max(0, displayTotalCents - rewardDiscount);
  const displayTotal = (effectiveTotalCents / 100).toFixed(2);
  const primaryColor = cartItems[0]?.color || "#00E2E5";
  const hasBowling = !!bowlingHold;
  const hasBmi = !!orderId;
  const totalItemCount = cartItems.length + (hasBowling ? 1 : 0);

  return (
    <div className="min-h-screen bg-[#000418]">
      <BrandNav />

      <div className="max-w-3xl mx-auto px-4 pt-32 sm:pt-36 pb-16">

        {step === "loading" && (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
          </div>
        )}

        {step === "error" && (
          <div className="text-center space-y-4 py-16">
            <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto">
              <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="text-red-400 text-sm">{errorMsg}</p>
            <Link href="/book" className="text-[#00E2E5] underline text-sm">Browse experiences</Link>
          </div>
        )}

        {/* ── Contact Step ─────────────────────────────────── */}
        {step === "contact" && (
          <div className="max-w-lg mx-auto space-y-6">
            <div>
              <button onClick={handleBack} className="text-white/40 hover:text-white/70 text-sm mb-4 transition-colors">
                ← Back to cart
              </button>
              <div className="text-center">
                <h1 className="text-3xl font-display text-white uppercase tracking-widest mb-2">Checkout</h1>
                <p className="text-white/40 text-sm">
                  {totalItemCount} item{totalItemCount !== 1 ? "s" : ""} in your cart
                </p>
              </div>
            </div>
            <ContactForm
              initial={contact}
              onSubmit={handleContactSubmit}
              onBack={handleBack}
              onPhoneChange={(phone) => {
                const digits = phone.replace(/\D/g, "").slice(0, 10);
                setLoyaltyPhone(phone);
                loyalty.handlePhoneChange(digits);
              }}
              afterPhone={
                <LoyaltySection
                  loyalty={loyalty}
                  phone={loyaltyPhone}
                  depositCents={displayTotalCents}
                  accentColor={primaryColor}
                />
              }
              prefill={loyalty.customer ? {
                firstName: loyalty.customer.firstName || undefined,
                lastName: loyalty.customer.lastName || undefined,
                email: loyalty.customer.email || undefined,
              } : contact ? {
                firstName: contact.firstName || undefined,
                lastName: contact.lastName || undefined,
                email: contact.email || undefined,
              } : undefined}
            />
          </div>
        )}

        {/* ── Review Step ──────────────────────────────────── */}
        {step === "review" && contact && (
          <div className="max-w-lg mx-auto space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">Review & Pay</h2>
            </div>

            {reviewLoading ? (
              <div className="flex flex-col items-center gap-3 py-12">
                <div className="w-8 h-8 border-2 border-white/20 rounded-full animate-spin" style={{ borderTopColor: primaryColor }} />
                <p className="text-white/50 text-sm">Loading order details...</p>
              </div>
            ) : (
              <>
                {/* Line items */}
                <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4 space-y-3">
                  {/* ── Bowling section ───────────────────────── */}
                  {hasBowling && (
                    <>
                      {(hasBmi) && (
                        <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-wider">
                          🎳 Bowling
                        </p>
                      )}
                      <div className="flex justify-between text-sm">
                        <div>
                          <span className="text-white/80">{bowlingHold!.experienceName}</span>
                          <span className="text-white/25 text-xs block">{bowlingHold!.timeLabel}</span>
                          <span className="text-white/30 text-xs">
                            {bowlingHold!.players?.length || 1} player{(bowlingHold!.players?.length || 1) !== 1 ? "s" : ""}
                          </span>
                        </div>
                        <span className="text-white/60">${(bowlingTotalCents / 100).toFixed(2)}</span>
                      </div>
                      {hasBmi && <div className="border-t border-white/8 my-1" />}
                    </>
                  )}

                  {/* ── BMI attractions / racing section ──────── */}
                  {hasBmi && bmiLines.length > 0 && (
                    <>
                      {hasBowling && (
                        <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-wider">
                          🎯 Attractions
                        </p>
                      )}
                      {bmiLines.map((line, i) => (
                        <div key={i} className="flex justify-between text-sm">
                          <div>
                            <span className="text-white/80">{line.name}</span>
                            {line.quantity > 1 && <span className="text-white/30 ml-1">x{line.quantity}</span>}
                            {line.time && (
                              <span className="text-white/25 text-xs block">
                                {new Date(line.time.replace(/Z$/, "")).toLocaleTimeString("en-US", {
                                  hour: "numeric",
                                  minute: "2-digit",
                                  hour12: true,
                                })}
                              </span>
                            )}
                          </div>
                          <span className="text-white/60">${line.amount.toFixed(2)}</span>
                        </div>
                      ))}
                    </>
                  )}

                  <div className="border-t border-white/8 pt-2 space-y-1">
                    {bmiTax > 0 && (
                      <div className="flex justify-between text-xs text-white/35">
                        <span>Tax</span>
                        <span>${bmiTax.toFixed(2)}</span>
                      </div>
                    )}
                    {rewardDiscount > 0 && (
                      <div className="flex justify-between text-xs text-[#FFD700]">
                        <span>HeadPinz Reward</span>
                        <span>-${(rewardDiscount / 100).toFixed(2)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-base font-bold pt-1">
                      <span className="text-white">Total</span>
                      <span style={{ color: primaryColor }}>${displayTotal}</span>
                    </div>
                  </div>
                </div>

                {/* Contact summary */}
                <div className="rounded-xl border border-white/8 bg-white/3 p-4 text-xs text-white/40 leading-relaxed">
                  Confirmation will be sent to <span className="text-white/70">{contact.email}</span>.
                  {effectiveTotalCents > 0 && " Payment handled securely by Square."}
                </div>

                <ClickwrapCheckbox checked={clickwrapAccepted} onChange={setClickwrapAccepted} />

                <div className="flex items-center justify-between gap-4">
                  <button onClick={handleBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">
                    ← Back
                  </button>
                  <button
                    onClick={handlePay}
                    disabled={!clickwrapAccepted}
                    className="inline-flex items-center gap-2 px-8 py-3.5 rounded-xl font-bold text-sm text-[#000418] hover:brightness-110 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: primaryColor, boxShadow: `0 10px 25px ${primaryColor}40` }}
                  >
                    {effectiveTotalCents === 0 ? "Confirm Free Booking →" : `Pay $${displayTotal} →`}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Card Form Step ───────────────────────────────── */}
        {step === "card-form" && contact && (
          <PaymentForm
            amount={effectiveTotalCents / 100}
            itemName={[
              ...(hasBowling ? [bowlingHold!.experienceName] : []),
              ...cartItems.map((i) => i.attractionName || i.product.name),
            ].join(" + ")}
            billId={orderId || bowlingHold?.qamfReservationId || ""}
            contact={{
              firstName: contact.firstName,
              lastName: contact.lastName,
              email: contact.email,
              phone: contact.phone,
            }}
            locationId={locationKey}
            onSuccess={handlePaymentSuccess}
            onError={handlePaymentError}
            onCancel={() => setStep("review")}
            customPaymentHandler={async (token, isSavedCard) => {
              const res = await callCheckoutV2(isSavedCard ? undefined : token);
              const data = await res.json();
              if (!res.ok || data.error) throw new Error(data.error || "Checkout failed");
              saveConfirmationData(data);
              v2ConfirmPathRef.current = data.shortCode
                ? `/book/checkout/confirmation?code=${data.shortCode}`
                : "/book/checkout/confirmation";
              return {
                paymentId: data.squareDepositPaymentId || "",
                orderId: data.squareDayofOrderId || orderId || "",
                cardBrand: null,
                cardLast4: null,
                amount: data.depositPaidCents / 100,
                receiptUrl: null,
                savedCardId: null,
              };
            }}
          />
        )}

        {/* ── Submitting ───────────────────────────────────── */}
        {step === "submitting" && (
          <div className="flex flex-col items-center gap-4 py-16">
            <div className="w-10 h-10 border-2 border-white/20 rounded-full animate-spin" style={{ borderTopColor: primaryColor }} />
            <p className="text-white/60 text-sm">Confirming your booking...</p>
          </div>
        )}
      </div>
    </div>
  );
}
