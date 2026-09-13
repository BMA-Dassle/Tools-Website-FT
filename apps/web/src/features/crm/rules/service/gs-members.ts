/**
 * Who, in the Guest Services department, may work leads AS the Guest Services
 * bucket — PURE (owner decision 2026-09-13, brief §5.7b).
 *
 * THE TRAP THIS FILE EXISTS TO AVOID. 7shifts department `635186` ("Call
 * Center", HeadPinz Fort Myers) contains **eric@headpinz.com and
 * jacob@headpinz.com** — both directors with their own `crm_reps` rows — plus
 * `noreply@headpinz.com` ("Reporting User", a service account) in the sibling
 * FastTrax department, plus four personal-mail accounts that can never sign in
 * to Entra. Upserting the department's emails into `crm_rep_logins`, which is
 * the obvious implementation, would make BOTH DIRECTORS SIGN IN AS GUEST
 * SERVICES and lose their own rows.
 *
 * So department membership decides ONE thing only: shift coverage for the
 * bucket (`service/mirror.ts`). Sign-in mapping stays a deliberate act — the
 * director ticks "works leads as Guest Services" on the Rules screen, one
 * person at a time, and the toggle is defaulted OFF and disabled for anyone
 * who already has a rep row or is a service account. `classifyGsMembers` is
 * what the screen renders and `gsLoginRefusal` is the server-side guard that
 * enforces the same thing on the wire.
 */

import type { CrmRep } from "~/features/crm/core/types";
import type { GsMemberWire } from "../contracts";
import type { SevenShiftsUserRaw } from "./sevenshifts";

/** The bucket's `crm_reps.slug` (seeded by PR1). */
export const GS_SLUG = "gs";

/** Sign-in addresses live in this tenant; anything else can never reach the CRM. */
export const INTERNAL_EMAIL_DOMAIN = "headpinz.com";

/** Mailbox local-parts that are robots, not people. */
const SERVICE_LOCAL_PARTS = ["noreply", "no-reply", "donotreply", "do-not-reply", "reporting"];
/** Display names 7shifts uses for its own integrations. */
const SERVICE_NAMES = ["reporting user"];

export function memberName(u: Pick<SevenShiftsUserRaw, "first_name" | "last_name">): string {
  return `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return e.includes("@") ? e : null;
}

export function isServiceAccount(email: string | null, name: string): boolean {
  if (SERVICE_NAMES.includes(name.trim().toLowerCase())) return true;
  if (!email) return false;
  const local = email.split("@")[0] ?? "";
  return SERVICE_LOCAL_PARTS.includes(local);
}

export function isInternalEmail(email: string | null): boolean {
  return email !== null && email.endsWith(`@${INTERNAL_EMAIL_DOMAIN}`);
}

/** One department's users as the mirror/route collected them. */
export interface GsDepartmentUser extends SevenShiftsUserRaw {
  /** Which configured departments this user came back from. */
  departmentIds: number[];
}

export interface GsClassifyInput {
  users: readonly GsDepartmentUser[];
  /** Lowercased sign-in address → `crm_reps.id`: login rows AND each rep's own mailbox. */
  repIdByEmail: ReadonlyMap<string, string>;
  reps: readonly CrmRep[];
  /** `crm_reps.id` of the bucket, or null when the seed has not run. */
  gsRepId: string | null;
}

export const GS_BLOCK_NO_EMAIL = "no email in 7shifts";
export const GS_BLOCK_SERVICE = "service account";
export const GS_BLOCK_NO_BUCKET = "no Guest Services rep row";

/** "has their own rep row (Eric Osborn)" — why a director may not be ticked. */
export function ownRepBlock(displayName: string): string {
  return `has their own rep row (${displayName})`;
}

export function classifyGsMembers(input: GsClassifyInput): GsMemberWire[] {
  const repById = new Map(input.reps.map((r) => [r.id, r] as const));
  const out: GsMemberWire[] = input.users.map((u) => {
    const name = memberName(u) || `7shifts user ${u.id}`;
    const email = normalizeEmail(u.email);
    const mappedRepId = email ? (input.repIdByEmail.get(email) ?? null) : null;
    const worksAsGs = mappedRepId !== null && mappedRepId === input.gsRepId;
    const otherRep = mappedRepId && !worksAsGs ? (repById.get(mappedRepId) ?? null) : null;

    let blockedReason: string | null = null;
    if (!email) blockedReason = GS_BLOCK_NO_EMAIL;
    else if (isServiceAccount(email, name)) blockedReason = GS_BLOCK_SERVICE;
    else if (otherRep) blockedReason = ownRepBlock(otherRep.displayName);
    else if (!input.gsRepId) blockedReason = GS_BLOCK_NO_BUCKET;

    return {
      sevenShiftsUserId: u.id,
      name,
      email,
      departmentIds: [...u.departmentIds].sort((a, b) => a - b),
      worksAsGs,
      eligible: blockedReason === null,
      blockedReason,
      external: email !== null && !isInternalEmail(email),
      ownRep: otherRep ? { slug: otherRep.slug, displayName: otherRep.displayName } : null,
    };
  });
  return out.sort(
    (a, b) => a.name.localeCompare(b.name) || a.sevenShiftsUserId - b.sevenShiftsUserId,
  );
}

export const GS_REFUSE_UNKNOWN = "not_a_department_member";
export const GS_REFUSE_INELIGIBLE = "member_not_eligible";
export const GS_REFUSE_NOT_GS = "login_belongs_to_another_rep";

/**
 * The wire guard: a fixed code when this toggle must not be honoured, null when
 * it may. Turning a login ON needs an eligible member; turning one OFF is only
 * ever allowed to remove a row that points at the bucket — never to unmap a
 * director from their own record.
 */
export function gsLoginRefusal(member: GsMemberWire | undefined, works: boolean): string | null {
  if (!member) return GS_REFUSE_UNKNOWN;
  if (works) return member.eligible ? null : GS_REFUSE_INELIGIBLE;
  if (member.worksAsGs) return null;
  return member.ownRep ? GS_REFUSE_NOT_GS : null;
}

/** The department user ids whose shifts cover the bucket. */
export function gsUserIds(users: readonly GsDepartmentUser[]): Set<number> {
  return new Set(users.map((u) => u.id));
}
