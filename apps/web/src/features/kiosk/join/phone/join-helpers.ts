/**
 * Pure helpers for the phone join page. The DOB/phone formatting is a
 * DELIBERATE ~20-line duplication of KioskPeopleStep's module-privates —
 * extracting them would touch the multi-writer-hot kiosk monolith for zero
 * behavior gain (the file's own comments warn against it).
 */
import type { CloseReason, JoinBrand, JoinCenter, JoinGuestPayload, JoinStepKind } from "../types";

export interface JoinMetaOpen {
  status: "open";
  center: JoinCenter;
  brand: JoinBrand;
  stepKind: JoinStepKind;
  splitPaymentAvailable: false;
}
export interface JoinMetaClosed {
  status: "closed";
  closeReason?: CloseReason;
  center: JoinCenter;
  brand: JoinBrand;
}
export type JoinMeta = JoinMetaOpen | JoinMetaClosed;

/** Why the flow ended — each renders a distinct full-screen message. */
export type EndedReason = "invalid" | "moved-on" | "cancelled" | "expired";

/** Map a closed session's reason to the guest-facing end state. Null = still
 *  open. (A null META is NOT an end state — it means "not resolved yet"; the
 *  client's first poll decides via 404 vs payload.) */
export function endedFromMeta(meta: JoinMeta): EndedReason | null {
  if (meta.status === "open") return null;
  switch (meta.closeReason) {
    case "continued":
    case "done":
      return "moved-on"; // the kiosk moved past the player list
    case "start-over":
    case "idle":
      return "cancelled"; // the kiosk session itself was reset
    default:
      return "expired"; // superseded / expired / unknown
  }
}

/** MM/DD/YYYY typing helper — auto-slashes as digits are typed. */
export function formatDobInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

/** (xxx) xxx-xxxx live formatting, incl. the browser-autofill "+1" strip. */
export function formatPhoneInput(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** Age from MM/DD/YYYY. Null for malformed, impossible (02/30), or
 *  implausible (<0 or ≥120) dates — stricter than the kiosk's rollover-
 *  tolerant version because this feeds a hard 18+ gate. */
export function ageFromDob(mmddyyyy: string): number | null {
  const m = mmddyyyy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  const y = Number(m[3]);
  const dob = new Date(y, mo - 1, d);
  if (
    Number.isNaN(dob.getTime()) ||
    dob.getFullYear() !== y ||
    dob.getMonth() !== mo - 1 ||
    dob.getDate() !== d
  ) {
    return null;
  }
  const now = new Date();
  let age = now.getFullYear() - y;
  const beforeBirthday =
    now.getMonth() < dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

export function toIsoDob(mmddyyyy: string): string {
  const m = mmddyyyy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : mmddyyyy;
}

/** "YYYY-MM-DD…" (incl. datetime strings) → age in years, null if unusable. */
export function ageFromIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return null;
  return ageFromDob(`${m[2]}/${m[3]}/${m[1]}`);
}

/** Everything both identity paths accumulate before submit. Person ids stay
 *  digit STRINGS end-to-end (17-digit Office ids must never see Number()). */
export interface DraftGuest {
  firstName: string;
  lastName?: string;
  bmiPersonId?: string;
  pandoraPersonId?: string;
  dobIso: string;
  phone?: string;
  email?: string;
  memberships?: string[];
  creditBalances?: Array<{ kind: string; balance: number }>;
  isNewRacer: boolean;
}

/** The POST body's guest — waiver is always signed by the time we submit. */
export function buildGuestPayload(draft: DraftGuest): JoinGuestPayload {
  return {
    firstName: draft.firstName,
    ...(draft.lastName ? { lastName: draft.lastName } : {}),
    ...(draft.bmiPersonId ? { bmiPersonId: draft.bmiPersonId } : {}),
    ...(draft.pandoraPersonId ? { pandoraPersonId: draft.pandoraPersonId } : {}),
    isNewRacer: draft.isNewRacer,
    category: "adult",
    ...(draft.memberships && draft.memberships.length ? { memberships: draft.memberships } : {}),
    waiverValid: true,
    ...(draft.creditBalances && draft.creditBalances.length
      ? { creditBalances: draft.creditBalances }
      : {}),
    ...(draft.phone ? { phone: draft.phone } : {}),
    ...(draft.email ? { email: draft.email } : {}),
    dobIso: draft.dobIso,
  };
}

/** Guest-facing venue name — strings match PANDORA_CENTER_NAMES. */
export function centerDisplayName(center: JoinCenter, brand: JoinBrand): string {
  if (center === "naples") return "HeadPinz Naples";
  return brand === "headpinz" ? "HeadPinz Fort Myers" : "FastTrax Fort Myers";
}

/** The Pandora location key the WAIVER path uses — brand-only, mirroring
 *  KioskPeopleStep's brandLocation (the kiosk signs Naples waivers against
 *  the headpinz key today; if that ever goes center-aware, change BOTH). */
export function brandLocationFor(brand: JoinBrand): "headpinz" | "fasttrax" {
  return brand === "headpinz" ? "headpinz" : "fasttrax";
}
