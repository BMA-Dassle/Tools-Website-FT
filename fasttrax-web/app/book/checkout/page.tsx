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
 * Unified multi-item checkout page for attraction carts (v2).
 *
 * Reads orderId + cart items from sessionStorage. Shows contact form
 * with loyalty, then a review + payment step that calls /api/checkout/v2.
 *
 * Does NOT affect racing — racing has its own OrderSummary flow.
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
    if (!stored) {
      setStep("error");
      setErrorMsg("No booking found. Start by picking an activity.");
      return;
    }
    setOrderId(stored);
    try {
      const items = JSON.parse(sessionStorage.getItem("attractionCart") || "[]");
      setCartItems(items);
    } catch { /* empty cart */ }
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
    if (!orderId) return;
    setReviewLoading(true);
    try {
      const ck = getBookingClientKey();

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
      const lines: BmiLine[] = (overview.lines || []).map((l: any) => {
        const cashPrice = l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 0);
        const lineTime = l.scheduledTime?.start || l.schedules?.[0]?.start;
        return {
          name: l.name,
          quantity: l.quantity,
          amount: cashPrice?.amount ?? 0,
          time: lineTime || null,
        };
      });

      setBmiLines(lines);
      setBmiTotal(cashTotal?.amount ?? 0);
      setBmiSubtotal(cashSub?.amount ?? 0);
      setBmiTax(cashTax?.amount ?? 0);

      // 3. Create Square quote order (day-of order with tax) if total > 0
      if ((cashTotal?.amount ?? 0) > 0) {
        const quoteLineItems = lines
          .filter((l) => l.amount > 0)
          .map((l) => ({
            name: l.name,
            quantity: String(l.quantity),
            basePriceMoney: {
              amount: Math.round((l.amount / l.quantity) * 100),
              currency: "USD",
            },
          }));

        if (quoteLineItems.length > 0) {
          const quoteRes = await fetch("/api/attractions/v2/reserve/quote", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ locationKey, lineItems: quoteLineItems, depositPct: 100 }),
          });
          if (quoteRes.ok) {
            const q = await quoteRes.json();
            setQuoteOrderId(q.dayofOrderId);
            setQuoteTotalCents(q.dayofTotalCents);
            setQuoteDepositCents(q.depositCents);
          }
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
    if (!orderId || !contact) return;

    // Log clickwrap
    void fetch("/api/clickwrap/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ts: new Date().toISOString(),
        billId: orderId,
        email: contact.email,
        phone: contact.phone,
        firstName: contact.firstName,
        amountCents: quoteTotalCents || Math.round(bmiTotal * 100),
        bookingType: "attractions-cart",
        policyVersion: CURRENT_POLICY_VERSION,
      }),
    }).catch(() => {});

    const totalCentsToCharge = quoteTotalCents || Math.round(bmiTotal * 100);
    const rewardDiscount = loyalty.selectedRewardTier?.discountCents ?? 0;
    const effectiveTotal = Math.max(0, totalCentsToCharge - rewardDiscount);

    // $0 total — skip card form
    if (effectiveTotal === 0) {
      setStep("submitting");
      try {
        const res = await callCheckoutV2(undefined);
        if (!res.ok) throw new Error((await res.json()).error || "Checkout failed");
        const data = await res.json();
        cleanupCart();
        window.location.href = data.confirmationPath || `/book/${cartItems[0]?.attraction || "laser-tag"}/confirmation?neonId=${data.neonId}`;
      } catch (err) {
        setStep("error");
        setErrorMsg(err instanceof Error ? err.message : "Checkout failed");
      }
      return;
    }

    setStep("card-form");
  }

  async function callCheckoutV2(squareToken?: string): Promise<Response> {
    if (!orderId || !contact) throw new Error("Missing orderId or contact");

    const ck = getBookingClientKey();
    const rewardDiscount = loyalty.selectedRewardTier?.discountCents ?? 0;

    const requestBody = {
      bmiBillId: orderId,
      locationKey,
      items: cartItems.map((item) => ({
        attractionSlug: item.attraction,
        name: item.attractionName || item.product.name,
        quantity: item.quantity,
        bookedAt: item.time?.block?.start || item.date,
        billLineId: item.billLineId || undefined,
      })),
      guest: {
        name: `${contact.firstName} ${contact.lastName}`,
        email: contact.email,
        phone: contact.phone,
      },
      squareToken,
      squareCustomerId: loyalty.account?.customerId || undefined,
      totalCents: quoteTotalCents || Math.round(bmiTotal * 100),
      lineItems: bmiLines
        .filter((l) => l.amount > 0)
        .map((l) => ({
          name: l.name,
          quantity: String(l.quantity),
          basePriceMoney: {
            amount: Math.round((l.amount / l.quantity) * 100),
            currency: "USD",
          },
        })),
      existingDayofOrderId: quoteOrderId || undefined,
      existingDayofTotalCents: quoteTotalCents || undefined,
      existingDepositCents: quoteDepositCents || undefined,
      clientKey: ck || undefined,
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
    sessionStorage.removeItem("checkoutReturnPath");
    try { window.dispatchEvent(new CustomEvent("cart:changed")); } catch { /* SSR */ }
  }

  function handlePaymentSuccess(result: PaymentResult) {
    cleanupCart();
    if (v2ConfirmPathRef.current) {
      window.location.href = v2ConfirmPathRef.current;
    }
  }

  function handlePaymentError(error: string) {
    setStep("error");
    setErrorMsg(error);
  }

  // ── Computed values ──────────────────────────────────────────────
  const displayTotalCents = quoteTotalCents || Math.round(bmiTotal * 100);
  const rewardDiscount = loyalty.selectedRewardTier?.discountCents ?? 0;
  const effectiveTotalCents = Math.max(0, displayTotalCents - rewardDiscount);
  const displayTotal = (effectiveTotalCents / 100).toFixed(2);
  const primaryColor = cartItems[0]?.color || "#00E2E5";

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
                  {cartItems.length} item{cartItems.length !== 1 ? "s" : ""} in your cart
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
            itemName={cartItems.map((i) => i.attractionName || i.product.name).join(" + ")}
            billId={orderId || ""}
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
              v2ConfirmPathRef.current = data.confirmationPath || `/book/${cartItems[0]?.attraction || "laser-tag"}/confirmation?neonId=${data.neonId}`;
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
