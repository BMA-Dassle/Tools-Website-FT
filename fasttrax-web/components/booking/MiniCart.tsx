"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";

interface StoredCartItem {
  attractionName: string;
  product: { name: string; price: number; bookingMode: string };
  date: string;
  time: { block: { start: string } };
  quantity: number;
  color: string;
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
 */
export default function MiniCart({ onStartOver }: { onStartOver?: () => void } = {}) {
  const pathname = usePathname();
  const [items, setItems] = useState<StoredCartItem[]>([]);
  const [open, setOpen] = useState(false);
  const [hasActiveBill, setHasActiveBill] = useState(false);
  // Race booking has its own checkout flow — hide the generic checkout button
  const isRaceFlow = pathname?.startsWith("/book/race");

  // Poll sessionStorage for cart items
  useEffect(() => {
    function loadCart() {
      try {
        const stored = sessionStorage.getItem("attractionCart");
        const parsed: StoredCartItem[] = stored ? JSON.parse(stored) : [];
        setItems(parsed);
        setHasActiveBill(!!sessionStorage.getItem("attractionOrderId"));
      } catch { setItems([]); }
    }
    loadCart();
    const interval = setInterval(loadCart, 1500);
    return () => clearInterval(interval);
  }, []);

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
  }

  if (items.length === 0 && !hasActiveBill) return null;

  const totalQty = items.reduce((s, i) => s + i.quantity, 0);

  return (
    <div className="fixed bottom-20 right-4 z-40 md:bottom-8 md:right-24">
      {/* Expanded cart */}
      {open && (
        <div className="absolute bottom-16 right-0 w-72 rounded-xl border border-white/15 bg-[#0a0e1a]/95 backdrop-blur-lg shadow-2xl shadow-black/50 overflow-hidden mb-2">
          <div className="p-3 border-b border-white/10">
            <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-wider">
              Your Cart ({items.length})
            </p>
          </div>
          <div className="max-h-48 overflow-y-auto">
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
                        {item.quantity} {item.product.bookingMode === "per-person" ? `person${item.quantity !== 1 ? "s" : ""}` : `table${item.quantity !== 1 ? "s" : ""}`}
                      </span>
                      <span className="text-[#00E2E5] text-xs">${(item.product.price * item.quantity).toFixed(2)}</span>
                    </div>
                  </div>
                  {!item.product.name.toLowerCase().includes("license") && (
                    <button
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
            {items.length > 0 && (() => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const hasRacing = items.some((i: any) => i.attraction === "racing");
              // Race flow has its own checkout steps — only show checkout for attractions
              if (hasRacing) return null;
              return (
                <a
                  href="/book/checkout"
                  className="block w-full py-2.5 rounded-lg font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors text-center"
                >
                  Checkout →
                </a>
              );
            })()}
            {onStartOver && (
              <button
                onClick={() => { onStartOver(); setOpen(false); }}
                className="block w-full py-2 rounded-lg font-semibold text-xs text-red-400/70 hover:text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors text-center"
              >
                Cancel &amp; Start Over
              </button>
            )}
            {!onStartOver && hasActiveBill && (
              <button
                onClick={() => {
                  const orderId = sessionStorage.getItem("attractionOrderId");
                  if (orderId) {
                    fetch(`/api/bmi?endpoint=bill/${orderId}/cancel`, { method: "DELETE" }).catch(() => {});
                  }
                  sessionStorage.removeItem("attractionOrderId");
                  sessionStorage.removeItem("attractionCart");
                  setItems([]);
                  setHasActiveBill(false);
                  setOpen(false);
                  window.location.href = "/book/race";
                }}
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
        <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
          {totalQty}
        </span>
      </button>
    </div>
  );
}
