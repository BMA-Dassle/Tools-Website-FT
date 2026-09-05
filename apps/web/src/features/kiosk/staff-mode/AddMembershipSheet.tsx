"use client";

/**
 * Add membership — staff puts a BMI membership on this person.
 *
 * TERM DEFAULT FOLLOWS THE KIND (owner 2026-09-04): License Fee → 1 year,
 * everything else → 99 years. Picking a kind snaps the End field to its
 * default; the quick chips override; both dates stay editable (MM/DD/YYYY, the
 * numeric on-screen keyboard). Kinds with no id for this center are disabled,
 * never guessed (catalog.ts).
 */
import { useMemo, useState } from "react";
import {
  MEMBERSHIP_KINDS,
  MAX_TERM_YEARS,
  addYears,
  clientKeyForStaffLocation,
  defaultMembershipExpiry,
} from "./catalog";
import { postStaffAction } from "./client";
import { endOfDay, formatLong, formatMdy, parseMdy } from "./dates";
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

const INPUT =
  "w-full rounded-[16px] border border-white/15 bg-white/5 px-[24px] py-[18px] text-[30px] text-white placeholder-white/25 focus:border-[#46d68c] focus:outline-none";

export function AddMembershipSheet({
  target,
  surface,
}: {
  target: StaffTarget;
  surface: StaffSurfaceContextValue;
}) {
  const { token } = useStaffMode();
  const clientKey = clientKeyForStaffLocation(surface.location);
  const kinds = MEMBERSHIP_KINDS;
  const firstAvailable = kinds.find((k) => k.kindId[clientKey]) ?? kinds[0];
  const today = useMemo(() => new Date(), []);

  const [kindKey, setKindKey] = useState(firstAvailable.key);
  const [starts, setStarts] = useState(formatMdy(today));
  const [ends, setEnds] = useState(formatMdy(defaultMembershipExpiry(firstAvailable, today)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kind = kinds.find((k) => k.key === kindKey) ?? firstAvailable;
  const startDate = parseMdy(starts);
  const endDate = parseMdy(ends);

  const pickKind = (key: string) => {
    const k = kinds.find((x) => x.key === key);
    if (!k) return;
    setKindKey(key);
    setError(null);
    const from = parseMdy(starts) ?? today;
    setEnds(formatMdy(defaultMembershipExpiry(k, from)));
  };

  const setTerm = (years: number) => {
    const from = parseMdy(starts) ?? today;
    setEnds(formatMdy(addYears(from, years)));
    setError(null);
  };

  const termLabel = (() => {
    if (!startDate || !endDate) return "";
    const yrs = (endDate.getTime() - startDate.getTime()) / (365.25 * 86_400_000);
    return yrs >= 0.95 ? `${Math.round(yrs)} year${Math.round(yrs) === 1 ? "" : "s"}` : "";
  })();

  const validate = (): string | null => {
    if (!kind.kindId[clientKey]) return `${kind.label} has no id configured for this center yet`;
    if (!startDate) return "Start date must be MM/DD/YYYY";
    if (!endDate) return "End date must be MM/DD/YYYY";
    if (endDate <= startDate) return "End date must be after the start date";
    if (endDate > addYears(startDate, MAX_TERM_YEARS))
      return `Term can't exceed ${MAX_TERM_YEARS} years`;
    return null;
  };

  const submit = async () => {
    const v = validate();
    if (v) return void setError(v);
    if (!startDate || !endDate) return;
    setBusy(true);
    setError(null);
    // "Today" starts now (so it is active immediately); a future start is
    // midnight of that day. End is the end of its day.
    const isToday = formatMdy(startDate) === formatMdy(new Date());
    const activates = isToday ? undefined : startDate.toISOString();
    const res = await postStaffAction(token, {
      action: "membership",
      personId: target.personId,
      ...(target.pandoraPersonId ? { pandoraPersonId: target.pandoraPersonId } : {}),
      personName: target.name,
      kindKey: kind.key,
      ...(activates ? { activates } : {}),
      expires: endOfDay(endDate).toISOString(),
      location: surface.location,
      ...(surface.kioskId ? { kioskId: surface.kioskId } : {}),
    });
    setBusy(false);
    if (!res.ok) return void setError(res.error);
    setStaffNotice(
      `Added ${kind.label} for ${target.name.split(" ")[0]} · until ${formatLong(endDate)}`,
    );
    closeStaffSheet();
  };

  return (
    <StaffSheetFrame
      eyebrow="Staff · Add membership"
      title={target.name}
      subtitle={`BMI ${target.personId}${target.isMinor ? " · minor" : ""}`}
      footer={
        <>
          <SheetCancel onClick={closeStaffSheet} />
          <SheetGo onClick={() => void submit()} busy={busy} disabled={!kind.kindId[clientKey]}>
            Add {kind.label}
          </SheetGo>
        </>
      }
    >
      <div>
        <SheetLabel>Membership</SheetLabel>
        <div className="flex flex-wrap gap-[12px]">
          {kinds.map((k) => (
            <SheetChip
              key={k.key}
              selected={k.key === kindKey}
              disabled={!k.kindId[clientKey]}
              onClick={() => pickKind(k.key)}
              hint={k.defaultTermYears === 1 ? "1 yr" : undefined}
            >
              {k.label}
            </SheetChip>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-[16px]">
        <div>
          <SheetLabel>Starts</SheetLabel>
          <input
            inputMode="numeric"
            data-osk-layout="numeric"
            value={starts}
            onChange={(e) => {
              setStarts(e.target.value);
              setError(null);
            }}
            placeholder="MM/DD/YYYY"
            aria-label="Start date"
            className={INPUT}
          />
          <div className="mt-[6px] text-[20px] text-white/45">
            {startDate ? formatLong(startDate) : "MM/DD/YYYY"}
          </div>
        </div>
        <div>
          <SheetLabel>Ends</SheetLabel>
          <input
            inputMode="numeric"
            data-osk-layout="numeric"
            value={ends}
            onChange={(e) => {
              setEnds(e.target.value);
              setError(null);
            }}
            placeholder="MM/DD/YYYY"
            aria-label="End date"
            className={INPUT}
          />
          <div className="mt-[6px] text-[20px] text-white/45">
            {endDate ? `${formatLong(endDate)}${termLabel ? ` · ${termLabel}` : ""}` : "MM/DD/YYYY"}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-[12px]">
        <SheetChip selected={termLabel === "1 year"} onClick={() => setTerm(1)}>
          1 year
        </SheetChip>
        <SheetChip selected={termLabel === "99 years"} onClick={() => setTerm(99)}>
          99 years
        </SheetChip>
      </div>

      <p className="border-l-4 border-[#46d68c]/50 pl-[16px] text-[22px] leading-snug text-white/50">
        License defaults to 1 year; every other membership defaults to 99 years. Written to BMI for
        this center&apos;s catalogue and logged under your employee id.
      </p>

      {error && <SheetError>{error}</SheetError>}
    </StaffSheetFrame>
  );
}
