"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { getBookingClientKey, clearBookingLocation } from "@/lib/booking-location";

interface StoredCartItem {
  attractionName: string;
  product: { name: string; price: number; bookingMode: string };
  date: string;
  time: { block: { start: string } };
  quantity: number;
  color: string;
}

/** Shape of the bowlingHold sessionStorage blob saved by BowlingWizard */
interface BowlingHoldData {
  qamfReservationId: string;
  centerId: number;
  locationKey: string;
  experienceName: string;
  timeLabel: string;
  totalCents: number;
  depositCents: number;
  expiresAt: string;
  // Additional fields exist (players, lineItems, etc.) but MiniCart
  // only needs display + hold-management fields listed above.
}

function formatTime(iso: string) {
  const clean = iso.replace(/Z$/, "");
  const [datePart, timePart] = clean.split("T");
  if (!timePart) return "";
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, min] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, h, min).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/**
 * Unified floating cart — reads from sessionStorage, matches racing FloatingCart style.
 * Shows on /book landing page and /book/[attraction] flows.
 *
 * Supports three item sources:
 *   1. attractionCart — BMI attractions + racing (shared bill)
 *   2. bowlingHold — QAMF bowling reservation (separate pricing authority)
 *
 * All items route to /book/checkout for unified payment.
 */
