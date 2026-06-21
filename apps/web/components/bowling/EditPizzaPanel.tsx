"use client";

import { useEffect, useRef, useState } from "react";
import CardCaptureForm, { type CardCaptureHandle } from "@/components/square/CardCaptureForm";

/**
 * Guest-facing panel to change a Pizza Bowl's TOPPINGS + DRINK up to check-in.
 * Shared by the bowling-only confirmation (BowlingConfirmation) and the v2
 * multi-activity confirmation page.
 *
 * Behavior (matches the booking food step + the [id]/food endpoint):
 *  - 1 topping included per lane, $1 each extra. A drink is required per lane.
 *  - Add-only: picking more toppings than already paid charges the difference
 *    (a card is captured inline); swaps or fewer are free (no refund).
 *  - On save, PATCH /api/bowling/v2/reservations/{id}/food updates the day-of
 *    order line notes + the Neon record. The kitchen KDS reflects it.
 */

const PIZZA_BOWL_PIZZA_CATALOG_ID = "2IKZB4O2HQBXWMTSUQ2SEKJY";
const PIZZA_BOWL_SODA_CATALOG_ID = "SJUBJLB4QGHIHCW5AKTTMLH7";
const FREE_TOPPINGS = 1;
const EXTRA_TOPPING_CENTS = 100;
const CORAL = "#fd5b56";

interface ModifierGroup {
  id: string;
  name: string;
  selectionType: "SINGLE" | "MULTIPLE";
  options: Array<{ id: string; name: string }>;
}

interface Props {
  reservationId: number;
  laneCount: number;
  /** "headpinz" | "naples" or a raw Square location id — for the card form. */
  locationId?: string;
  /** Extra-topping $ already paid on the order (cents), to compute the add-only diff. */
  currentExtraToppingsCents?: number;
  onUpdated?: () => void;
}

const isSodaGroup = (g: ModifierGroup) => /soda|drink|pitcher/i.test(g.name);

