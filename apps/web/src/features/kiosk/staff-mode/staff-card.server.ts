import "server-only";
import { PANDORA_LOCATION_MAP } from "@/lib/pandora-locations";
import { lookupPersonByCard, OfficeApiError } from "../license/lookup.server";
import { cardTail } from "./staff-card";
import type { StaffEmployee, StaffLocation } from "./types";

/**
 * Card → employee, in two steps (owner contract 2026-09-04):
 *
 *   1. OFFICE — who holds this card? `lookupPersonByCard` (the Office token
 *      search, confirmed against the person's tags). No person → `not-linked`.
 *      Staff are checked FIRST on every card scan — "Intercard you will check
 *      for staff first as that's priority" — which is why this runs off the
 *      unrecognised-scan path before anything guest-shaped happens.
 *
 *   2. PANDORA — is that person STAFF, and what are they?
 *        GET {PANDORA_STAFF_ROLES_URL}  e.g. …/v2/bmi/staff-roles/{location}/{personId}
 *        → { success, data: { personID, firstName, lastName, isStaff, userID,
 *             username, userBlocked, groups: [{id,name}], teams: [{id,name,roleID,role}] } }
 *      `isStaff: false`, `userBlocked: true`, or no such person → `not-linked`.
 *      MANAGERS ONLY (owner 2026-09-04: "any role with 'Manager' is valid for
 *      opening this menu"): a group whose name contains "Manager" is required;
 *      staff without one → `not-manager`, and the kiosk says so by name. The
 *      display role is the matching Manager group.
 *
 * URL: `https://bma-pandora-api.azurewebsites.net/v2/bmi/staff-roles/{location}/{personId}`
 * — the SAME `/v2/bmi/*` base every other Pandora call here uses. Measured live
 * 2026-09-04 with curl: `/v2/bmi/staff-roles/LAB52GY480CJF/63000000000021716`
 * → 200 `{isStaff:true, groups:[…Manager…]}` and the sample id 465243 → 200
 * (Stephanie, byte-identical to the owner's paste), while
 * `/api/v2/bmi/staff-roles/…` → the Express "Cannot GET" 404 for BOTH ids. The
 * `/api/v2` prefix in the sample belongs to a different host; on this one it
 * does not exist, and the first live scan failed on exactly that. The route
 * also accepts the 17-digit cloud person id (the Office search returns it for
 * cloud-minted records). `PANDORA_STAFF_ROLES_URL` overrides the template if
 * the host ever moves. Auth: SWAGGER_ADMIN_KEY (the same key).
 *
 * Fail closed throughout: any error → no staff mode, with a reason the kiosk
 * turns into one honest line.
 */

export type StaffCardResolution =
  | { linked: true; employee: StaffEmployee }
  | { linked: false; reason: "not-linked" | "unconfigured" | "error" }
  /** Staff, but no Manager group — named so the notice can say who. */
  | { linked: false; reason: "not-manager"; name: string };

const DEFAULT_STAFF_ROLES_URL =
  "https://bma-pandora-api.azurewebsites.net/v2/bmi/staff-roles/{location}/{personId}";

/** The gate: any group whose name contains "Manager" (case-insensitive). */
export function isManagerGroup(name: string): boolean {
  return /manager/i.test(name);
}

export interface StaffRolesPayload {
  personID?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  isStaff?: unknown;
  userID?: unknown;
  username?: unknown;
  userBlocked?: unknown;
  groups?: Array<{ id?: unknown; name?: unknown }>;
  teams?: Array<{ id?: unknown; name?: unknown; roleID?: unknown; role?: unknown }>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

export type StaffRolesVerdict =
  | { kind: "manager"; employee: StaffEmployee }
  | { kind: "not-manager"; name: string }
  | { kind: "not-staff" };

/** PURE: what an Office hit + a staff-roles payload say about this person. */
export function verdictFromStaffRoles(
  person: { personId: string; firstName: string; lastName: string },
  payload: unknown,
  account: string,
): StaffRolesVerdict {
  if (!payload || typeof payload !== "object") return { kind: "not-staff" };
  const root = payload as { success?: unknown; data?: unknown };
  if (root.success === false) return { kind: "not-staff" };
  const data = (root.data && typeof root.data === "object" ? root.data : root) as StaffRolesPayload;
  if (data.isStaff !== true) return { kind: "not-staff" };
  if (data.userBlocked === true) return { kind: "not-staff" };
  const first = str(data.firstName) || person.firstName;
  const last = str(data.lastName) || person.lastName;
  const name = `${first} ${last}`.trim() || str(data.username) || "Staff";
  const groups = Array.isArray(data.groups)
    ? data.groups.map((g) => str(g?.name)).filter(Boolean)
    : [];
  const role = groups.find(isManagerGroup);
  if (!role) return { kind: "not-manager", name };
  return {
    kind: "manager",
    employee: {
      id: str(data.personID) || person.personId,
      name,
      cardTail: cardTail(account),
      role,
    },
  };
}

async function fetchStaffRoles(
  location: StaffLocation,
  personId: string,
): Promise<{ ok: true; payload: unknown } | { ok: false; status: number }> {
  const template = process.env.PANDORA_STAFF_ROLES_URL || DEFAULT_STAFF_ROLES_URL;
  const url = template
    .replace("{location}", encodeURIComponent(PANDORA_LOCATION_MAP[location]))
    .replace("{personId}", encodeURIComponent(personId));
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}`,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status !== 404) {
      console.warn(`[staff-card] staff-roles HTTP ${res.status}: ${text.slice(0, 160)}`);
    }
    return { ok: false, status: res.status };
  }
  try {
    return { ok: true, payload: JSON.parse(text) };
  } catch {
    return { ok: false, status: res.status };
  }
}

export async function resolveStaffCard(
  account: string,
  location: StaffLocation,
): Promise<StaffCardResolution> {
  if (!process.env.SWAGGER_ADMIN_KEY) return { linked: false, reason: "unconfigured" };

  // 1. Office: whose card is this?
  let person: Awaited<ReturnType<typeof lookupPersonByCard>>;
  try {
    person = await lookupPersonByCard(account, location);
  } catch (err) {
    if (err instanceof OfficeApiError) {
      console.warn(`[staff-card] Office card search unavailable: ${err.message}`);
      return { linked: false, reason: "error" };
    }
    throw err;
  }
  if (!person) return { linked: false, reason: "not-linked" };

  // 2. Pandora: are they staff?
  try {
    const roles = await fetchStaffRoles(location, person.personId);
    if (!roles.ok) {
      return { linked: false, reason: roles.status === 404 ? "not-linked" : "error" };
    }
    const verdict = verdictFromStaffRoles(person, roles.payload, account);
    if (verdict.kind === "manager") return { linked: true, employee: verdict.employee };
    if (verdict.kind === "not-manager") {
      return { linked: false, reason: "not-manager", name: verdict.name };
    }
    return { linked: false, reason: "not-linked" };
  } catch (err) {
    console.warn(`[staff-card] staff-roles failed: ${err instanceof Error ? err.message : err}`);
    return { linked: false, reason: "error" };
  }
}
