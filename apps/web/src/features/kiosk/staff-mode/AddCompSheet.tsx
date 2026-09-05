"use client";

/**
 * Add comp — staff posts N complimentary credits of one kind to this person's
 * BMI account (a Pandora deposit, the same rail the admin panel's comp uses).
 * Reason is free text (owner 2026-09-04: "a text field of typing anything").
 */
import { useState } from "react";
import { COMP_KINDS, MAX_COMP_QTY, clientKeyForStaffLocation } from "./catalog";
import { postStaffAction } from "./client";
import {
  SheetCancel,
  SheetChip,
  SheetError,
  SheetGo,
  SheetLabel,
  StaffSheetFrame,
} from "./StaffSheetFrame";
import { closeStaffSheet, setStaffNotice, useStaffMode } from "./store";
import type { StaffSurfaceContextValue } from "./StaffModeSurface";
import type { StaffTarget } from "./types";

export function AddCompSheet({
  target,
  surface,
}: {
  target: StaffTarget;
  surface: StaffSurfaceContextValue;
}) {
  const { token } = useStaffMode();
  const clientKey = clientKeyForStaffLocation(surface.location);
  const firstAvailable = COMP_KINDS.find((k) => k.depositKindId[clientKey]) ?? COMP_KINDS[0];
  const [kindKey, setKindKey] = useState(firstAvailable.key);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = COMP_KINDS.find((k) => k.key === kindKey) ?? firstAvailable;
  const configured = !!kind.depositKindId[clientKey];

  const submit = async () => {
    if (!configured)
      return void setError(`${kind.label} comps have no id configured for this center yet`);
    setBusy(true);
    setError(null);
    const res = await postStaffAction(token, {
      action: "comp",
      personId: target.personId,
      ...(target.pandoraPersonId ? { pandoraPersonId: target.pandoraPersonId } : {}),
      personName: target.name,
      kindKey: kind.key,
      qty,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
      location: surface.location,
      ...(surface.kioskId ? { kioskId: surface.kioskId } : {}),
    });
    setBusy(false);
    if (!res.ok) return void setError(res.error);
    setStaffNotice(
      `Added ${qty} ${kind.label} comp${qty === 1 ? "" : "s"} for ${target.name.split(" ")[0]}`,
    );
    closeStaffSheet();
  };

  return (
    <StaffSheetFrame
      eyebrow="Staff · Add comp"
      title={target.name}
      subtitle={`BMI ${target.personId}`}
      footer={
        <>
          <SheetCancel onClick={closeStaffSheet} />
          <SheetGo onClick={() => void submit()} busy={busy} disabled={!configured}>
            Add {qty} {kind.label} comp{qty === 1 ? "" : "s"}
          </SheetGo>
        </>
      }
    >
      <div>
        <SheetLabel>Comp type</SheetLabel>
        <div className="flex flex-wrap gap-[12px]">
          {COMP_KINDS.map((k) => (
            <SheetChip
              key={k.key}
              selected={k.key === kindKey}
              disabled={!k.depositKindId[clientKey]}
              onClick={() => {
                setKindKey(k.key);
                setError(null);
              }}
            >
              {k.label}
            </SheetChip>
          ))}
        </div>
      </div>

      <div>
        <SheetLabel>How many</SheetLabel>
        <div className="inline-flex items-stretch" role="group" aria-label="Quantity">
          <button
            type="button"
            onClick={() => setQty((q) => Math.max(1, q - 1))}
            disabled={qty <= 1}
            aria-label="Fewer"
            className="k-tap grid h-[92px] w-[92px] place-items-center rounded-l-[16px] border-2 border-white/10 text-[40px] text-white/60 disabled:opacity-35"
          >
            −
          </button>
          <span className="k-display k-num grid h-[92px] min-w-[150px] place-items-center border-y-2 border-white/10 text-[46px]">
            {qty}
          </span>
          <button
            type="button"
            onClick={() => setQty((q) => Math.min(MAX_COMP_QTY, q + 1))}
            disabled={qty >= MAX_COMP_QTY}
            aria-label="More"
            className="k-tap grid h-[92px] w-[92px] place-items-center rounded-r-[16px] border-2 border-white/10 text-[40px] text-white/60 disabled:opacity-35"
          >
            +
          </button>
        </div>
      </div>

      <div>
        <SheetLabel>Reason (optional)</SheetLabel>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 300))}
          placeholder="Why — e.g. kart stalled in heat 41"
          aria-label="Reason"
          className="w-full rounded-[16px] border border-white/15 bg-white/5 px-[24px] py-[18px] text-[28px] text-white placeholder-white/25 focus:border-[#46d68c] focus:outline-none"
        />
      </div>

      <p className="border-l-4 border-[#46d68c]/50 pl-[16px] text-[22px] leading-snug text-white/50">
        Posts a comp deposit to this BMI account. Saved to our database first — you, the guest, the
        kind, the quantity and the reason — so a BMI blip never loses the comp.
      </p>

      {error && <SheetError>{error}</SheetError>}
    </StaffSheetFrame>
  );
}
