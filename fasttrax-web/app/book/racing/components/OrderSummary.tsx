"use client";

import { useState, useEffect, useRef } from "react";
import type { ClassifiedProduct, SmsProposal, SmsBlock, SmsBill } from "../data";
import { getAcknowledgements } from "../data";
import type { ContactInfo } from "./ContactForm";
import type { PackBookingResult } from "./PackHeatPicker";

export interface BookingItem {
  product: ClassifiedProduct;
  quantity: number;
  proposal: SmsProposal;
  block: SmsBlock;
}

interface OrderSummaryProps {
  /** All bookings to process (adult + junior if applicable) */
  bookings: BookingItem[];
  date: string;
  contact: ContactInfo;
  onBack: () => void;
  /** For pack bookings — bill was already created during heat selection */
  packResult?: PackBookingResult;
  /** The pack product that was selected */
  packProduct?: ClassifiedProduct;
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

export default function OrderSummary({ bookings, date, contact, onBack, packResult, packProduct }: OrderSummaryProps) {
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
      let billId: string | null = null;

      if (packResult) {
        // ── Pack booking: bill already created during heat selection ──
        billId = packResult.billId;

        // Get bill overview to find the pack product line for acknowledgements
        const bill: SmsBill = await sms("bill/overview", { billId });
        const category = packProduct?.category ?? "adult";
        // Find the main pack line (the one with the pack's productId, or just the first Karting line)
        const packLine = packProduct
          ? bill.lines.find(l => l.productId === packProduct.productId)
          : bill.lines.find(l => l.productGroup === "Karting");
        const parentBillLineId = packLine?.id ?? null;

        // Add acknowledgements
        const ackProductIds = getAcknowledgements(category);
        if (ackProductIds.length > 0 && parentBillLineId) {
          const ackPayload = ackProductIds.map(ackId => ({
            productId: ackId,
            pageId: null,
            quantity: 1,
            billId,
            parentBillLineId,
            dynamicLines: null,
            sellKind: 2,
          }));
          await sms("booking/sell", ackPayload);
        }
      } else {
        // ── Regular booking flow ──────────────────────────────────────
        // Book each item sequentially — first creates the bill, rest add to it
        for (let i = 0; i < bookings.length; i++) {
          const { product, quantity, proposal, block } = bookings[i];

          if (i === 0) {
            // First booking creates the bill
            const bookingPayload = {
              productId: product.productId,
              pageId: product.pageId,
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

            billId = bookResult.id || bookResult.billId;
            if (!billId) throw new Error("No bill ID returned from booking");
          } else {
            // Subsequent bookings add to existing bill
            const sellPayload = {
              productId: product.productId,
              pageId: product.pageId,
              quantity,
              billId,
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

            const sellResult = await sms("booking/sell", [sellPayload]);
            if (sellResult.errorMessage) {
              throw new Error(sellResult.errorMessage);
            }
          }

          // Get bill overview to add acknowledgements for this item
          const bill: SmsBill = await sms("bill/overview", { billId });
          const raceLine = bill.lines.find(l => l.productId === product.productId);
          const parentBillLineId = raceLine?.id ?? null;

          // Add acknowledgements (waivers)
          const ackProductIds = getAcknowledgements(product.category);
          if (ackProductIds.length > 0 && parentBillLineId) {
            const ackPayload = ackProductIds.map(ackId => ({
              productId: ackId,
              pageId: null,
              quantity: 1,
              billId,
              parentBillLineId,
              dynamicLines: null,
              sellKind: 2,
            }));
            await sms("booking/sell", ackPayload);
          }
        }
      }

      // Register guest contact
      try {
        await sms("reservation/registercontactperson", {
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          phone: contact.phone.replace(/\D/g, ""),
          billId,
        });
      } catch {
        // Non-fatal
      }

      // Get final bill with total
      const finalBill: SmsBill = await sms("bill/overview", { billId: billId! });
      setState({ status: "booked", billId: billId!, bill: finalBill });

    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Something went wrong" });
    }
  }

  async function handlePay() {
    if (state.status !== "booked") return;
    const { billId } = state;

    setState({ status: "paying" });
    try {
      const amount = cashTotal(state.bill);
      const paymentId = crypto.randomUUID();

      // Confirm payment via BMI Public API
      // Note: orderId must be sent as a raw number in JSON (not a string),
      // but JS loses precision on large integers. Use raw JSON construction.
      const res = await fetch(`/api/bmi?endpoint=payment/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"id":"${paymentId}","paymentTime":"${new Date().toISOString()}","amount":${amount},"orderId":${billId}}`,
      });

      const result = await res.json();
      console.log("[payment/confirm]", result);

      if (result.status === 0) {
        // Payment confirmed — redirect to confirmation
        window.location.href = `/book/racing/confirmation?billId=${billId}`;
      } else {
        throw new Error(result.errorMessage || result.Message || "Payment confirmation failed");
      }
    } catch (err) {
      console.error("[payment/confirm error]", err);
      setState({ status: "error", message: err instanceof Error ? err.message : "Payment failed" });
    }
  }

