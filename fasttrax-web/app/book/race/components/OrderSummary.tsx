"use client";

import { useState, useEffect, useRef } from "react";
import type { ClassifiedProduct, BmiProposal, BmiBlock, PackSchedule } from "../data";
import { getAcknowledgements, calculateTax, calculateTotal, bmiPost } from "../data";
import type { ContactInfo } from "./ContactForm";

// ── Types ────────────────────────────────────────────────────────────────────

/** Result from PackHeatPicker after all pack heats are booked */
export interface PackBookingResult {
  billId: string; // this is the orderId
  schedules: PackSchedule[];
}

export interface BookingItem {
  product: ClassifiedProduct;
  quantity: number;
  proposal: BmiProposal;
  block: BmiBlock;
  /** Real price from availability proposal (includes day/time pricing) */
  blockPrice?: number;
}

interface OrderSummaryProps {
  /** All bookings to process (adult + junior if applicable) */
  bookings: BookingItem[];
  date: string;
  contact: ContactInfo;
  onBack: () => void;
  /** For pack bookings -- order was already created during heat selection */
  packResult?: PackBookingResult;
  /** The pack product that was selected */
  packProduct?: ClassifiedProduct;
}

type BookingState =
  | { status: "idle" }
  | { status: "booking" }
  | { status: "booked"; orderId: string }
  | { status: "paying" }
  | { status: "confirmed" }
  | { status: "error"; message: string };

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDate(dateStr: string) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

// ── Component ────────────────────────────────────────────────────────────────