export default function MiniCart({ onStartOver }: { onStartOver?: () => void } = {}) {
  const pathname = usePathname();
  const [items, setItems] = useState<StoredCartItem[]>([]);
  const [open, setOpen] = useState(false);
  const [hasActiveBill, setHasActiveBill] = useState(false);
  const [bowlingHold, setBowlingHold] = useState<BowlingHoldData | null>(null);
  const [holdExpiringSoon, setHoldExpiringSoon] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Read sessionStorage for cart items + bowling hold.
  // Three triggers, in order of preference:
  //   1. `cart:changed` event — fired by writers (race page, attraction
  //      pages, bowling wizard) the moment they update sessionStorage.
  //   2. Native `storage` event — fires when sessionStorage is changed
  //      from a *different* tab/window.
  //   3. Poll fallback every 800ms — defends against any writer that
  //      forgot the event dispatch.
  useEffect(() => {
    function loadCart() {
      try {
        const stored = sessionStorage.getItem("attractionCart");
        const parsed: StoredCartItem[] = stored ? JSON.parse(stored) : [];
        setItems(parsed);
        setHasActiveBill(!!sessionStorage.getItem("attractionOrderId"));
      } catch { setItems([]); }

      // Bowling hold
      try {
        const bowlingRaw = sessionStorage.getItem("bowlingHold");
        setBowlingHold(bowlingRaw ? JSON.parse(bowlingRaw) : null);
      } catch { setBowlingHold(null); }
    }
    loadCart();
    const interval = setInterval(loadCart, 800);
    window.addEventListener("cart:changed", loadCart);
    window.addEventListener("storage", loadCart);
    return () => {
      clearInterval(interval);
      window.removeEventListener("cart:changed", loadCart);
      window.removeEventListener("storage", loadCart);
    };
  }, []);

  // ── QAMF hold extension timer ──────────────────────────────────────
  // Extends the 10-min QAMF hold every 8 minutes while bowling is in cart.
  // Also checks for expiry approaching (< 2 min left) to show warning.
  useEffect(() => {
    // Clean up previous timers
    if (holdTimerRef.current) { clearInterval(holdTimerRef.current); holdTimerRef.current = null; }
    if (expiryTimerRef.current) { clearInterval(expiryTimerRef.current); expiryTimerRef.current = null; }
    setHoldExpiringSoon(false);

    if (!bowlingHold) return;

    // Extend hold every 8 minutes
    holdTimerRef.current = setInterval(() => {
      fetch(`/api/bowling/v2/reserve/hold/${bowlingHold.qamfReservationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ centerId: bowlingHold.centerId }),
      }).then((res) => {
        if (res.ok) {
          // Update expiresAt in sessionStorage (hold was extended +10 min)
          try {
            const raw = sessionStorage.getItem("bowlingHold");
            if (raw) {
              const h = JSON.parse(raw);
              h.expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
              sessionStorage.setItem("bowlingHold", JSON.stringify(h));
            }
          } catch { /* non-fatal */ }
        }
      }).catch(() => { /* non-fatal */ });
    }, 8 * 60 * 1000);

    // Check expiry every 30s
    expiryTimerRef.current = setInterval(() => {
      try {
        const raw = sessionStorage.getItem("bowlingHold");
        if (!raw) { setHoldExpiringSoon(false); return; }
        const h = JSON.parse(raw);
        const msLeft = new Date(h.expiresAt).getTime() - Date.now();
        setHoldExpiringSoon(msLeft > 0 && msLeft < 2 * 60 * 1000);
      } catch { /* non-fatal */ }
    }, 30_000);

    return () => {
      if (holdTimerRef.current) clearInterval(holdTimerRef.current);
      if (expiryTimerRef.current) clearInterval(expiryTimerRef.current);
    };
  }, [bowlingHold?.qamfReservationId, bowlingHold?.centerId]);

  // ── Remove BMI attraction item ─────────────────────────────────────
  function handleRemove(index: number) {
    const item = items[index];
    // Remove bill line from BMI if we have the billLineId
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const billLineId = (item as any).billLineId;
    const orderId = sessionStorage.getItem("attractionOrderId");
    if (billLineId && orderId) {
      fetch(`/api/bmi?endpoint=booking%2FremoveItem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"orderId":${orderId},"orderItemId":${billLineId}}`,
      }).catch(() => { /* non-fatal */ });
    }
    const updated = items.filter((_, i) => i !== index);
    setItems(updated);
    sessionStorage.setItem("attractionCart", JSON.stringify(updated));
    // If cart is empty, clean up orderId too
    if (updated.length === 0) {
      sessionStorage.removeItem("attractionOrderId");
    }
    // Notify other listeners (and any other open MiniCart instances)
    try { window.dispatchEvent(new CustomEvent("cart:changed")); } catch { /* SSR */ }
  }

  // ── Remove bowling hold ────────────────────────────────────────────
  const handleRemoveBowling = useCallback(() => {
    if (!bowlingHold) return;
    // Release the QAMF hold
    fetch(`/api/bowling/v2/reserve/hold/${bowlingHold.qamfReservationId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ centerId: bowlingHold.centerId }),
    }).catch(() => { /* non-fatal — hold expires naturally */ });
    sessionStorage.removeItem("bowlingHold");
    setBowlingHold(null);
    setHoldExpiringSoon(false);
    try { window.dispatchEvent(new CustomEvent("cart:changed")); } catch { /* SSR */ }
  }, [bowlingHold]);

  // ── Cancel entire cart ─────────────────────────────────────────────
  const handleCancelAll = useCallback(() => {
    // Cancel BMI bill
    const orderId = sessionStorage.getItem("attractionOrderId");
    const ck = getBookingClientKey();
    if (orderId) {
      const cancelQs = ck ? `endpoint=bill/${orderId}/cancel&clientKey=${ck}` : `endpoint=bill/${orderId}/cancel`;
      fetch(`/api/bmi?${cancelQs}`, { method: "DELETE" }).catch(() => {});
    }

    // Release bowling QAMF hold
    if (bowlingHold) {
      fetch(`/api/bowling/v2/reserve/hold/${bowlingHold.qamfReservationId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ centerId: bowlingHold.centerId }),
      }).catch(() => {});
    }

    // Clear all cart state
    sessionStorage.removeItem("attractionOrderId");
    sessionStorage.removeItem("attractionCart");
    sessionStorage.removeItem("bowlingHold");
    clearBookingLocation();
    setItems([]);
    setHasActiveBill(false);
    setBowlingHold(null);
    setOpen(false);
    window.location.href = "/book";
  }, [bowlingHold]);

  const hasBowling = !!bowlingHold;
  const hasAttractions = items.length > 0 || hasActiveBill;
  if (!hasAttractions && !hasBowling) return null;

  const totalQty = items.reduce((s, i) => s + i.quantity, 0) + (hasBowling ? 1 : 0);

  return (
    <div className="fixed bottom-20 right-4 z-40 md:bottom-8 md:right-24">
      {/* Expanded cart */}
      {open && (
        <div className="absolute bottom-16 right-0 w-72 rounded-xl border border-white/15 bg-[#0a0e1a]/95 backdrop-blur-lg shadow-2xl shadow-black/50 overflow-hidden mb-2">
          <div className="p-3 border-b border-white/10">
            <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-wider">
              Your Cart ({totalQty})
            </p>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {/* ── Bowling item ────────────────────────────────────── */}
            {bowlingHold && (
              <div className="p-3 border-b border-white/5">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-white text-sm font-semibold">
                      🎳 {bowlingHold.experienceName}
                    </p>
                    <p className="text-white/40 text-xs">{bowlingHold.timeLabel}</p>
                    <span className="text-[#00E2E5] text-xs">
                      ${(bowlingHold.totalCents / 100).toFixed(2)}
                    </span>
                    {holdExpiringSoon && (
                      <span className="ml-2 text-amber-400 text-xs animate-pulse">
                        Hold expiring soon
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label="Remove bowling"
                    onClick={(e) => { e.stopPropagation(); handleRemoveBowling(); }}
                    className="text-red-400/50 hover:text-red-400 transition-colors p-1 shrink-0"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {/* ── BMI attraction / racing items ───────────────────── */}
            {items.map((item, i) => (
              <div key={i} className="p-3 border-b border-white/5 last:border-0">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-white text-sm font-semibold">{item.attractionName}: {item.product.name}</p>
                    {item.date && item.time.block.start ? (
                      <p className="text-white/40 text-xs">
                        {formatDate(item.date)} · {formatTime(item.time.block.start)}
                      </p>
                    ) : item.date ? (
                      <p className="text-white/40 text-xs">{formatDate(item.date)}</p>
                    ) : null}
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-white/50 text-xs">
                        {(() => {
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          const schedCount = (item as any).packSchedules?.length;
                          if (schedCount) return `${schedCount} races`;
                          const unit = item.product.bookingMode === "per-person" ? "person" : "table";
                          return `${item.quantity} ${unit}${item.quantity !== 1 ? "s" : ""}`;
                        })()}
                      </span>
                      <span className="text-[#00E2E5] text-xs">${(item.product.price * item.quantity).toFixed(2)}</span>
                    </div>
                  </div>
                  {!item.product.name.toLowerCase().includes("license") && (
                    <button
                      type="button"
                      aria-label="Remove item"
                      onClick={(e) => { e.stopPropagation(); handleRemove(i); }}
                      className="text-red-400/50 hover:text-red-400 transition-colors p-1 shrink-0"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="p-3 border-t border-white/10 space-y-2">
            {/* Unified checkout — always route to /book/checkout */}
            {(totalQty > 0) && (
              <Link
                href="/book/checkout"
                className="block w-full py-2.5 rounded-lg font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors text-center"
              >
                Checkout →
              </Link>
            )}
            {onStartOver && (
              <button
                onClick={() => { onStartOver(); setOpen(false); }}
                className="block w-full py-2 rounded-lg font-semibold text-xs text-red-400/70 hover:text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors text-center"
              >
                Cancel &amp; Start Over
              </button>
            )}
            {!onStartOver && (hasActiveBill || hasBowling) && (
              <button
                onClick={handleCancelAll}
                className="block w-full py-2 rounded-lg font-semibold text-xs text-red-400/70 hover:text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors text-center"
              >
                Cancel &amp; Start Over
              </button>
            )}
          </div>
        </div>
      )}

      {/* Cart button — matches racing FloatingCart style */}
      <button
        onClick={() => setOpen(!open)}
        className="relative w-14 h-14 rounded-full bg-[#00E2E5] text-[#000418] shadow-lg shadow-[#00E2E5]/30 hover:bg-white transition-colors flex items-center justify-center"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" />
        </svg>
        <span className={`absolute -top-1 -right-1 w-5 h-5 rounded-full text-white text-xs font-bold flex items-center justify-center ${holdExpiringSoon ? "bg-amber-500 animate-pulse" : "bg-red-500"}`}>
          {totalQty}
        </span>
      </button>
    </div>
  );
}
