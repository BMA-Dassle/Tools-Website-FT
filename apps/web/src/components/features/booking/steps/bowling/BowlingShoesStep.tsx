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

  const playerCount =
    item.kind === "bowling"
      ? (item as BowlingItem).playerCount
      : (item as KbfItem).bowlers.length + (item as KbfItem).paidAdults;

  useEffect(() => {
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/bowling/v2/square-products?centerCode=${centerCode}&kind=addon_shoe`,
        );
        const data = await res.json();
        const fetched: BowlingSquareProduct[] = Array.isArray(data) ? data : [];
        setProducts(fetched);

        // Default: pre-add shoes for the whole group if none selected yet
        const hasShoes = Object.values(item.shoeSelections).some((q) => q > 0);
        if (!hasShoes && fetched.length > 0 && playerCount > 0) {
          const defaultProduct = fetched[0];
          const shoeLineItem = {
            squareProductId: defaultProduct.id,
            quantity: playerCount,
            label: defaultProduct.label,
            priceCents: defaultProduct.priceCents,
            depositPct: defaultProduct.depositPct,
            squareCatalogObjectId: defaultProduct.squareCatalogObjectId,
          };
          onChange({
            shoeSelections: { [defaultProduct.id]: playerCount },
            shoeProducts: [
              {
                id: defaultProduct.id,
                label: defaultProduct.label,
                priceCents: defaultProduct.priceCents,
                depositPct: defaultProduct.depositPct,
                squareCatalogObjectId: defaultProduct.squareCatalogObjectId,
              },
            ],
            lineItems: [
              ...item.lineItems.filter((li) => !fetched.some((p) => p.id === li.squareProductId)),
              shoeLineItem,
            ],
          } as Partial<BowlingLikeItem>);
        }
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
  // Can't rent more pairs than bowlers in the group.
  const atCap = totalPairs >= playerCount;

  function commitSelections(raw: Record<number, number>) {
    const next: Record<number, number> = {};
    for (const [id, q] of Object.entries(raw)) if (q > 0) next[Number(id)] = q;

    const shoeLineItems = Object.entries(next).map(([id, q]) => {
      const prod = products.find((p) => p.id === Number(id));
      return {
        squareProductId: Number(id),
        quantity: q,
        label: prod?.label,
        priceCents: prod?.priceCents,
        depositPct: prod?.depositPct,
        squareCatalogObjectId: prod?.squareCatalogObjectId,
      };
    });

    const shoeProductsMeta = products
      .filter((p) => (next[p.id] ?? 0) > 0)
      .map((p) => ({
        id: p.id,
        label: p.label,
        priceCents: p.priceCents,
        depositPct: p.depositPct,
        squareCatalogObjectId: p.squareCatalogObjectId,
      }));

    onChange({
      shoeSelections: next,
      shoeProducts: shoeProductsMeta.length > 0 ? shoeProductsMeta : undefined,
      lineItems: [
        ...item.lineItems.filter((li) => !products.some((p) => p.id === li.squareProductId)),
        ...shoeLineItems,
      ],
    } as Partial<BowlingLikeItem>);
  }

  function setQty(productId: number, qty: number) {
    // Clamp so the group's total pairs never exceeds the bowler count.
    const others = totalPairs - (selections[productId] ?? 0);
    const clamped = Math.max(0, Math.min(qty, playerCount - others));
    commitSelections({ ...selections, [productId]: clamped });
  }

  // Safety net: if the group shrank after shoes were chosen (back-nav reduced
  // the bowler count), trim pairs from the back until we're within the cap.
  useEffect(() => {
    if (products.length === 0 || totalPairs <= playerCount) return;
    const next = { ...selections };
    let over = totalPairs - playerCount;
    for (const id of Object.keys(next)
      .map(Number)
      .sort((a, b) => next[b] - next[a])) {
      if (over <= 0) break;
      const cut = Math.min(over, next[id]);
      next[id] -= cut;
      over -= cut;
    }
    commitSelections(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerCount, products.length, totalPairs]);

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
          Add bowling shoes for your group — up to {playerCount} (one per bowler). You can also rent
          at the center.
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
                  disabled={atCap}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 text-lg text-white transition-colors hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-30"
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

const SHOES_INCLUDED_SLUGS = ["fun-4-all", "fun-4-all-vip", "pizza-bowl", "pizza-bowl-vip"];

const BowlingShoesStep: StepDef<BowlingItem> = {
  id: "bowling-shoes",
  title: "Shoes",
  Component: BowlingShoesStepComponent as StepDef<BowlingItem>["Component"],
  isVisible: (item) => !SHOES_INCLUDED_SLUGS.includes(item.experienceSlug ?? ""),
  canAdvance: () => true,
};

export default BowlingShoesStep;
