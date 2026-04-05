"use client";

import { useState, useEffect, useRef } from "react";
import Nav from "@/components/Nav";
import ContactForm from "@/app/book/race/components/ContactForm";
import type { ContactInfo } from "@/app/book/race/components/ContactForm";
import { calculateTax, calculateTotal } from "@/lib/attractions-data";

function formatTime(iso: string) {
  const clean = iso.replace(/Z$/, "");
  const [datePart, timePart] = clean.split("T");
  if (!timePart) return "";
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, min] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, h, min).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

interface BillLine {
  name: string;
  quantity: number;
  cashAmount: number;
  creditAmount: number;
  time: string | null;
}

type CheckoutState =
  | { status: "loading" }
  | { status: "contact" }
  | { status: "review"; orderId: string; lines: BillLine[]; subtotal: number; tax: number; total: number; creditsApplied: number }
  | { status: "paying" }
  | { status: "error"; message: string };

export default function CheckoutPage() {
  const [state, setState] = useState<CheckoutState>({ status: "loading" });
  const [contact, setContact] = useState<ContactInfo | null>(null);
  const effectRan = useRef(false);

  const orderId = typeof window !== "undefined" ? sessionStorage.getItem("attractionOrderId") : null;

  // Load bill overview on mount
  useEffect(() => {
    if (effectRan.current) return;
    effectRan.current = true;

    if (!orderId) {
      setState({ status: "error", message: "No booking found. Start by picking an activity." });
      return;
    }

    async function loadBill() {
      try {
        const overviewRes = await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${orderId}`);
        const overview = await overviewRes.json();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lines: BillLine[] = (overview.lines || []).map((l: any) => {
          const cashPrice = l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 0);
          const creditPrice = l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 2);
          const lineTime = l.scheduledTime?.start || l.schedules?.[0]?.start;
          return {
            name: l.name,
            quantity: l.quantity,
            cashAmount: cashPrice?.amount ?? 0,
            creditAmount: creditPrice ? Math.abs(creditPrice.amount) : 0,
            time: lineTime || null,
          };
        });

        const cashTotal = overview.total?.find((t: { depositKind: number }) => t.depositKind === 0);
        const creditTotals = (overview.total || []).filter((t: { depositKind: number }) => t.depositKind === 2);
        const creditsApplied = creditTotals.reduce((s: number, t: { amount: number }) => s + Math.abs(t.amount), 0);
        const cashSub = overview.subTotal?.find((t: { depositKind: number }) => t.depositKind === 0);
        const cashTax = overview.totalTax?.find((t: { depositKind: number }) => t.depositKind === 0);

        setState({
          status: "contact",
        });
        // Store for after contact
        setBillData({
          orderId: orderId!,
          lines,
          subtotal: cashSub?.amount ?? 0,
          tax: cashTax?.amount ?? 0,
          total: cashTotal?.amount ?? 0,
          creditsApplied,
        });
      } catch {
        setState({ status: "error", message: "Failed to load order details." });
      }
    }
    loadBill();
  }, [orderId]);

  const [billData, setBillData] = useState<{ orderId: string; lines: BillLine[]; subtotal: number; tax: number; total: number; creditsApplied: number } | null>(null);

  async function handleContactSubmit(c: ContactInfo) {
    if (!billData) return;
    setContact(c);

    // Register contact on bill
    try {
      const regQs = new URLSearchParams({ endpoint: "person/registerContactPerson" });
      const regBody = JSON.stringify({
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone.replace(/\D/g, ""),
      });
      const rawRegJson = `{"orderId":${billData.orderId},` + regBody.slice(1);
      await fetch(`/api/bmi?${regQs.toString()}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawRegJson,
      });
    } catch { /* non-fatal */ }

    // Re-fetch bill overview (contact registration might change pricing)
    try {
      const overviewRes = await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${billData.orderId}`);
      const overview = await overviewRes.json();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lines: BillLine[] = (overview.lines || []).map((l: any) => {
        const cashPrice = l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 0);
        const creditPrice = l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 2);
        const lineTime = l.scheduledTime?.start || l.schedules?.[0]?.start;
        return { name: l.name, quantity: l.quantity, cashAmount: cashPrice?.amount ?? 0, creditAmount: creditPrice ? Math.abs(creditPrice.amount) : 0, time: lineTime || null };
      });

      const cashTotal = overview.total?.find((t: { depositKind: number }) => t.depositKind === 0);
      const creditTotals = (overview.total || []).filter((t: { depositKind: number }) => t.depositKind === 2);
      const creditsApplied = creditTotals.reduce((s: number, t: { amount: number }) => s + Math.abs(t.amount), 0);
      const cashSub = overview.subTotal?.find((t: { depositKind: number }) => t.depositKind === 0);
      const cashTax = overview.totalTax?.find((t: { depositKind: number }) => t.depositKind === 0);

      setState({
        status: "review",
        orderId: billData.orderId,
        lines,
        subtotal: cashSub?.amount ?? 0,
        tax: cashTax?.amount ?? 0,
        total: cashTotal?.amount ?? 0,
        creditsApplied,
      });
    } catch {
      // Use cached data
      setState({ status: "review", ...billData });
    }
  }

  async function handlePay() {
    if (state.status !== "review" || !contact) return;
    setState({ status: "paying" });

    try {
      const cashOwed = state.total;

      // If fully covered by credits, confirm directly
      if (cashOwed <= 0 && state.creditsApplied > 0) {
        const confirmBody = `{"id":"${crypto.randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":0,"orderId":${state.orderId},"depositKind":2}`;
        const qs = new URLSearchParams({ endpoint: "payment/confirm" });
        await fetch(`/api/bmi?${qs.toString()}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: confirmBody,
        });
        // Clean up session
        sessionStorage.removeItem("attractionCart");
        sessionStorage.removeItem("attractionOrderId");
        window.location.href = `/book/checkout/confirmation?billId=${state.orderId}`;
        return;
      }

      // Store booking details for after Square redirect
      await fetch("/api/booking-store", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          billId: state.orderId,
          amount: cashOwed.toFixed(2),
          name: `${contact.firstName} ${contact.lastName}`,
          email: contact.email,
          race: "Activities",
          qty: String(state.lines.reduce((s, l) => s + l.quantity, 0)),
          isCreditOrder: "false",
        }),
      });

      // Square checkout
      const returnUrl = `${window.location.origin}/book/checkout/confirmation?billId=${state.orderId}`;
      const res = await fetch("/api/square/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          billId: state.orderId,
          amount: cashOwed,
          raceName: "FastTrax Activities",
          returnUrl,
          cancelUrl: `${window.location.origin}/book`,
          buyer: {
            email: contact.email,
            phone: contact.phone,
            firstName: contact.firstName,
            lastName: contact.lastName,
          },
        }),
      });
      const data = await res.json();
      if (data.checkoutUrl) {
        sessionStorage.removeItem("attractionCart");
        sessionStorage.removeItem("attractionOrderId");
        window.location.href = data.checkoutUrl;
      } else {
        throw new Error(data.error || "Payment failed");
      }
    } catch (err) {
      setState({ status: "review", ...billData!, orderId: state.orderId });
      alert(err instanceof Error ? err.message : "Payment failed");
    }
  }

  return (
    <div className="min-h-screen bg-[#000418]">
      <Nav />

      <div className="max-w-lg mx-auto px-4 pt-32 sm:pt-36 pb-16">
        <div className="mb-8">
          <button
            onClick={() => {
              const returnPath = sessionStorage.getItem("checkoutReturnPath") || "/book";
              window.location.href = returnPath;
            }}
            className="text-white/40 hover:text-white/70 text-sm mb-4 transition-colors"
          >
            ← Back
          </button>
          <div className="text-center">
            <h1 className="text-3xl font-display text-white uppercase tracking-widest mb-2">Checkout</h1>
            <p className="text-white/40 text-sm">Review your order and complete payment.</p>
          </div>
        </div>

        {state.status === "loading" && (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
          </div>
        )}

        {state.status === "error" && (
          <div className="text-center space-y-4 py-16">
            <p className="text-red-400">{state.message}</p>
            <a href="/book" className="text-[#00E2E5] underline text-sm">Browse experiences</a>
          </div>
        )}

        {state.status === "contact" && (
          <div className="space-y-6">
            {/* Quick bill preview */}
            {billData && billData.lines.length > 0 && (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-2">
                <p className="text-white/50 text-xs font-bold uppercase tracking-wider">Your Order</p>
                {billData.lines.map((line, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-white">{line.name}{line.quantity > 1 ? ` x${line.quantity}` : ""}</span>
                    <span className="text-white/60">{line.creditAmount > 0 ? "Credit" : `$${line.cashAmount.toFixed(2)}`}</span>
                  </div>
                ))}
                <div className="border-t border-white/10 pt-2 flex justify-between font-bold text-sm">
                  <span className="text-white">Total</span>
                  <span className="text-[#00E2E5]">${billData.total.toFixed(2)}</span>
                </div>
              </div>
            )}
            <ContactForm initial={contact} onSubmit={handleContactSubmit} onBack={() => {
              const returnPath = sessionStorage.getItem("checkoutReturnPath") || "/book";
              window.location.href = returnPath;
            }} />
          </div>
        )}

        {state.status === "review" && contact && (
          <div className="space-y-6">
            {/* Contact summary */}
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 flex justify-between items-center">
              <div>
                <p className="text-white font-semibold text-sm">{contact.firstName} {contact.lastName}</p>
                <p className="text-white/40 text-xs">{contact.email}</p>
              </div>
              <button onClick={() => setState({ status: "contact" })} className="text-[#00E2E5] text-xs hover:underline">Edit</button>
            </div>

            {/* Order items */}
            <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
              <div className="p-4 space-y-2">
                {state.lines.map((line, i) => (
                  <div key={i} className="flex justify-between items-center py-1.5">
                    <div>
                      <p className="text-white text-sm">{line.name}{line.quantity > 1 ? ` x${line.quantity}` : ""}</p>
                      {line.time && <p className="text-white/30 text-xs">{formatTime(line.time)}</p>}
                    </div>
                    <span className="text-white font-semibold text-sm">
                      {line.creditAmount > 0 ? <span className="text-green-400">Credit</span> : `$${line.cashAmount.toFixed(2)}`}
                    </span>
                  </div>
                ))}
              </div>

              <div className="border-t border-white/10 p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-white/50">Subtotal</span>
                  <span className="text-white">${state.subtotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-white/50">Tax</span>
                  <span className="text-white">${state.tax.toFixed(2)}</span>
                </div>
                {state.creditsApplied > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-green-400">Credits Applied</span>
                    <span className="text-green-400">-{state.creditsApplied} credit{state.creditsApplied !== 1 ? "s" : ""}</span>
                  </div>
                )}
                <div className="border-t border-white/10 pt-2 flex justify-between font-bold">
                  <span className="text-white">{state.total > 0 ? "Amount Due" : "Total"}</span>
                  <span className="text-[#00E2E5] text-lg">${state.total.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* Pay button */}
            <button
              onClick={handlePay}
              className="w-full py-4 rounded-xl font-bold text-base bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
            >
              {state.total > 0 ? `Pay $${state.total.toFixed(2)} with Square` : "Confirm Booking"}
            </button>

            <p className="text-white/30 text-xs text-center">
              Payment handled securely by Square. Confirmation sent to {contact.email}.
            </p>
          </div>
        )}

        {state.status === "paying" && (
          <div className="flex flex-col items-center gap-4 py-16">
            <div className="w-8 h-8 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
            <p className="text-white/50 text-sm">Redirecting to payment...</p>
          </div>
        )}
      </div>
    </div>
  );
}
