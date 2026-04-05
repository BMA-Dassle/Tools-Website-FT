"use client";

import { useState, useEffect } from "react";

interface CartItem {
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

/**
 * Floating mini cart — reads from sessionStorage, shows on any booking page
 * when there are items in the cart.
 */
export default function MiniCart() {
  const [items, setItems] = useState<CartItem[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem("attractionCart");
    if (stored) {
      try { setItems(JSON.parse(stored)); } catch { /* ignore */ }
    }
    // Listen for storage changes (from other pages)
    const handler = () => {
      const updated = sessionStorage.getItem("attractionCart");
      if (updated) try { setItems(JSON.parse(updated)); } catch { /* ignore */ }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  // Also poll sessionStorage every 2s (storage events don't fire same-tab)
  useEffect(() => {
    const interval = setInterval(() => {
      const stored = sessionStorage.getItem("attractionCart");
      try {
        const parsed = stored ? JSON.parse(stored) : [];
        if (JSON.stringify(parsed) !== JSON.stringify(items)) setItems(parsed);
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [items]);

  if (items.length === 0) return null;

  const subtotal = items.reduce((s, item) => s + item.product.price * item.quantity, 0);
  const itemCount = items.length;

  return (
    <>
      {/* Floating cart button */}
      <button
        onClick={() => setOpen(!open)}
        className="fixed bottom-6 right-6 z-40 bg-[#00E2E5] text-[#000418] rounded-full px-5 py-3 font-bold text-sm shadow-lg shadow-[#00E2E5]/25 flex items-center gap-2 hover:bg-white transition-colors"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" />
        </svg>
        {itemCount} item{itemCount !== 1 ? "s" : ""} · ${subtotal.toFixed(2)}
      </button>

      {/* Expanded cart panel */}
      {open && (
        <div className="fixed bottom-20 right-6 z-40 w-80 max-h-[60vh] overflow-y-auto rounded-2xl border border-white/10 bg-[#000418]/95 backdrop-blur-xl shadow-2xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-bold text-sm">Your Cart</h3>
            <button onClick={() => setOpen(false)} className="text-white/30 hover:text-white/60 text-xs">Close</button>
          </div>

          {items.map((item, i) => (
            <div key={i} className="rounded-lg border border-white/[0.06] bg-white/[0.03] p-3">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                <span className="text-white font-semibold text-xs">{item.attractionName}</span>
              </div>
              <p className="text-white/40 text-[10px] mt-1">
                {item.product.name} · {formatTime(item.time.block.start)}
                {item.quantity > 1 && ` · ${item.quantity} ${item.product.bookingMode === "per-person" ? "ppl" : "tables"}`}
              </p>
              <p className="text-white/50 text-[10px] font-semibold mt-0.5">${(item.product.price * item.quantity).toFixed(2)}</p>
            </div>
          ))}

          <div className="border-t border-white/10 pt-2 flex justify-between text-sm">
            <span className="text-white/60">Subtotal</span>
            <span className="text-white font-bold">${subtotal.toFixed(2)}</span>
          </div>
        </div>
      )}
    </>
  );
}
