"use client";

import { useState, useEffect, useRef } from "react";
import type { RaceProduct, SmsProposal, SmsBlock, SmsBill } from "../data";
import { ACKNOWLEDGEMENT_PRODUCTS } from "../data";
import type { ContactInfo } from "./ContactForm";

interface OrderSummaryProps {
  race: RaceProduct;
  date: string;
  quantity: number;
  proposal: SmsProposal;
  block: SmsBlock;
  contact: ContactInfo;
  onBack: () => void;
}

type BookingState =
  | { status: "idle" }
  | { status: "booking" }
  | { status: "booked"; billId: string; bill: SmsBill }
  | { status: "paying" }
  | { status: "error"; message: string };

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDate(dateStr: string) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function cashTotal(bill: SmsBill): number {
  const t = bill.total.find(p => p.depositKind === 0);
  return t?.amount ?? 0;
}

export default function OrderSummary({ race, date, quantity, proposal, block, contact, onBack }: OrderSummaryProps) {
  const [state, setState] = useState<BookingState>({ status: "idle" });
  const bookingStarted = useRef(false);

  // Auto-start booking process when component mounts
  useEffect(() => {
    if (bookingStarted.current) return;
    bookingStarted.current = true;
    runBookingFlow();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sms(endpoint: string, body: unknown) {
    const res = await fetch(`/api/sms?endpoint=${encodeURIComponent(endpoint)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${endpoint} failed: ${res.status}`);
    return res.json();
  }

  async function runBookingFlow() {
    setState({ status: "booking" });
    try {
      // 1. Create the booking (build proposal payload from block)
      const bookingPayload = {
        productId: race.productId,
        pageId: race.pageId,
        quantity,
        dynamicLines: null,
        sellKind: 0,
        resourceId: block.resourceId || "-1",
        proposal: {
          blocks: proposal.blocks.map(pb => ({
            productId: null,
            productLineIds: [],
            block: pb.block,
          })),
          productLineId: null,
          selected: true,
        },
      };

      const bookResult = await sms("booking/book", bookingPayload);
      if (!bookResult.success && bookResult.errorMessage) {
        throw new Error(bookResult.errorMessage);
      }

      const billId: string = bookResult.id || bookResult.billId;
      if (!billId) throw new Error("No bill ID returned from booking");

      // 2. Get bill overview to find line IDs for acknowledgements
      const bill: SmsBill = await sms("bill/overview", { billId });
      const raceLine = bill.lines.find(l => l.productId === race.productId);
      const parentBillLineId = raceLine?.id ?? null;

      // 3. Add acknowledgements (waivers) if any
      const ackProductIds = ACKNOWLEDGEMENT_PRODUCTS[race.productId] ?? [];
      if (ackProductIds.length > 0 && parentBillLineId) {
        const ackPayload = ackProductIds.map(productId => ({
          productId,
          pageId: null,
          quantity: 1,
          billId,
          parentBillLineId,
          dynamicLines: null,
          sellKind: 2,
        }));
        await sms("booking/sell", ackPayload);
      }

      // 4. Register guest contact — no login/OTP, just name+email+phone attached to the bill
      try {
        await sms("reservation/registercontactperson", {
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          phone: contact.phone.replace(/\D/g, ""), // digits only
          billId,
        });
      } catch {
        // Non-fatal — booking proceeds without an attached guest profile
      }

      // 6. Get fresh bill overview with total
      const finalBill: SmsBill = await sms("bill/overview", { billId });
      setState({ status: "booked", billId, bill: finalBill });

    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Something went wrong" });
    }
  }

  async function handlePay() {
    if (state.status !== "booked") return;
    const { billId } = state;

    setState({ status: "paying" });
    try {
      // Start payment session
      const startResult = await sms("payment/start", { billId });

      // Get Square checkout URL
      const returnUrl = `${window.location.origin}/book/racing/confirmation?billId=${billId}`;
      const payResult = await sms("genericpaymentprocessor", {
        orderId: billId,
        amount: cashTotal(state.bill),
        currency: "USD",
        paymentMode: 0,
        paymentTotalMode: 0,
        returnUrl,
        successUrl: returnUrl,
        cancelUrl: `${window.location.origin}/book/racing`,
      });

      console.log("[payment/start]", startResult);
      console.log("[genericpaymentprocessor]", payResult);

      // BMI returns a Square checkout URL — redirect directly to Square
      if (payResult.url) {
        window.location.href = payResult.url;
      } else if (payResult.data) {
        // Encrypted payload — send through BMI's payment-redirect which processes the Square callback
        const qs = new URLSearchParams({
          providerKind: String(payResult.providerKind ?? -11042),
          data: payResult.data,
          transactionId: payResult.transactionId ?? billId,
          orderId: billId,
          returnUrl,
        });
        window.location.href = `https://booking.bmileisure.com/headpinzftmyers/book/payment-redirect?${qs.toString()}`;
      } else {
        // Neither url nor data — surface the raw response so we can debug
        throw new Error(
          `Payment processor returned unexpected response: ${JSON.stringify(payResult)}`
        );
      }
    } catch (err) {
      setState({
        status: "booked",
        billId,
        bill: (state as Extract<BookingState, { status: "booked" }>).bill,
      });
      alert(err instanceof Error ? err.message : "Payment failed to start");
    }
  }

  if (state.status === "booking") {
    return (
      <div className="min-h-[400px] flex flex-col items-center justify-center gap-4">
        <div className="w-10 h-10 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
        <p className="text-white/60 text-sm">Reserving your heat…</p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="min-h-[400px] flex flex-col items-center justify-center gap-4 max-w-md mx-auto text-center">
        <div className="text-4xl">⚠️</div>
        <p className="text-white font-bold text-lg">Booking Failed</p>
        <p className="text-red-400 text-sm">{state.message}</p>
        <button onClick={onBack} className="mt-2 text-sm text-white/50 hover:text-white underline">
          ← Go back and try again
        </button>
      </div>
    );
  }

  const bill = state.status === "booked" ? state.bill : null;
  const total = bill ? cashTotal(bill) : race.price * quantity;
  const isPaying = state.status === "paying";

  return (
    <div className="space-y-6 max-w-lg mx-auto">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">
          {bill ? "Review & Pay" : "Preparing Order…"}
        </h2>
        {bill && <p className="text-white/50 text-sm">Your heat is reserved. Complete payment to confirm.</p>}
      </div>

      {/* Booking summary card */}
      <div className="rounded-xl border border-white/10 bg-white/5 divide-y divide-white/8">
        <div className="p-4">
          <p className="text-white/40 text-xs mb-1">Race</p>
          <p className="text-white font-bold">{race.displayName}</p>
        </div>
        <div className="p-4 grid grid-cols-2 gap-4">
          <div>
            <p className="text-white/40 text-xs mb-1">Date</p>
            <p className="text-white text-sm">{formatDate(date)}</p>
          </div>
          <div>
            <p className="text-white/40 text-xs mb-1">Heat</p>
            <p className="text-white text-sm">{block.name} · {formatTime(block.start)}</p>
          </div>
        </div>
        <div className="p-4 grid grid-cols-2 gap-4">
          <div>
            <p className="text-white/40 text-xs mb-1">Racers</p>
            <p className="text-white text-sm">{quantity}</p>
          </div>
          <div>
            <p className="text-white/40 text-xs mb-1">Contact</p>
            <p className="text-white text-sm">{contact.firstName} {contact.lastName}</p>
            <p className="text-white/50 text-xs">{contact.email}</p>
          </div>
        </div>
      </div>

      {/* Price breakdown */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-white/60">{race.displayName} × {quantity}</span>
          <span className="text-white">${(race.price * quantity).toFixed(2)}</span>
        </div>
        {bill && (
          <>
            <div className="flex justify-between text-sm">
              <span className="text-white/60">Tax</span>
              <span className="text-white">${(bill.totalTax.find(t => t.depositKind === 0)?.amount ?? 0).toFixed(2)}</span>
            </div>
            <div className="border-t border-white/10 pt-2 flex justify-between font-bold">
              <span className="text-white">Total</span>
              <span className="text-[#00E2E5] text-lg">${total.toFixed(2)}</span>
            </div>
          </>
        )}
        {!bill && (
          <div className="flex justify-between text-sm">
            <span className="text-white/40">Calculating tax…</span>
            <span className="text-white/40">—</span>
          </div>
        )}
      </div>

      {bill && (
        <>
          <div className="rounded-xl border border-white/8 bg-white/3 p-4 text-xs text-white/40 space-y-1">
            <p>· Arrive <strong className="text-white/60">30 minutes early</strong> for check-in and kart assignment.</p>
            <p>· A <strong className="text-white/60">$4.99 license fee</strong> per driver applies at first check-in.</p>
            <p>· Payment processed securely via <strong className="text-white/60">Square</strong>.</p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <button onClick={onBack} disabled={isPaying} className="text-sm text-white/40 hover:text-white/70 disabled:opacity-30 transition-colors">
              ← Back
            </button>
            <button
              onClick={handlePay}
              disabled={isPaying}
              className="inline-flex items-center gap-2 px-8 py-4 rounded-xl font-bold text-base bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPaying ? (
                <>
                  <div className="w-4 h-4 border-2 border-[#000418]/30 border-t-[#000418] rounded-full animate-spin" />
                  Redirecting…
                </>
              ) : (
                <>Pay ${total.toFixed(2)} →</>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
