"use client";

/**
 * Edit a BOOKED package's food (Pizza Bowl pizza + pitcher) — the one editor.
 *
 * Mounted in four places: the confirmation page ("Change pizza & drink"), the
 * web check-in page and the kiosk lane-open panel (where "Open lane" waits on
 * it — owner 2026-09-06: "when they hit open lane they should be able to select
 * it there"), and the reservation-admin Overview card. It replaces the old
 * EditPizzaPanel, which hardcoded two catalog ids and a drink regex the booking
 * step had already dropped.
 *
 * INCLUDED PICKS ONLY. Owner 2026-09-06: post-booking edits never add money to
 * the bill. Priced options are not shown (withoutPaidOptions), a tap that would
 * cost anything is ignored, and the server refuses a non-zero extras total. An
 * order that already carries paid extras is not editable here (front desk).
 *
 * It reads GET …/food (config + live groups + the guest's current picks parsed
 * back from our stored lines) and writes PATCH …/food with the new picks; the
 * server owns the rules and the Square/Neon writes.
 *
 * Two modes: "standalone" renders its own Update button; "embedded" hides it
 * and the host saves through the imperative `save()` handle as part of its own
 * action (open lane). `onStatus` tells the host whether there is food at all,
 * whether it is complete, and whether there are unsaved changes.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { useT } from "~/features/kiosk/i18n/useT";
import {
  extraCentsTotal,
  foodSelectionIssue,
  toggleSelection,
  withoutPaidOptions,
  type LaneSelections,
} from "~/features/booking/service/food-config";
import type { ReservationFoodState } from "~/features/package-food";
import { FoodPicker } from "~/components/features/booking/steps/bowling/FoodPicker";

export interface FoodEditorStatus {
  loading: boolean;
  /** Load failed (retry offered). */
  error: string | null;
  /** This package has guest-configured food at all. */
  hasFood: boolean;
  /** Every included pick is made on every lane (true when there is no food). */
  complete: boolean;
  /** Picks differ from what is saved. */
  dirty: boolean;
  laneOpen: boolean;
  /** The current actor may save right now. */
  editable: boolean;
}

export interface PackageFoodEditorHandle {
  /** Save if dirty (no-op when clean and complete). Resolves ok=false with a
   *  guest-readable error when the picks are incomplete or the save failed. */
  save: () => Promise<{ ok: boolean; error?: string }>;
}

interface Props {
  neonId: number;
  /** Present → staff mode: admin route, no time limit. */
  adminToken?: string;
  mode?: "standalone" | "embedded";
  accent?: string;
  onAccent?: string;
  hideHeading?: boolean;
  onStatus?: (status: FoodEditorStatus) => void;
  onSaved?: () => void;
}

