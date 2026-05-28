"use client";

import { useEffect, useState } from "react";
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";
import type { BowlingSquareProduct } from "@/lib/bowling-db";

const CORAL = "#fd5b56";

type BowlingLikeItem = BowlingItem | KbfItem;

const QAMF_CENTER_CODES: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
};

const BowlingShoesStepComponent: StepDef<BowlingLikeItem>["Component"] = ({ item, onChange }) => {
  const centerId = item.qamfCenterId ?? 9172;
  const centerCode = QAMF_CENTER_CODES[centerId] ?? "TXBSQN0FEKQ11";

  const [products, setProducts] = useState<BowlingSquareProduct[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/bowling/v2/square-products?centerCode=${centerCode}&kind=addon_shoe`,
        );
        const data = await res.json();
        setProducts(Array.isArray(data) ? data : []);
      } catch {
        setProducts([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [centerCode]);

  const selections = item.shoeSelections;
  const totalPairs = Object.values(selections).reduce((s, q) => s + q, 0);
  const totalCents = products.reduce((s, p) => s + (selections[p.id] ?? 0) * p.priceCents, 0);

  function setQty(productId: number, qty: number) {
    const next = { ...selections, [productId]: Math.max(0, qty) };
    if (next[productId] === 0) delete next[productId];

    const shoeLineItems = Object.entries(next)
      .filter(([, q]) => q > 0)
      .map(([id, q]) => ({ squareProductId: Number(id), quantity: q }));

    onChange({
      shoeSelections: next,
      lineItems: [
        ...item.lineItems.filter((li) => !products.some((p) => p.id === li.squareProductId)),
        ...shoeLineItems,
      ],
    } as Partial<BowlingLikeItem>);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/15"
          style={{ borderTopColor: CORAL }}
        />
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="mx-auto max-w-md py-8 text-center">
        <p className="text-sm text-white/50">
          No shoe rental available online — rent at the center or bring your own.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">Shoe Rentals</h2>
        <p className="mt-1 text-sm text-white/40">
          Add bowling shoes for your group. You can also rent at the center.
        </p>
      </div>

      <div className="space-y-3">
        {products.map((p) => {
          const qty = selections[p.id] ?? 0;
          return (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
            >
              <div>
                <p className="text-sm font-semibold text-white">{p.label}</p>
                <p className="text-xs text-white/40">${(p.priceCents / 100).toFixed(2)}/pair</p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setQty(p.id, qty - 1)}
                  disabled={qty === 0}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 text-lg text-white transition-colors hover:border-white/30 disabled:opacity-30"
                >
                  &minus;
                </button>
                <span className="w-6 text-center text-sm font-bold text-white">{qty}</span>
                <button
                  type="button"
                  onClick={() => setQty(p.id, qty + 1)}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 text-lg text-white transition-colors hover:border-white/30"
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {totalPairs > 0 && (
        <div className="text-center text-sm text-white/60">
          {totalPairs} pair{totalPairs !== 1 ? "s" : ""} &middot; ${(totalCents / 100).toFixed(2)}
        </div>
      )}
    </div>
  );
};

const BowlingShoesStep: StepDef<BowlingItem> = {
  id: "bowling-shoes",
  title: "Shoes",
  Component: BowlingShoesStepComponent as StepDef<BowlingItem>["Component"],
  isVisible: () => true,
  canAdvance: () => true,
};

export default BowlingShoesStep;