export default function EditPizzaPanel({
  reservationId,
  laneCount,
  locationId,
  currentExtraToppingsCents = 0,
  onUpdated,
}: Props) {
  const [groups, setGroups] = useState<ModifierGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [selections, setSelections] = useState<Array<Record<string, string[]>>>(
    Array.from({ length: laneCount }, () => ({})),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const cardRef = useRef<CardCaptureHandle>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(
          `/api/bowling/v2/catalog-modifiers?catalogObjectId=${PIZZA_BOWL_PIZZA_CATALOG_ID}`,
        );
        const data = await res.json();
        if (res.ok && Array.isArray(data)) setGroups(data);
      } catch {
        /* non-fatal */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function toggle(laneIdx: number, group: ModifierGroup, optionId: string) {
    setSelections((prev) => {
      const next = prev.map((s) => ({ ...s }));
      const cur = next[laneIdx][group.id] ?? [];
      if (group.selectionType === "SINGLE") {
        next[laneIdx][group.id] = cur.includes(optionId) ? [] : [optionId];
      } else {
        next[laneIdx][group.id] = cur.includes(optionId)
          ? cur.filter((id) => id !== optionId)
          : [...cur, optionId];
      }
      return next;
    });
    setDone(false);
  }

  function toppingCount(sel: Record<string, string[]>): number {
    return groups.reduce((n, g) => (isSodaGroup(g) ? n : n + (sel[g.id]?.length ?? 0)), 0);
  }

  const newExtraCents =
    selections.reduce((s, sel) => s + Math.max(0, toppingCount(sel) - FREE_TOPPINGS), 0) *
    EXTRA_TOPPING_CENTS;
  const diffCents = Math.max(0, newExtraCents - currentExtraToppingsCents);

  // Drink required for every lane before saving.
  const sodaGroupIds = groups.filter(isSodaGroup).map((g) => g.id);
  const allDrinksPicked =
    sodaGroupIds.length === 0 ||
    selections.every((sel) => sodaGroupIds.some((gid) => (sel[gid]?.length ?? 0) > 0));

  function buildRawItems() {
    return selections.flatMap((sel, idx) => {
      const prefix = laneCount > 1 ? `Lane ${idx + 1}: ` : "";
      const toppings = groups
        .filter((g) => !isSodaGroup(g))
        .flatMap((g) =>
          (sel[g.id] ?? []).map((id) => g.options.find((o) => o.id === id)?.name ?? id),
        )
        .join(", ");
      const drink = groups
        .filter(isSodaGroup)
        .flatMap((g) =>
          (sel[g.id] ?? []).map((id) => g.options.find((o) => o.id === id)?.name ?? id),
        )
        .join(", ");
      return [
        {
          catalogObjectId: PIZZA_BOWL_PIZZA_CATALOG_ID,
          name: "Pizza Bowl Pizza",
          quantity: 1,
          ...(toppings ? { note: `${prefix}${toppings}` } : {}),
        },
        {
          catalogObjectId: PIZZA_BOWL_SODA_CATALOG_ID,
          name: "Pizza Bowl Soda Pitcher",
          quantity: 1,
          ...(drink ? { note: `${prefix}${drink}` } : {}),
        },
      ];
    });
  }

  async function save() {
    setError(null);
    if (!allDrinksPicked) {
      setError(laneCount > 1 ? "Choose a drink for every lane." : "Choose a drink.");
      return;
    }
    setSubmitting(true);
    try {
      let squareToken: string | undefined;
      if (diffCents > 0) {
        const r = await cardRef.current?.tokenize();
        if (!r || "error" in r) {
          setError(r && "error" in r ? r.error : "Enter a card to cover the added toppings.");
          setSubmitting(false);
          return;
        }
        squareToken = r.token;
      }
      const res = await fetch(`/api/bowling/v2/reservations/${reservationId}/food`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rawItems: buildRawItems(),
          extraToppingsCents: newExtraCents,
          expectedDiffCents: diffCents,
          ...(squareToken ? { squareToken } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not update your order. Please try again.");
        setSubmitting(false);
        return;
      }
      setDone(true);
      onUpdated?.();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div
          className="h-7 w-7 animate-spin rounded-full border-2 border-white/15"
          style={{ borderTopColor: CORAL }}
        />
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-white/50">
        Food changes can be made at the center.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-center text-xs text-white/40">
        {FREE_TOPPINGS} topping included per lane &middot; $1 each extra &middot; drink required
      </p>

      {Array.from({ length: laneCount }).map((_, laneIdx) => {
        const sel = selections[laneIdx] ?? {};
        return (
          <div
            key={laneIdx}
            className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-4"
          >
            {laneCount > 1 && (
              <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">
                Lane {laneIdx + 1}
              </h4>
            )}
            {groups.map((group) => {
              const selected = sel[group.id] ?? [];
              const soda = isSodaGroup(group);
              return (
                <div key={group.id}>
                  <p className="mb-2 text-xs font-semibold text-white/60">
                    {group.name}
                    {!soda && (
                      <span className="ml-1 text-white/30">
                        ({selected.length}/{FREE_TOPPINGS} free)
                      </span>
                    )}
                    {soda && (
                      <span
                        className="ml-1"
                        style={{ color: selected.length ? "rgba(255,255,255,0.3)" : CORAL }}
                      >
                        (required)
                      </span>
                    )}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {group.options.map((opt) => {
                      const on = selected.includes(opt.id);
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => toggle(laneIdx, group, opt.id)}
                          className="rounded-lg px-3 py-1.5 text-xs font-medium transition-all"
                          style={{
                            backgroundColor: on ? CORAL : "rgba(253,91,86,0.10)",
                            color: on ? "#0a1628" : CORAL,
                            fontWeight: on ? 700 : 500,
                          }}
                        >
                          {opt.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {diffCents > 0 && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 space-y-3">
          <p className="text-sm font-semibold text-amber-300">
            Added toppings: ${(diffCents / 100).toFixed(2)} — enter a card to confirm
          </p>
          <CardCaptureForm ref={cardRef} locationId={locationId} />
        </div>
      )}

      {error && <p className="text-center text-xs text-red-400">{error}</p>}
      {done && (
        <p className="text-center text-xs text-green-400">Order updated — see you at the lanes!</p>
      )}

      <button
        type="button"
        onClick={save}
        disabled={submitting || !allDrinksPicked}
        className="w-full rounded-xl py-3 text-sm font-bold uppercase tracking-widest transition-all disabled:opacity-40"
        style={{ backgroundColor: CORAL, color: "#0a1628" }}
      >
        {submitting
          ? "Saving…"
          : diffCents > 0
            ? `Pay $${(diffCents / 100).toFixed(2)} & update`
            : "Update order"}
      </button>
    </div>
  );
}
