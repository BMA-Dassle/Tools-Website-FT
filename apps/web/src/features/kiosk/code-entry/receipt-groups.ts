/**
 * Receipt row grouping — a 7-guest VIP voucher used to render 14 rows
 * (owner screenshot 2026-08-02: "combine line and do by qty plus or minus").
 * Identical legs collapse to one row with a quantity; the component renders
 * −/+ steppers against these groups. Pure list operations, extracted so the
 * grouping rules are tested (the receipt-plan.ts precedent).
 */
import type { PendingGzCard } from "./pending-cards";

/** One applied cart-voucher leg as the parent hands it to the receipt. */
export interface CartLeg {
  code: string;
  label: string;
  /** Raw coverage name (native legs) — the key "+" uses to find another
   *  unspent leg of the same kind in the validate response. */
  name?: string | null;
  error?: string | null;
  itemIndex?: number | null;
}

export interface CartGroup {
  code: string;
  label: string;
  name: string | null;
  error: string | null;
  /** Native leg indexes, ascending — "−" removes the LAST one. Empty for a
   *  BMI (whole-code) row. */
  itemIndexes: number[];
  qty: number;
  /** Native legs support the −/+ stepper; BMI rows keep the single ✕. */
  native: boolean;
}

/**
 * Collapse identical native legs (same code + label) into one quantity row.
 * Errored rows stay individual — each needs its own attention — and BMI rows
 * are one-per-code already, so both pass through ungrouped.
 */
export function groupCartLegs(legs: readonly CartLeg[]): CartGroup[] {
  const out: CartGroup[] = [];
  const byKey = new Map<string, CartGroup>();
  for (const l of legs) {
    const native = typeof l.itemIndex === "number";
    if (!native || l.error) {
      out.push({
        code: l.code,
        label: l.label,
        name: l.name ?? null,
        error: l.error ?? null,
        itemIndexes: native ? [l.itemIndex as number] : [],
        qty: 1,
        native,
      });
      continue;
    }
    const key = `${l.code}|${l.label}`;
    const g = byKey.get(key);
    if (g) {
      g.itemIndexes.push(l.itemIndex as number);
      g.qty += 1;
    } else {
      const ng: CartGroup = {
        code: l.code,
        label: l.label,
        name: l.name ?? null,
        error: null,
        itemIndexes: [l.itemIndex as number],
        qty: 1,
        native: true,
      };
      byKey.set(key, ng);
      out.push(ng);
    }
  }
  for (const g of byKey.values()) g.itemIndexes.sort((a, b) => a - b);
  return out;
}

export interface UsedGroup {
  code: string;
  label: string;
  qty: number;
}

/** Collapse already-used legs (display-only, struck through) by code+label. */
export function groupUsedLegs(
  spentByCode: Record<string, { index: number; label: string }[]>,
): UsedGroup[] {
  const out: UsedGroup[] = [];
  const byKey = new Map<string, UsedGroup>();
  for (const [code, legs] of Object.entries(spentByCode)) {
    for (const leg of legs) {
      const key = `${code}|${leg.label}`;
      const g = byKey.get(key);
      if (g) g.qty += 1;
      else {
        const ng: UsedGroup = { code, label: leg.label, qty: 1 };
        byKey.set(key, ng);
        out.push(ng);
      }
    }
  }
  return out;
}

export interface GzGroup {
  code: string;
  tokens: number;
  qty: number;
}

/** Collapse pending game-card legs by code + token value. */
export function groupGzCards(cards: readonly PendingGzCard[]): GzGroup[] {
  const out: GzGroup[] = [];
  const byKey = new Map<string, GzGroup>();
  for (const c of cards) {
    const key = `${c.code}|${c.tokens}`;
    const g = byKey.get(key);
    if (g) g.qty += 1;
    else {
      const ng: GzGroup = { code: c.code, tokens: c.tokens, qty: 1 };
      byKey.set(key, ng);
      out.push(ng);
    }
  }
  return out;
}
