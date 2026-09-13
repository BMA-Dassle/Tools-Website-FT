"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { EVENT_TEST_IDS, FOOD_OUT_PRESETS } from "~/features/crm/events/contracts";
import { eventsKeys } from "~/features/crm/events/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { saveFoodOut } from "../events/queries";

/**
 * `foodout(id)` (crm-events.js:144): eight one-tap times, or type one. The
 * write goes through `saveManualFoodOut`, which marks the row `manual` (so the
 * AI extraction stops overwriting it) and syncs the `----- Portal Staff -----`
 * line in BMI.
 */
export interface FoodOutSheetProps {
  publicId: string;
  current: string | null;
  onDone: () => void;
}

export function FoodOutSheet({ publicId, current, onDone }: FoodOutSheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const id = useId();
  const [typed, setTyped] = useState("");

  const save = useMutation({
    mutationFn: (time: string | null) => saveFoodOut(crmFetch, publicId, time),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: eventsKeys.all });
      toast(
        r.foodOut.time
          ? `Food out ${r.foodOut.time} · synced to the kitchen board and BMI`
          : "Food out cleared",
      );
      onDone();
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  return (
    <div className="stack" data-testid={EVENT_TEST_IDS.foodOutSheet}>
      <div className="grid grid-4">
        {FOOD_OUT_PRESETS.map((t) => (
          <button
            key={t}
            type="button"
            className={t === current ? "btn btn-primary" : "btn"}
            disabled={save.isPending}
            onClick={() => save.mutate(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor={`${id}-typed`}>Or type a time</label>
        <input
          id={`${id}-typed`}
          className="input"
          placeholder="e.g. 4:30 PM or 16:30"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>
      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        {current ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
          >
            Clear
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={!typed.trim() || save.isPending}
          onClick={() => save.mutate(typed.trim())}
        >
          Set {typed.trim() || "time"}
        </button>
      </div>
    </div>
  );
}
