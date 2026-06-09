"use client";

import { useMemo } from "react";
import type { AttractionItem, StepDef } from "~/features/booking";
import {
  resolveAttractionContext,
  type AttractionProductDef,
} from "~/features/booking/service/attractions";

const AttractionProductStepComponent: StepDef<AttractionItem>["Component"] = ({
  item,
  session,
  onChange,
}) => {
  const ctx = useMemo(
    () => (item.slug ? resolveAttractionContext(item.slug, session) : null),
    [item.slug, session],
  );

  if (!ctx) {
    return <p className="text-sm text-white/50">Unknown attraction.</p>;
  }

  const products = ctx.config.products.filter((p) => p.location === ctx.location);
  const isPerPerson = ctx.config.bookingMode === "per-person";

  const handlePickProduct = (p: AttractionProductDef) => {
    const pageId = ctx.config.pageIds[ctx.location] ?? null;
    onChange({
      productId: p.productId,
      pageId,
      price: p.price,
      slot: null,
      slotProposal: null,
    });
  };

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="text-center">
        <p
          className="text-xs font-bold tracking-widest uppercase"
          style={{ color: ctx.config.color }}
        >
          {ctx.config.building}
        </p>
        <h2 className="font-display mt-1 text-2xl tracking-widest text-white uppercase">
          {ctx.config.name}
        </h2>
        <p className="mt-1 text-sm text-white/50">{ctx.config.description}</p>
      </div>

      {/* Product cards */}
      <div className="space-y-3">
        {products.length === 1 && isPerPerson ? (
          <SingleProductWithQty
            product={products[0]}
            selected={item.productId === products[0].productId}
            qty={item.qty}
            maxQty={ctx.config.maxGroupSize}
            accentColor={ctx.config.color}
            onSelect={() => handlePickProduct(products[0])}
            onQtyChange={(qty) => onChange({ qty })}
          />
        ) : (
          products.map((p) => (
            <ProductCard
              key={p.productId}
              product={p}
              selected={item.productId === p.productId}
              accentColor={ctx.config.color}
              bookingMode={ctx.config.bookingMode}
              onSelect={() => handlePickProduct(p)}
            />
          ))
        )}
      </div>

      {/* Qty stepper for multi-product per-person attractions */}
      {isPerPerson && products.length > 1 && item.productId && (
        <QtyStepperBlock
          qty={item.qty}
          maxQty={ctx.config.maxGroupSize}
          accentColor={ctx.config.color}
          onChange={(qty) => onChange({ qty })}
        />
      )}
    </div>
  );
};

function ProductCard({
  product,
  selected,
  accentColor,
  bookingMode,
  onSelect,
}: {
  product: AttractionProductDef;
  selected: boolean;
  accentColor: string;
  bookingMode: "per-person" | "per-slot";
  onSelect: () => void;
}) {
  const durationLabel =
    product.durationMin >= 60 ? `${product.durationMin / 60} hour` : `${product.durationMin} min`;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Select ${product.name} — $${product.price.toFixed(2)}`}
      className={`w-full rounded-xl border-2 p-4 text-left transition-colors ${
        selected ? "bg-white/[0.06]" : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
      }`}
      style={
        selected ? { borderColor: accentColor, backgroundColor: `${accentColor}10` } : undefined
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2"
            style={{ borderColor: selected ? accentColor : "rgba(255,255,255,0.3)" }}
          >
            {selected && (
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: accentColor }} />
            )}
          </span>
          <div>
            <span className="text-sm font-bold text-white">{product.name}</span>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-white/40">
              <span>{durationLabel}</span>
              {product.isCombo && (
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase"
                  style={{ backgroundColor: `${accentColor}20`, color: accentColor }}
                >
                  Combo
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="text-right">
          <span className="text-base font-bold" style={{ color: accentColor }}>
            ${product.price.toFixed(2)}
          </span>
          <span className="ml-1 text-xs text-white/30">
            /{bookingMode === "per-person" ? "person" : "lane"}
          </span>
        </div>
      </div>
    </button>
  );
}

function SingleProductWithQty({
  product,
  selected,
  qty,
  maxQty,
  accentColor,
  onSelect,
  onQtyChange,
}: {
  product: AttractionProductDef;
  selected: boolean;
  qty: number;
  maxQty: number;
  accentColor: string;
  onSelect: () => void;
  onQtyChange: (qty: number) => void;
}) {
  const handleSelect = () => {
    if (!selected) onSelect();
  };

  return (
    <div
      className={`rounded-xl border-2 p-5 transition-colors ${
        selected ? "bg-white/[0.06]" : "border-white/10 bg-white/[0.02]"
      }`}
      style={
        selected ? { borderColor: accentColor, backgroundColor: `${accentColor}10` } : undefined
      }
    >
      <button
        type="button"
        onClick={handleSelect}
        aria-label={`Select ${product.name}`}
        className="w-full text-left"
      >
        <div className="flex items-center justify-between">
          <div>
            <span className="text-base font-bold text-white">{product.name}</span>
            <p className="mt-0.5 text-xs text-white/40">{product.durationMin} min session</p>
          </div>
          <div className="text-right">
            <span className="text-xl font-bold" style={{ color: accentColor }}>
              ${product.price.toFixed(2)}
            </span>
            <span className="ml-1 text-xs text-white/30">/person</span>
          </div>
        </div>
      </button>

      {selected && (
        <div className="mt-4 border-t border-white/10 pt-4">
          <QtyStepperBlock
            qty={qty}
            maxQty={maxQty}
            accentColor={accentColor}
            onChange={onQtyChange}
          />
        </div>
      )}
    </div>
  );
}

function QtyStepperBlock({
  qty,
  maxQty,
  accentColor,
  onChange,
}: {
  qty: number;
  maxQty: number;
  accentColor: string;
  onChange: (qty: number) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-4 py-3">
      <span className="text-sm text-white/60">How many people?</span>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onChange(Math.max(1, qty - 1))}
          disabled={qty <= 1}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 text-lg text-white/50 transition-colors hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
        >
          -
        </button>
        <span className="w-6 text-center text-sm font-bold text-white">{qty}</span>
        <button
          type="button"
          onClick={() => onChange(Math.min(maxQty, qty + 1))}
          disabled={qty >= maxQty}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 text-lg text-white/50 transition-colors hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
        >
          +
        </button>
      </div>
    </div>
  );
}

export const AttractionProductStep: StepDef<AttractionItem> = {
  id: "attraction-product",
  title: "Activity",
  Component: AttractionProductStepComponent,
  isVisible: (item) => item.slug !== null,
  canAdvance: (item) => {
    if (!item.productId) return { reason: "Choose an activity to continue." };
    return true;
  },
};
