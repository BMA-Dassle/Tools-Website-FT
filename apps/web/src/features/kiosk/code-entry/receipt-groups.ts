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

/** The slice of a validate-response item the ghost builders need. */
export interface UnspentItem {
  index: number;
  redeemVia: "gamezone" | "cart";
  label: string;
  coverageName?: string;
  tokens?: number;
}

/**
 * "0 of M" ghost rows (owner 2026-08-02: a row stepped down to zero stays
 * visible as zero-of-max instead of vanishing, so "+" can bring it back
 * without a re-scan). One ghost per voucher cart KIND (code + coverageName)
 * that has NO applied leg right now. Label comes from the validate item —
 * the applied rows' label for the same kind. Session-local by construction:
 * ghosts only exist while the code's validate result is held.
 */
export function ghostCartGroups(
  unspentByCode: Record<string, UnspentItem[]>,
  applied: readonly CartLeg[],
): CartGroup[] {
  const appliedKinds = new Set(applied.map((l) => `${l.code}|${l.name ?? ""}`));
  const out: CartGroup[] = [];
  const seen = new Set<string>();
  for (const [code, items] of Object.entries(unspentByCode)) {
    for (const i of items) {
      if (i.redeemVia !== "cart" || !i.coverageName) continue;
      const key = `${code}|${i.coverageName}`;
      if (appliedKinds.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({
        code,
        label: i.label,
        name: i.coverageName,
        error: null,
        itemIndexes: [],
        qty: 0,
        native: true,
      });
    }
  }
  return out;
}

/** Game-card counterpart: a code with unspent gz legs but nothing pending. */
export function ghostGzGroups(
  unspentByCode: Record<string, UnspentItem[]>,
  pending: readonly PendingGzCard[],
): GzGroup[] {
  const pendingCodes = new Set(pending.map((c) => c.code));
  const out: GzGroup[] = [];
  for (const [code, items] of Object.entries(unspentByCode)) {
    if (pendingCodes.has(code)) continue;
    const gz = items.filter((i) => i.redeemVia === "gamezone");
    if (gz.length === 0) continue;
    out.push({ code, tokens: gz[0].tokens ?? 0, qty: 0 });
  }
  return out;
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
