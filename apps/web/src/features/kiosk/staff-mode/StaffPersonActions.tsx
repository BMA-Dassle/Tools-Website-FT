"use client";

/**
 * `StaffPersonActions` — the staff chip row under a roster card. Renders ONLY
 * inside a `StaffModeSurface` while staff mode is armed; everywhere else it is
 * null, which is what lets shared roster code mount it unconditionally.
 *
 * Registry-driven: adding a fourth action is one entry in STAFF_ACTIONS plus a
 * sheet in StaffSheetHost. Availability is decided by `staffActionEnabled`
 * (local-status.ts): a guest with no BMI account gets nothing; a guest whose
 * record has not reached the ON-SITE server yet gets Race history only — the
 * Membership / Comp writes land locally and would 404 (owner 2026-09-04:
 * "just disable the buttons if it's not local yet"). The hint says which, and
 * tapping it re-checks.
 */
import { IconHistory, IconIdBadge2, IconTicket } from "@tabler/icons-react";
import type { ComponentType } from "react";
import type { PartyMember } from "~/features/booking";
import {
  recheckPersonLocal,
  staffActionEnabled,
  staffActionHint,
  usePersonLocal,
} from "./local-status";
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
  const target = targetFromMember(member);
  // Probe the id we would WRITE with (service.server.ts writeId) — the short
  // Pandora id when the session has one, else the Office id.
  const probeId = target ? (target.pandoraPersonId ?? target.personId) : null;
  const status = usePersonLocal(
    surface?.location ?? "fasttrax",
    surface && active ? probeId : null,
  );
  if (!surface || !active) return null;
  const hint = staffActionHint(!!target, status);
  const canRecheck = !!probeId && (status === "not-local" || status === "unknown");
  return (
    <div className="mt-[18px] flex flex-wrap items-center gap-[12px] border-t border-dashed border-[#46d68c]/35 pt-[18px]">
      <span className="k-eyebrow mr-[6px] text-[18px] tracking-[0.24em] text-[#46d68c]">Staff</span>
      {STAFF_ACTIONS.map(({ kind, label, Icon }) => {
        const enabled = staffActionEnabled(kind, !!target, status);
        return (
          <button
            key={kind}
            type="button"
            disabled={!enabled}
            title={enabled ? undefined : (hint ?? undefined)}
            onClick={() => target && enabled && openStaffSheet({ kind, target })}
            className="k-tap inline-flex h-[72px] items-center gap-[12px] rounded-[14px] border-2 border-[#46d68c]/50 bg-[#46d68c]/10 px-[24px] font-heading text-[24px] font-bold text-[#a6f0c8] disabled:opacity-45"
          >
            <Icon size={28} aria-hidden="true" />
            {label}
          </button>
        );
      })}
      {hint &&
        (canRecheck ? (
          <button
            type="button"
            onClick={() => probeId && recheckPersonLocal(surface.location, probeId)}
            className="k-tap text-[20px] text-[#f5d38a] underline-offset-4 hover:underline"
          >
            {hint}
          </button>
        ) : (
          <span className="text-[20px] text-white/40">{hint}</span>
        ))}
    </div>
  );
}
