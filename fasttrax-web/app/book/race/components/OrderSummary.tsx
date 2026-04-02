"use client";

import { useState, useEffect, useRef } from "react";
import type { ClassifiedProduct, BmiProposal, BmiBlock, PackSchedule } from "../data";
import { getAcknowledgements, calculateTax, calculateTotal, bmiGet, bmiPost } from "../data";
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
  /** Verified returning racer's BMI person ID */
  personId?: string;
  /** Callback when BMI order is created — for cleanup on back navigation */
  onOrderCreated?: (orderId: string) => void;
  /** Callback to remove a booking item — goes back to heat selection */
  onRemoveBooking?: (index: number) => void;
  /** Selected add-on activities */
  addOns?: { id: string; name: string; price: number; quantity: number; perPerson: boolean; proposal?: unknown; block?: unknown; selectedTime?: string }[];
  /** Selected POV cameras */
  pov?: { id: string; quantity: number; price: number } | null;
  /** Callback to remove an add-on by its index in the addOns array */
  onRemoveAddOn?: (index: number) => void;
  /** Callback to remove POV */
  onRemovePov?: () => void;
}

type BookingState =
  | { status: "idle" }
  | { status: "booking" }
  | { status: "booked"; orderId: string; isCreditOrder: boolean; cashOwed: number; creditApplied: number; bmiTotal: number; bmiSubtotal: number; bmiTax: number; bmiLines: { name: string; quantity: number; amount: number }[] }
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
  personId,
  onOrderCreated,
  onRemoveBooking,
  addOns = [],
  pov,
  onRemoveAddOn,
  onRemovePov,
}: OrderSummaryProps) {
  const [state, setState] = useState<BookingState>({ status: "idle" });
  const effectRan = useRef(false);

  // Computed pricing — prefer real block price from availability over catalog price
  const isPack = !!packResult;
  const subtotal = isPack && packProduct
    ? packProduct.price
    : bookings.reduce((sum, b) => sum + (b.blockPrice ?? b.product.price) * b.quantity, 0);
  const tax = calculateTax(subtotal);
  const total = calculateTotal(subtotal);

  // Auto-start booking process when component mounts
  // React strict mode guard: track across mount/unmount/remount cycle
  useEffect(() => {
    if (effectRan.current) return;
    effectRan.current = true;
    runBookingFlow();
    return () => {
      // In strict mode, this cleanup runs before remount.
      // Do NOT reset effectRan — we want to prevent double booking.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runBookingFlow() {
    console.log("[runBookingFlow] STARTED, effectRan:", effectRan.current);
    setState({ status: "booking" });
    try {
      let orderId: string | null = null;
      let lastBookPrices: { amount: number; depositKind: number }[] | null = null;

      if (packResult) {
        orderId = packResult.billId;
      } else {
        // ── Build the bill: book each category ──────────────────────────
        for (let i = 0; i < bookings.length; i++) {
          const { product, quantity, proposal, block } = bookings[i];

          const bookPayload: Record<string, unknown> = {
            productId: String(product.productId),
            quantity,
            resourceId: Number(block.resourceId) || -1,
            proposal: {
              blocks: proposal.blocks.map((pb) => ({
                productLineIds: pb.productLineIds || [],
                block: {
                  ...pb.block,
                  resourceId: Number(pb.block.resourceId) || -1,
                },
              })),
              productLineId: proposal.productLineId ?? null,
            },
          };

          // First booking: include contact (WITHOUT personId — added later via registerContactPerson)
          if (i === 0) {
            bookPayload.contactPerson = {
              firstName: contact.firstName,
              lastName: contact.lastName,
              email: contact.email,
              phone: contact.phone.replace(/\D/g, ""),
            };
          }

          // Add to existing bill if not first
          if (orderId) {
            bookPayload.orderId = orderId;
          }

          const result = await bmiPost("booking/book", bookPayload);

          if (result.success === false) {
            throw new Error(result.errorMessage || "Booking failed");
          }

          // Capture prices from response for credit detection
          if (result.prices) lastBookPrices = result.prices;

          if (!orderId) {
            orderId = String(result.orderId);
            if (!orderId || orderId === "undefined" || orderId === "0") {
              throw new Error("No order ID returned from booking");
            }
            onOrderCreated?.(orderId);
          }
        }
      }

      // ── Add POV and add-ons to the bill BEFORE registerContactPerson ──
      // registerContactPerson (especially with personId) can convert the
      // order to a reservation, so all items must be on the bill first.

      // POV: use SMS-Timing sell (no time slot needed, preserves bill)
      if (pov && pov.quantity > 0) {
        try {
          console.log("[POV sell]", { productId: pov.id, quantity: pov.quantity, billId: orderId });
          const povRes = await fetch("/api/sms?endpoint=booking%2Fsell", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify([{
              productId: pov.id,
              pageId: null,
              quantity: pov.quantity,
              billId: orderId,
              dynamicLines: null,
              sellKind: 0,
            }]),
          });
          const povResult = await povRes.json();
          console.log("[POV sell result]", povRes.status, JSON.stringify(povResult));
        } catch (err) {
          console.error("[POV sell error]", err);
        }
      }

      // Activity add-ons: use BMI booking/book (same as races) to add to existing order
      console.log("[add-ons] processing", addOns.length, "add-ons, with proposal:", addOns.map(a => ({ id: a.id, name: a.name, qty: a.quantity, hasProposal: !!a.proposal })));
      for (const addon of addOns.filter(a => a.quantity > 0 && a.proposal)) {
        try {
          const block = (addon.proposal as { blocks: { block: Record<string, unknown>; productLineIds?: string[] }[] }).blocks[0];
          const addonPayload = {
            productId: String(addon.id),
            quantity: addon.quantity,
            resourceId: Number((addon.block as { resourceId?: string })?.resourceId) || -1,
            orderId,
            proposal: {
              blocks: [{
                productLineIds: block.productLineIds || [],
                block: {
                  ...block.block,
                  resourceId: Number((block.block as Record<string, unknown>).resourceId) || -1,
                },
              }],
              productLineId: (addon.proposal as { productLineId?: string }).productLineId ?? null,
            },
          };
          console.log("[add-on book]", addon.name, JSON.stringify(addonPayload, null, 2));
          const result = await bmiPost("booking/book", addonPayload);
          console.log("[add-on book result]", addon.name, JSON.stringify(result));
        } catch (err) {
          console.error("[add-on book error]", addon.name, err);
        }
      }

      // ── Now register contact and get overview ──────────────────────────
      // Step 1: Register contact WITHOUT personId (so order persists)
      try {
        await bmiPost("person/registerContactPerson", {
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          phone: contact.phone.replace(/\D/g, ""),
          orderId,
        });
      } catch { /* non-fatal */ }

      // Step 2: Get overview
      let bmiTotal = total;
      let bmiSubtotal = subtotal;
      let bmiTax = tax;
      let bmiLines: { name: string; quantity: number; amount: number }[] = [];
      let isCreditOrder = false;
      let cashOwed = total;
      let creditApplied = 0;

      try {
        let overview = await bmiGet(`order/${orderId}/overview`);

        // Step 3: If returning racer, link personId to apply credits, then re-fetch
        if (personId) {
          try {
            await bmiPost("person/registerContactPerson", {
              personId: Number(personId),
              firstName: contact.firstName,
              lastName: contact.lastName,
              email: contact.email,
              phone: contact.phone.replace(/\D/g, ""),
              orderId,
            });
            // Re-fetch overview with credits applied
            overview = await bmiGet(`order/${orderId}/overview`);
          } catch { /* credits couldn't be applied — use cash totals */ }
        }

        // Extract totals
        const cashTotal = overview.total?.find((t: { depositKind: number }) => t.depositKind === 0);
        const creditTotal = overview.total?.find((t: { depositKind: number }) => t.depositKind === 2);
        const cashSub = overview.subTotal?.find((t: { depositKind: number }) => t.depositKind === 0);
        const cashTax = overview.totalTax?.find((t: { depositKind: number }) => t.depositKind === 0);

        if (cashTotal) { bmiTotal = cashTotal.amount; cashOwed = cashTotal.amount; }
        if (cashSub) bmiSubtotal = cashSub.amount;
        if (cashTax) bmiTax = cashTax.amount;
        if (creditTotal) creditApplied = Math.abs(creditTotal.amount);

        if (creditTotal && (!cashTotal || cashTotal.amount === 0)) {
          isCreditOrder = true;
          cashOwed = 0;
          bmiTotal = 0;
        }

        // Extract line items
        if (overview.lines) {
          bmiLines = overview.lines.map((l: { name: string; quantity: number; totalPrice?: { amount: number; depositKind: number }[] }) => {
            const cashPrice = l.totalPrice?.find(p => p.depositKind === 0);
            return { name: l.name, quantity: l.quantity, amount: cashPrice?.amount ?? 0 };
          });
        }
      } catch {
        // Fallback to local calculation
        if (personId) {
          const totalRacers = bookings.reduce((s, b) => s + b.quantity, 0);
          creditApplied = 1;
          const perRacer = totalRacers > 0 ? total / totalRacers : total;
          cashOwed = Math.max(0, total - perRacer);
          isCreditOrder = cashOwed < 0.01;
          if (isCreditOrder) cashOwed = 0;
        }
        bmiLines = bookings.map(b => ({
          name: b.product.name,
          quantity: b.quantity,
          amount: (b.blockPrice ?? b.product.price) * b.quantity,
        }));
      }

      setState({ status: "booked", orderId: orderId!, isCreditOrder, cashOwed, creditApplied, bmiTotal, bmiSubtotal, bmiTax, bmiLines });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Something went wrong",
      });
    }
  }

  async function handleConfirm() {
    if (state.status !== "booked") return;
    const { orderId, isCreditOrder, cashOwed } = state;

    setState({ status: "paying" });
    try {
      const raceName = bookings[0]?.product.name || "FastTrax Race Booking";
      const heatStart = bookings[0]?.block.start || "";

      // Store booking details in Redis + localStorage
      const bookingDetails = {
        billId: orderId,
        amount: (isCreditOrder ? 0 : cashOwed).toFixed(2),
        race: raceName,
        name: `${contact.firstName} ${contact.lastName}`,
        email: contact.email,
        qty: String(bookings.reduce((s, b) => s + b.quantity, 0)),
        heat: heatStart,
        isCreditOrder: isCreditOrder ? "true" : "false",
      };
      await fetch("/api/booking-store", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bookingDetails),
      });
      localStorage.setItem(`booking_${orderId}`, JSON.stringify(bookingDetails));

      // Credit order — skip Square, confirm directly with BMI
      if (isCreditOrder) {
        const confirmResult = await bmiPost("payment/confirm", {
          id: crypto.randomUUID(),
          paymentTime: new Date().toISOString(),
          amount: 0,
          orderId: Number(orderId),
          depositKind: 2,
        });
        console.log("[payment/confirm credit]", confirmResult);

        // Go straight to confirmation page
        window.location.href = `/book/race/confirmation?billId=${orderId}`;
        return;
      }

      // Cash order — create Square checkout
      const returnUrl = `${window.location.origin}/book/race/confirmation?billId=${orderId}`;

      const res = await fetch("/api/square/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          billId: orderId,
          amount: cashOwed,
          raceName,
          returnUrl,
          cancelUrl: `${window.location.origin}/book/race`,
          buyer: {
            email: contact.email,
            phone: contact.phone,
            firstName: contact.firstName,
            lastName: contact.lastName,
          },
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
          {isBooked ? (state.status === "booked" && state.isCreditOrder ? "Review & Confirm" : "Review & Pay") : "Preparing Order..."}
        </h2>
        {isBooked && (
          <p className="text-white/50 text-sm">
            Your heat{bookings.length > 1 ? "s are" : " is"} reserved. Complete
            your booking below.
          </p>
        )}
      </div>

      {/* Pack booking — special layout */}
      {isPack && packResult && packProduct && (
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
      )}

      {/* Contact + date bar */}
      {!isPack && (
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 flex items-center justify-between text-sm">
          <div>
            <span className="text-white font-semibold">{contact.firstName} {contact.lastName}</span>
            <span className="text-white/30 mx-2">&middot;</span>
            <span className="text-white/50">{contact.email}</span>
          </div>
          <span className="text-white/40 text-xs">{formatDate(date)}</span>
        </div>
      )}

      {/* All items — races + add-ons merged, sorted by time, compact rows */}
      {!isPack && (() => {
        type CardItem =
          | { type: "race"; time: string; bookingIdx: number }
          | { type: "pov" }
          | { type: "addon"; addOnIdx: number; time: string };

        const cards: CardItem[] = [];
        bookings.forEach((_, i) => cards.push({ type: "race", time: bookings[i].block.start, bookingIdx: i }));
        if (pov && pov.quantity > 0) cards.push({ type: "pov" });
        addOns.forEach((a, i) => { if (a.quantity > 0) cards.push({ type: "addon", addOnIdx: i, time: a.selectedTime || "" }); });

        cards.sort((a, b) => {
          const tA = a.type === "race" ? a.time : a.type === "addon" ? a.time : "";
          const tB = b.type === "race" ? b.time : b.type === "addon" ? b.time : "";
          if (!tA && !tB) return 0;
          if (!tA) return 1;
          if (!tB) return -1;
          return tA.localeCompare(tB);
        });

        const xBtn = (onClick: () => void) => (
          <button onClick={onClick} className="text-red-400/40 hover:text-red-400 transition-colors p-0.5 -mr-1 shrink-0">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        );

        return (
          <div className="rounded-xl border border-white/10 bg-white/5 divide-y divide-white/[0.06]">
            {cards.map((card) => {
              if (card.type === "race") {
                const b = bookings[card.bookingIdx];
                return (
                  <div key={`race-${card.bookingIdx}`} className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-white font-semibold text-sm truncate">{b.product.name}</span>
                        <span className="text-white/20 text-xs shrink-0">x{b.quantity}</span>
                      </div>
                      <p className="text-white/40 text-xs mt-0.5">
                        {b.block.name} &middot; {formatTime(b.block.start)}
                      </p>
                    </div>
                    {onRemoveBooking && bookings.length > 1 && state.status === "booked" && xBtn(() => onRemoveBooking(card.bookingIdx))}
                  </div>
                );
              }

              if (card.type === "pov") {
                return (
                  <div key="pov" className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[#00E2E5] text-[9px] font-bold uppercase tracking-wider shrink-0">Add-On</span>
                        <span className="text-white font-semibold text-sm truncate">POV Video</span>
                        <span className="text-white/20 text-xs shrink-0">x{pov!.quantity}</span>
                      </div>
                      <p className="text-[#00E2E5]/60 text-xs mt-0.5">${(pov!.price * pov!.quantity).toFixed(2)}</p>
                    </div>
                    {onRemovePov && state.status === "booked" && xBtn(() => onRemovePov())}
                  </div>
                );
              }

              const a = addOns[card.addOnIdx];
              return (
                <div key={`addon-${a.id}`} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[#00E2E5] text-[9px] font-bold uppercase tracking-wider shrink-0">Add-On</span>
                      <span className="text-white font-semibold text-sm truncate">{a.name}</span>
                      {a.quantity > 1 && <span className="text-white/20 text-xs shrink-0">x{a.quantity}</span>}
                    </div>
                    <p className="text-white/40 text-xs mt-0.5">
                      {a.selectedTime ? formatTime(a.selectedTime) : (a.perPerson ? `${a.quantity} ${a.quantity === 1 ? "person" : "people"}` : "")}
                      <span className="text-[#00E2E5]/60 ml-2">${(a.price * a.quantity).toFixed(2)}</span>
                    </p>
                  </div>
                  {onRemoveAddOn && state.status === "booked" && xBtn(() => onRemoveAddOn(card.addOnIdx))}
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Price breakdown — from BMI bill */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
        {state.status === "booked" ? (
          <>
            {state.bmiLines.map((line, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-white/60">{line.name} x {line.quantity}</span>
                <span className="text-white">{line.amount > 0 ? `$${line.amount.toFixed(2)}` : "Credit"}</span>
              </div>
            ))}

            <div className="border-t border-white/10 pt-2 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Subtotal</span>
                <span className="text-white">${state.bmiSubtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Tax</span>
                <span className="text-white">${state.bmiTax.toFixed(2)}</span>
              </div>
              <div className="border-t border-white/10 pt-2 flex justify-between font-bold">
                <span className="text-white">Total</span>
                <span className="text-[#00E2E5] text-lg">${state.bmiTotal.toFixed(2)}</span>
              </div>

              {state.creditApplied > 0 && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-green-400">Credits Applied</span>
                    <span className="text-green-400">-{state.creditApplied} credit{state.creditApplied !== 1 ? "s" : ""}</span>
                  </div>
                  <div className="border-t border-white/10 pt-2 flex justify-between font-bold">
                    <span className="text-white">{state.cashOwed > 0 ? "Due Now" : "Amount Due"}</span>
                    <span className={`text-lg ${state.cashOwed > 0 ? "text-[#00E2E5]" : "text-green-400"}`}>
                      {state.cashOwed > 0 ? `$${state.cashOwed.toFixed(2)}` : "$0.00"}
                    </span>
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="text-center text-white/30 text-sm py-2">Calculating...</div>
        )}
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
                <>{state.status === "booked" && state.isCreditOrder ? "Confirm Booking (Credit)" : `Pay $${(state.status === "booked" ? state.cashOwed : total).toFixed(2)} →`}</>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
