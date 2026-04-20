"use client";

import { useState, useEffect } from "react";

interface CartItem {
  name: string;
  quantity: number;
  time: string;
  date: string;
  price?: number;
  isAttraction?: boolean;
}

interface FloatingCartProps {
  items: CartItem[];
  onCheckout: () => void;
  onRemove?: (index: number) => void;
}

function formatTime(iso: string): string {
  const [, t] = iso.split("T");
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h > 12 ? h - 12 : h || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatDate(iso: string): string {
  const [datePart] = iso.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export default function FloatingCart({ items, onCheckout, onRemove }: FloatingCartProps) {
  const [open, setOpen] = useState(false);
  const [attractionItems, setAttractionItems] = useState<CartItem[]>([]);

  // Load attraction items from sessionStorage (shared bill).
  // sessionStorage is client-only so this must run in an effect.
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem("attractionCart");
      if (!stored) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed: any[] = JSON.parse(stored);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAttractionItems(parsed.map(a => ({
        name: `${a.attractionName}: ${a.product?.name || ""}`,
        quantity: a.quantity || 1,
        time: a.time?.block?.start || "",
        date: a.date || "",
        price: (a.product?.price || 0) * (a.quantity || 1),
        isAttraction: true,
      })));
    } catch { /* ignore */ }
  }, []);

  const allItems = [...attractionItems, ...items];
  if (allItems.length === 0) return null;

  const totalQty = allItems.reduce((s, i) => s + i.quantity, 0);

  return (
    <div className="fixed bottom-20 right-4 z-40 md:bottom-8 md:right-24">
      {/* Expanded cart */}
      {open && (
        <div className="absolute bottom-16 right-0 w-72 rounded-xl border border-white/15 bg-[#0a0e1a]/95 backdrop-blur-lg shadow-2xl shadow-black/50 overflow-hidden mb-2">
          <div className="p-3 border-b border-white/10">
            <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-wider">
              Your Cart ({allItems.length})
            </p>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {allItems.map((item, i) => (
              <div key={i} className="p-3 border-b border-white/5 last:border-0">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-white text-sm font-semibold">{item.name}</p>
                    {item.time && <p className="text-white/40 text-xs">{formatDate(item.time)} · {formatTime(item.time)}</p>}
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-white/50 text-xs">
                        {item.isAttraction ? `${item.quantity} ${item.quantity !== 1 ? "people" : "person"}` : `${item.quantity} racer${item.quantity !== 1 ? "s" : ""}`}
                      </span>
                      {item.price !== undefined && item.price > 0 && (
                        <span className="text-[#00E2E5] text-xs">${item.isAttraction ? item.price.toFixed(2) : (item.price * item.quantity).toFixed(2)}</span>
                      )}
                    </div>
                  </div>
                  {onRemove && !item.isAttraction && (
                    <button
                      type="button"
                      aria-label="Remove item"
                      onClick={(e) => { e.stopPropagation(); onRemove(i - attractionItems.length); }}
                      className="text-red-400/50 hover:text-red-400 transition-colors p-1"
                      title="Remove"
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
          <div className="p-3 border-t border-white/10">
            <button
              onClick={onCheckout}
              className="w-full py-2.5 rounded-lg font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors"
            >
              Checkout →
            </button>
          </div>
        </div>
      )}

      {/* Cart button */}
      <button
        onClick={() => setOpen(!open)}
        className="relative w-14 h-14 rounded-full bg-[#00E2E5] text-[#000418] shadow-lg shadow-[#00E2E5]/30 hover:bg-white transition-colors flex items-center justify-center"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" />
        </svg>
        {/* Badge */}
        <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs font-bold flex items-center justify-center">
          {totalQty}
        </span>
      </button>
    </div>
  );
}