export default function OrderSummary({
  bookings,
  date,
  contact,
  onBack,
  packResult,
  packProduct,
}: OrderSummaryProps) {
  const [state, setState] = useState<BookingState>({ status: "idle" });
  const bookingStarted = useRef(false);

  // Computed pricing — prefer real block price from availability over catalog price
  const isPack = !!packResult;
  const subtotal = isPack && packProduct
    ? packProduct.price
    : bookings.reduce((sum, b) => sum + (b.blockPrice ?? b.product.price) * b.quantity, 0);
  const tax = calculateTax(subtotal);
  const total = calculateTotal(subtotal);

  // Auto-start booking process when component mounts
  useEffect(() => {
    if (bookingStarted.current) return;
    bookingStarted.current = true;
    runBookingFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runBookingFlow() {
    setState({ status: "booking" });
    try {
      let orderId: string | null = null;
      let parentBillLineId: string | number | null = null;

      if (packResult) {
        // ── Pack booking: order already created during heat selection ──
        orderId = packResult.billId;

        // Add acknowledgements for the pack
        const category = packProduct?.category ?? "adult";
        const ackProductIds = getAcknowledgements(category);
        if (ackProductIds.length > 0) {
          for (const ackId of ackProductIds) {
            await bmiPost("booking/sell", {
              ProductId: ackId,
              Quantity: 1,
              OrderId: orderId,
              ParentOrderItemId: parentBillLineId,
            });
          }
        }
      } else {
        // ── Regular booking flow ──────────────────────────────────────
        for (let i = 0; i < bookings.length; i++) {
          const { product, quantity, proposal, block } = bookings[i];

          const bookPayload = {
            productId: product.productId,
            quantity,
            resourceId: block.resourceId || -1,
            proposal: {
              blocks: proposal.blocks.map((pb) => ({
                productLineIds: pb.productLineIds,
                block: pb.block,
              })),
              productLineId: proposal.productLineId,
            },
            contactPerson: i === 0
              ? {
                  firstName: contact.firstName,
                  lastName: contact.lastName,
                  email: contact.email,
                  phone: contact.phone.replace(/\D/g, ""),
                }
              : undefined,
          };

          if (i === 0) {
            // First booking creates the order
            const bookResult = await bmiPost("booking/book", bookPayload);

            if (!bookResult.success && bookResult.errorMessage) {
              throw new Error(bookResult.errorMessage);
            }

            orderId = String(bookResult.orderId);
            parentBillLineId = bookResult.parentBillLineId ?? null;
            if (!orderId || orderId === "undefined") {
              throw new Error("No order ID returned from booking");
            }

            // Add acknowledgements for this booking
            const ackProductIds = getAcknowledgements(product.category);
            for (const ackId of ackProductIds) {
              await bmiPost("booking/sell", {
                ProductId: ackId,
                Quantity: 1,
                OrderId: orderId,
                ParentOrderItemId: parentBillLineId,
              });
            }
          } else {
            // Subsequent bookings: use booking/sell to add to existing order
            const sellResult = await bmiPost("booking/sell", {
              ProductId: product.productId,
              Quantity: quantity,
              OrderId: orderId,
              ResourceId: block.resourceId || -1,
              Proposal: {
                blocks: proposal.blocks.map((pb) => ({
                  productLineIds: pb.productLineIds,
                  block: pb.block,
                })),
                productLineId: proposal.productLineId,
              },
            });

            if (!sellResult.success && sellResult.errorMessage) {
              throw new Error(sellResult.errorMessage);
            }

            const sellParentId = sellResult.orderItemId ?? parentBillLineId;

            // Add acknowledgements
            const ackProductIds = getAcknowledgements(product.category);
            for (const ackId of ackProductIds) {
              await bmiPost("booking/sell", {
                ProductId: ackId,
                Quantity: 1,
                OrderId: orderId,
                ParentOrderItemId: sellParentId,
              });
            }
          }
        }
      }

      // Register contact person
      try {
        await bmiPost("person/registerContactPerson", {
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          phone: contact.phone.replace(/\D/g, ""),
          orderId,
        });
      } catch {
        // Non-fatal -- contact registration failure shouldn't block booking
      }

      setState({ status: "booked", orderId: orderId! });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Something went wrong",
      });
    }
  }

  async function handleConfirm() {
    if (state.status !== "booked") return;
    const { orderId } = state;

    setState({ status: "paying" });
    try {
      const raceName = bookings[0]?.product.name || "FastTrax Race Booking";
      const returnUrl = `${window.location.origin}/book/race/confirmation?orderId=${orderId}`;

      // Create Square checkout via our own API
      const res = await fetch("/api/square/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          billId: orderId,
          amount: total,
          raceName,
          returnUrl,
          cancelUrl: `${window.location.origin}/book/race`,
        }),
      });

      const data = await res.json();
      console.log("[square/checkout]", data);

      if (data.checkoutUrl) {
        // Redirect to Square payment page
        window.location.href = data.checkoutUrl;
      } else {
        throw new Error(data.error || "Failed to create payment link");
      }
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Payment failed to start",
      });
    }
  }

  // ── Loading state ──────────────────────────────────────────────────────────

  if (state.status === "booking") {
    return (
      <div className="min-h-[400px] flex flex-col items-center justify-center gap-4">
        <div className="w-10 h-10 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
        <p className="text-white/60 text-sm">
          Reserving your heat{bookings.length > 1 ? "s" : ""}...
        </p>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────

  if (state.status === "error") {
    return (
      <div className="min-h-[400px] flex flex-col items-center justify-center gap-4 max-w-md mx-auto text-center">
        <div className="text-4xl">!</div>
        <p className="text-white font-bold text-lg">Booking Failed</p>
        <p className="text-red-400 text-sm">{state.message}</p>
        <button
          onClick={onBack}
          className="mt-2 text-sm text-white/50 hover:text-white underline"
        >
          Go back and try again
        </button>
      </div>
    );
  }

  // ── Paying state ──────────────────────────────────────────────────────────

  if (state.status === "paying") {
    return (
      <div className="min-h-[400px] flex flex-col items-center justify-center gap-6 max-w-md mx-auto text-center">
        <div className="relative w-full h-16 overflow-hidden">
          <div className="absolute top-1/2 left-0 w-full h-px bg-white/10" />
          <div className="absolute top-1/2 -translate-y-1/2 animate-[race_2s_ease-in-out_infinite] text-4xl">
            🏎️
          </div>
        </div>
        <style>{`
          @keyframes race {
            0% { left: -10%; }
            50% { left: 90%; }
            100% { left: -10%; }
          }
        `}</style>
        <div>
          <p className="text-white font-display text-xl uppercase tracking-widest mb-2">
            Heading to Payment
          </p>
          <p className="text-white/40 text-sm">
            Setting up your secure checkout…
          </p>
        </div>
        <div className="flex gap-1">
          {[0, 1, 2].map(i => (
            <div
              key={i}
              className="w-2 h-2 rounded-full bg-[#00E2E5]"
              style={{ animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite` }}
            />
          ))}
        </div>
        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 0.2; transform: scale(0.8); }
            50% { opacity: 1; transform: scale(1.2); }
          }
        `}</style>
      </div>
    );
  }

  // ── Main UI ────────────────────────────────────────────────────────────────

  const isBooked = state.status === "booked";
  const isPaying = false; // handled above

  return (
    <div className="space-y-6 max-w-lg mx-auto">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">
          {isBooked ? "Review & Confirm" : "Preparing Order..."}
        </h2>
        {isBooked && (
          <p className="text-white/50 text-sm">
            Your heat{bookings.length > 1 ? "s are" : " is"} reserved. Confirm
            your booking below.
          </p>
        )}
      </div>

      {/* Booking summary cards */}
      {isPack && packResult && packProduct ? (
        // Pack booking -- show all scheduled races
        <div className="rounded-xl border border-white/10 bg-white/5 divide-y divide-white/[0.08]">
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
                <p className="text-white/40 text-xs mb-0.5">
                  Race {i + 1}
                  {s.trackName ? ` -- ${s.trackName} Track` : ""}
                </p>
                <p className="text-white text-sm font-medium">
                  {formatTime(s.start)} - {formatTime(s.stop)}
                </p>
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
              <p className="text-white text-sm">
                {contact.firstName} {contact.lastName}
              </p>
              <p className="text-white/50 text-xs">{contact.email}</p>
            </div>
          </div>
        </div>
      ) : (
        // Regular booking cards
        bookings.map((b, i) => (
          <div
            key={i}
            className="rounded-xl border border-white/10 bg-white/5 divide-y divide-white/[0.08]"
          >
            <div className="p-4">
              <p className="text-white/40 text-xs mb-1">
                {bookings.length > 1
                  ? `Race ${i + 1} -- ${b.product.category === "adult" ? "Adult" : "Junior"}`
                  : "Race"}
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
                <p className="text-white text-sm">
                  {b.block.name} &middot; {formatTime(b.block.start)}
                </p>
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
                  <p className="text-white text-sm">
                    {contact.firstName} {contact.lastName}
                  </p>
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
              <span className="text-white/60">
                {b.product.name} x {b.quantity}
              </span>
              <span className="text-white">
                ${((b.blockPrice ?? b.product.price) * b.quantity).toFixed(2)}
              </span>
            </div>
          ))
        )}

        <div className="border-t border-white/10 pt-2 space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-white/60">Subtotal</span>
            <span className="text-white">${subtotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-white/60">Tax (6.5%)</span>
            <span className="text-white">${tax.toFixed(2)}</span>
          </div>
          <div className="border-t border-white/10 pt-2 flex justify-between font-bold">
            <span className="text-white">Total</span>
            <span className="text-[#00E2E5] text-lg">${total.toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Info notes */}
      {isBooked && (
        <>
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 text-xs text-white/40 space-y-1">
            <p>
              &middot; Arrive{" "}
              <strong className="text-white/60">30 minutes early</strong> for
              check-in and kart assignment.
            </p>
            <p>
              &middot; A{" "}
              <strong className="text-white/60">$4.99 license fee</strong> per
              driver applies at first check-in.
            </p>
          </div>

          {/* Payment notice */}
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs text-amber-400/80 text-center">
            Payment processing coming soon -- booking will be confirmed without
            charge.
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between gap-4">
            <button
              onClick={onBack}
              disabled={isPaying}
              className="text-sm text-white/40 hover:text-white/70 disabled:opacity-30 transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleConfirm}
              disabled={isPaying}
              className="inline-flex items-center gap-2 px-8 py-4 rounded-xl font-bold text-base bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPaying ? (
                <>
                  <div className="w-4 h-4 border-2 border-[#000418]/30 border-t-[#000418] rounded-full animate-spin" />
                  Confirming...
                </>
              ) : (
                <>Confirm Booking -- ${total.toFixed(2)}</>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
