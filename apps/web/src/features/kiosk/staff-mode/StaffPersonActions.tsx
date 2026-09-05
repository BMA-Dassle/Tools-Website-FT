"use client";

/**
 * `StaffPersonActions` — the staff chip row under a roster card. Renders ONLY
 * inside a `StaffModeSurface` while staff mode is armed; everywhere else it is
 * null, which is what lets shared roster code mount it unconditionally.
 *
 * Registry-driven: adding a fourth action is one entry in STAFF_ACTIONS plus a
 * sheet in StaffSheetHost. `enabled` says whether the action makes sense for
 * THIS person — a guest who has not finished sign-in has no BMI account yet, so
 * there is nothing to add a membership to and no history to read; the chips
 * stay visible but disabled, with the reason as the title.
 */
import { IconHistory, IconIdBadge2, IconTicket } from "@tabler/icons-react";
import type { ComponentType } from "react";
import type { PartyMember } from "~/features/booking";
import { openStaffSheet, useStaffMode } from "./store";
import { useStaffSurface } from "./StaffModeSurface";
import type { StaffSheetKind, StaffTarget } from "./types";

interface StaffActionDef {
  kind: StaffSheetKind;
  label: string;
  Icon: ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" }>;
}

export const STAFF_ACTIONS: readonly StaffActionDef[] = [
  { kind: "membership", label: "Membership", Icon: IconIdBadge2 },
  { kind: "comp", label: "Comp", Icon: IconTicket },
  { kind: "history", label: "Race history", Icon: IconHistory },
];

type Member = Pick<
  PartyMember,
  "id" | "firstName" | "lastName" | "bmiPersonId" | "pandoraPersonId" | "isMinor"
>;

export function targetFromMember(m: Member): StaffTarget | null {
  if (!m.bmiPersonId) return null;
  return {
    memberId: m.id,
    personId: m.bmiPersonId,
    ...(m.pandoraPersonId ? { pandoraPersonId: m.pandoraPersonId } : {}),
    name: `${m.firstName} ${m.lastName ?? ""}`.trim(),
    ...(m.isMinor ? { isMinor: true } : {}),
  };
}

export function StaffPersonActions({ member }: { member: Member }) {
  const surface = useStaffSurface();
  const { active } = useStaffMode();
  if (!surface || !active) return null;
  const target = targetFromMember(member);
  const disabledReason = target ? null : "Finish sign-in first — no account yet";
  return (
    <div className="mt-[18px] flex items-center gap-[12px] border-t border-dashed border-[#46d68c]/35 pt-[18px]">
      <span className="k-eyebrow mr-[6px] text-[18px] tracking-[0.24em] text-[#46d68c]">Staff</span>
      {STAFF_ACTIONS.map(({ kind, label, Icon }) => (
        <button
          key={kind}
          type="button"
          disabled={!target}
          title={disabledReason ?? undefined}
          onClick={() => target && openStaffSheet({ kind, target })}
          className="k-tap inline-flex h-[72px] items-center gap-[12px] rounded-[14px] border-2 border-[#46d68c]/50 bg-[#46d68c]/10 px-[24px] font-heading text-[24px] font-bold text-[#a6f0c8] disabled:opacity-45"
        >
          <Icon size={28} aria-hidden="true" />
          {label}
        </button>
      ))}
      {disabledReason && <span className="text-[20px] text-white/40">{disabledReason}</span>}
    </div>
  );
}
