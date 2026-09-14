"use client";

import { useEffect, useRef, useState } from "react";
import type { Dispatch } from "react";
import { useT } from "../i18n";
import { useKioskConfig } from "../KioskConfigContext";
import { kioskDeviceKey } from "../config";
import { clarityEvent } from "~/lib/clarity";
import type { Action } from "~/features/booking/state/machine";
import type { BookingSession } from "~/features/booking/state/types";
import {
  freeRacesRemaining,
  type SessionEmployee,
} from "~/features/discount-codes/programs/employee";
import { employeeApi } from "~/features/discount-codes/programs/employee-client";
import { toMatchable } from "./KioskTeamMemberEntry";

/**
 * KIOSK — code-free RECOGNITION of a linked team member (owner 2026-09-13:
 * "every time after: sign in as yourself"). Watches the party: when a member
 * that a BMI LOOKUP produced (has `bmiPersonId`) joins and no employee is on
 * the session yet, asks the server once whether that BMI person is a linked,
 * still-active employee whose record still passes the name rule. Yes → the
 * "Welcome back" sheet; the guest chooses. No → nothing happens, silently.
 *
 * Proof lives in how the member got here: the kiosk only produces a
 * `bmiPersonId` from a licence scan, a phone sign-in that passed a text code,
 * a login code, or the family picker off one of those. A hand-typed new racer
 * has no BMI id and is never asked about.
 *
 * Each BMI person is asked about ONCE per kiosk session (declines included),
 * so a "Not today" stays a "not today".
 */
export function useEmployeeRecognition(session: BookingSession, dispatch: Dispatch<Action>) {
  const { config } = useKioskConfig();
  const [pending, setPending] = useState<SessionEmployee | null>(null);
  const asked = useRef<Set<string>>(new Set());

  // A pending offer only counts while its member is still on the party — a
  // Start Over empties the party and the sheet goes with it, no state write.
  const visible = pending && session.party.some((m) => m.id === pending.memberId) ? pending : null;

  useEffect(() => {
    if (session.party.length === 0) asked.current.clear();
    if (session.employee || visible) return;
    const candidate = session.party.find(
      (m) => !!m.bmiPersonId && !asked.current.has(m.bmiPersonId),
    );
    if (!candidate?.bmiPersonId) return;
    asked.current.add(candidate.bmiPersonId);
    const kiosk = config
      ? {
          deviceKey: kioskDeviceKey(config),
          center: config.center === "naples" ? "naples" : config.brand,
          brand: config.brand,
        }
      : undefined;
    let cancelled = false;
    void employeeApi.recognize(toMatchable(candidate), kiosk).then((res) => {
      if (cancelled || !res.ok) return;
      clarityEvent("kiosk:team:recognized");
      setPending(res.employee);
    });
    return () => {
      cancelled = true;
    };
  }, [session.party, session.employee, visible, config]);

  const accept = () => {
    if (!pending) return;
    clarityEvent("kiosk:team:perks-on");
    dispatch({ type: "setEmployee", employee: pending });
    setPending(null);
  };
  const decline = () => {
    clarityEvent("kiosk:team:perks-declined");
    setPending(null);
  };

  return { pending: visible, accept, decline };
}

export function KioskEmployeeSheet({
  employee,
  onAccept,
  onDecline,
}: {
  employee: SessionEmployee | null;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const t = useT();
  if (!employee) return null;
  const free = freeRacesRemaining(employee);
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-[linear-gradient(180deg,rgba(0,4,24,0.2)_0%,rgba(0,4,24,0.92)_45%)] p-[40px]">
      <div className="k-glass w-full bg-[rgba(7,16,39,0.96)] p-[48px] pb-[40px]">
        <div className="flex items-center gap-[20px]">
          <span className="k-display inline-flex items-center gap-[10px] rounded-[12px] bg-[#46d68c] px-[14px] py-[8px] text-[22px] tracking-[0.12em] text-[#04250f]">
            {t("team.sheet.tag")}
          </span>
          <span className="text-[24px] text-white/55">{t("team.sheet.recognized")}</span>
        </div>
        <h2 className="k-display mt-[28px] text-[64px]">
          {t("team.sheet.title", { name: employee.firstName })}
        </h2>
        <div className="mt-[28px] grid grid-cols-3 gap-[16px]">
          <div className="flex flex-col gap-[6px] rounded-[20px] border border-[rgba(229,57,53,0.45)] bg-[rgba(229,57,53,0.12)] p-[22px_24px]">
            <div className="k-display text-[40px]">{t("team.sheet.free", { n: free })}</div>
            <div className="text-[22px] leading-[1.3] text-white/70">{t("team.sheet.freeSub")}</div>
          </div>
          <div className="flex flex-col gap-[6px] rounded-[20px] border border-[rgba(229,57,53,0.45)] bg-[rgba(229,57,53,0.12)] p-[22px_24px]">
            <div className="k-display text-[40px]">{t("team.sheet.half")}</div>
            <div className="text-[22px] leading-[1.3] text-white/70">{t("team.sheet.halfSub")}</div>
          </div>
          <div className="flex flex-col gap-[6px] rounded-[20px] border border-[rgba(0,226,229,0.4)] bg-[rgba(0,226,229,0.08)] p-[22px_24px]">
            <div className="k-display text-[40px]">{t("team.sheet.tokens")}</div>
            <div className="text-[22px] leading-[1.3] text-white/70">
              {t("team.sheet.tokensSub")}
            </div>
          </div>
        </div>
        <p className="mt-[28px] text-[24px] leading-[1.35] text-white/55">
          {t("team.sheet.ownItems")}
        </p>
        <div className="mt-[28px] flex gap-[24px]">
          <button type="button" onClick={onDecline} className="k-btn-ghost k-tap">
            {t("team.sheet.no")}
          </button>
          <button type="button" onClick={onAccept} className="k-btn-primary k-tap">
            {t("team.sheet.yes")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The green "perks on" bar on Review & Pay (the staff-mode bar pattern).
 * Remove = clear the session employee (the stamp goes with it).
 */
export function KioskEmployeeBar({
  employee,
  onRemove,
}: {
  employee: SessionEmployee | null | undefined;
  onRemove: () => void;
}) {
  const t = useT();
  if (!employee || !employee.memberId) return null;
  return (
    <div className="mx-[64px] mt-[24px] flex items-center gap-[20px] rounded-[22px] border-2 border-[#46d68c]/55 py-[18px] pl-[20px] pr-[24px]">
      <span className="k-display flex shrink-0 items-center gap-[10px] rounded-[12px] bg-[#46d68c] px-[14px] py-[8px] text-[22px] tracking-[0.12em] text-[#04250f]">
        {t("team.sheet.tag")}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[30px] font-bold leading-[1.1] text-white">
          {t("team.bar.on", { name: employee.firstName })}
        </div>
        <div className="mt-[2px] truncate text-[20px] text-white/55">
          {t("team.bar.detail", { n: freeRacesRemaining(employee) })}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="k-tap flex h-[72px] shrink-0 items-center gap-[10px] rounded-full border-2 border-white/20 px-[24px] font-heading text-[22px] font-bold uppercase tracking-[0.06em] text-white/75"
      >
        {t("team.bar.remove")}
      </button>
    </div>
  );
}