export const PackageFoodEditor = forwardRef<PackageFoodEditorHandle, Props>(
  function PackageFoodEditor(
    {
      neonId,
      adminToken,
      mode = "standalone",
      accent = "#fd5b56",
      onAccent = "#0a1628",
      hideHeading = false,
      onStatus,
      onSaved,
    },
    ref,
  ) {
    const t = useT();
    const isAdmin = !!adminToken;
    const url = isAdmin
      ? `/api/admin/reservations/food?token=${encodeURIComponent(adminToken!)}&id=${neonId}`
      : `/api/bowling/v2/reservations/${neonId}/food`;

    const [state, setState] = useState<ReservationFoodState | null>(null);
    const [selections, setSelections] = useState<LaneSelections[]>([]);
    const [saved, setSaved] = useState<LaneSelections[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    useEffect(() => {
      let cancelled = false;
      setLoading(true);
      setLoadError(null);
      void (async () => {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) throw new Error(`food ${res.status}`);
          const data = (await res.json()) as ReservationFoodState;
          if (cancelled) return;
          setState(data);
          setSelections(data.selections);
          setSaved(data.selections);
        } catch (err) {
          if (cancelled) return;
          console.warn("[PackageFoodEditor] load failed:", err);
          setLoadError(t("food.edit.loadFail"));
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, attempt]);

    // The picker shows only what the package includes — no priced options.
    const fullItems = state?.foodItems;
    const foodItems = useMemo(() => withoutPaidOptions(fullItems ?? []), [fullItems]);
    const laneCount = state?.laneCount ?? 1;
    const hasFood = (fullItems?.length ?? 0) > 0;
    const issue = hasFood ? foodSelectionIssue({ foodItems, selections, laneCount }) : null;
    const complete = issue === null;
    const dirty = useMemo(
      () => JSON.stringify(selections) !== JSON.stringify(saved),
      [selections, saved],
    );
    const laneOpen = state?.laneOpen ?? false;
    const gate = state ? (isAdmin ? state.adminEditable : state.guestEditable) : null;
    const editable = !!gate?.ok;

    useEffect(() => {
      onStatus?.({ loading, error: loadError, hasFood, complete, dirty, laneOpen, editable });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, loadError, hasFood, complete, dirty, laneOpen, editable]);

    const save = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
      setSaveError(null);
      if (!state || !hasFood) return { ok: true };
      if (issue) {
        setSaveError(issue);
        return { ok: false, error: issue };
      }
      if (!dirty) return { ok: true };
      if (!editable) {
        const reason = gate && !gate.ok ? gate.reason : t("food.edit.saveFail");
        setSaveError(reason);
        return { ok: false, error: reason };
      }
      setSaving(true);
      try {
        const res = await fetch(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selections }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          const msg = data.error ?? t("food.edit.saveFail");
          setSaveError(msg);
          return { ok: false, error: msg };
        }
        setSaved(selections);
        setDone(true);
        onSaved?.();
        return { ok: true };
      } catch {
        const msg = t("food.edit.saveFail");
        setSaveError(msg);
        return { ok: false, error: msg };
      } finally {
        setSaving(false);
      }
    }, [state, hasFood, issue, dirty, editable, gate, url, selections, onSaved, t]);

    useImperativeHandle(ref, () => ({ save }), [save]);

    if (loading && !state) {
      return (
        <div className="flex justify-center py-8">
          <div
            className="h-7 w-7 animate-spin rounded-full border-2 border-white/15"
            style={{ borderTopColor: accent }}
          />
        </div>
      );
    }
    if (loadError || !state) {
      return (
        <div className="space-y-3 py-4 text-center">
          <p className="text-sm text-white/60">{loadError ?? t("food.edit.loadFail")}</p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="min-h-11 rounded-lg px-5 py-2.5 text-xs font-bold uppercase tracking-wider"
            style={{ backgroundColor: accent, color: onAccent }}
          >
            {t("food.retry")}
          </button>
        </div>
      );
    }
    // No configurable food on this package — the host hides the section via onStatus.
    if (!hasFood) return null;

    if (!editable) {
      // Lane already open (guest), or paid extras on the order (everyone).
      const reason =
        gate && !gate.ok && state.paidExtrasCents > 0
          ? t("food.edit.paidExtras")
          : t("food.edit.laneOpen");
      return <p className="py-3 text-center text-sm text-white/60">{reason}</p>;
    }

    return (
      <div className="space-y-4">
        {!hideHeading && (
          <h3 className="text-center font-display text-lg uppercase tracking-widest text-white">
            {t("food.edit.title")}
          </h3>
        )}
        {!complete && (
          <p
            className="rounded-lg px-3 py-2 text-center text-xs font-semibold"
            style={{ backgroundColor: "rgba(251,191,36,0.12)", color: "#fbbf24" }}
          >
            {t("food.edit.missing")}
          </p>
        )}

        <FoodPicker
          foodItems={foodItems}
          selections={selections}
          laneCount={laneCount}
          accent={accent}
          onAccent={onAccent}
          hideHeading
          onTap={(laneIndex, group, optionId) => {
            const next = toggleSelection({
              selections,
              laneIndex,
              groupId: group.id,
              optionId,
              selectionType: group.selectionType,
            });
            // Nothing that adds money (owner 2026-09-06). Priced options are
            // already hidden; this catches a pick beyond an item's included
            // count on a package that charges for extras.
            if (extraCentsTotal({ foodItems, selections: next, laneCount }) > 0) return;
            setDone(false);
            setSelections(next);
          }}
        />

        {saveError && <p className="text-center text-xs text-red-400">{saveError}</p>}
        {done && !dirty && (
          <p className="text-center text-xs text-green-400">{t("food.edit.saved")}</p>
        )}

        {mode === "standalone" && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !complete || !dirty}
            className="min-h-11 w-full rounded-xl py-3 text-sm font-bold uppercase tracking-widest transition-all disabled:opacity-40"
            style={{ backgroundColor: accent, color: onAccent }}
          >
            {saving ? t("food.edit.saving") : t("food.edit.save")}
          </button>
        )}
      </div>
    );
  },
);