  // Computed values
  const isPack = !!packResult;
  const subtotal = isPack && packProduct
    ? packProduct.price
    : bookings.reduce((sum, b) => sum + b.product.price * b.quantity, 0);

  if (state.status === "booking") {
    return (
      <div className="min-h-[400px] flex flex-col items-center justify-center gap-4">
        <div className="w-10 h-10 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
        <p className="text-white/60 text-sm">
          Reserving your heat{bookings.length > 1 ? "s" : ""}…
        </p>
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
  const total = bill ? cashTotal(bill) : subtotal;
  const isPaying = state.status === "paying";

  return (
    <div className="space-y-6 max-w-lg mx-auto">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">
          {bill ? "Review & Pay" : "Preparing Order…"}
        </h2>
        {bill && <p className="text-white/50 text-sm">Your heat{bookings.length > 1 ? "s are" : " is"} reserved. Complete payment to confirm.</p>}
      </div>

      {/* Booking summary cards */}
      {isPack && packResult && packProduct ? (
        // Pack booking — show all scheduled races
        <div className="rounded-xl border border-white/10 bg-white/5 divide-y divide-white/8">
          <div className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
                {packResult.schedules.length}-Race Pack
              </span>
            </div>
            <p className="text-white font-bold">{packProduct.name}</p>
          </div>
          {packResult.schedules.map((s, i) => (
            <div key={i} className="p-4 flex justify-between items-center">
              <div>
                <p className="text-white/40 text-xs mb-0.5">Race {i + 1}{s.trackName ? ` — ${s.trackName} Track` : ""}</p>
                <p className="text-white text-sm font-medium">{formatTime(s.start)} → {formatTime(s.stop)}</p>
              </div>
              <p className="text-white/30 text-xs">{s.name}</p>
            </div>
          ))}
          <div className="p-4 grid grid-cols-2 gap-4">
            <div>
              <p className="text-white/40 text-xs mb-1">Date</p>
              <p className="text-white text-sm">{formatDate(date)}</p>
            </div>
            <div>
              <p className="text-white/40 text-xs mb-1">Contact</p>
              <p className="text-white text-sm">{contact.firstName} {contact.lastName}</p>
              <p className="text-white/50 text-xs">{contact.email}</p>
            </div>
          </div>
        </div>
      ) : (
        // Regular booking cards
        bookings.map((b, i) => (
          <div key={i} className="rounded-xl border border-white/10 bg-white/5 divide-y divide-white/8">
            <div className="p-4">
              <p className="text-white/40 text-xs mb-1">
                {bookings.length > 1 ? `Race ${i + 1} — ${b.product.category === "adult" ? "Adult" : "Junior"}` : "Race"}
              </p>
              <p className="text-white font-bold">{b.product.name}</p>
            </div>
            <div className="p-4 grid grid-cols-2 gap-4">
              <div>
                <p className="text-white/40 text-xs mb-1">Date</p>
                <p className="text-white text-sm">{formatDate(date)}</p>
              </div>
              <div>
                <p className="text-white/40 text-xs mb-1">Heat</p>
                <p className="text-white text-sm">{b.block.name} · {formatTime(b.block.start)}</p>
              </div>
            </div>
            <div className="p-4 grid grid-cols-2 gap-4">
              <div>
                <p className="text-white/40 text-xs mb-1">Racers</p>
                <p className="text-white text-sm">{b.quantity}</p>
              </div>
              {i === 0 && (
                <div>
                  <p className="text-white/40 text-xs mb-1">Contact</p>
                  <p className="text-white text-sm">{contact.firstName} {contact.lastName}</p>
                  <p className="text-white/50 text-xs">{contact.email}</p>
                </div>
              )}
            </div>
          </div>
        ))
      )}

      {/* Price breakdown */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
        {isPack && packProduct ? (
          <div className="flex justify-between text-sm">
            <span className="text-white/60">{packProduct.name}</span>
            <span className="text-white">${packProduct.price.toFixed(2)}</span>
          </div>
        ) : (
          bookings.map((b, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-white/60">{b.product.name} × {b.quantity}</span>
              <span className="text-white">${(b.product.price * b.quantity).toFixed(2)}</span>
            </div>
          ))
        )}
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
