/**
 * The Guest Services card's server half: what `/api/admin/crm/rules/gs`
 * returns, and the two director actions behind it (§5.7b).
 *
 * DEGRADES HONESTLY. Without `SEVEN_SHIFTS_API_TOKEN` there is no member list
 * at all — the card says so and the off-today override still works. When
 * 7shifts refuses, `membersError` carries the reason instead of an empty list
 * pretending the department is empty.
 */

import { publicRep } from "~/features/crm/core/projections";
import type { CrmRep } from "~/features/crm/core/types";
import { listRepLogins, listReps, setRepLogin } from "~/features/crm/reps";
import type { GsMemberWire, GsResponse, SevenShiftsSetting } from "../contracts";
import { getSevenShiftsSetting, putSevenShiftsSetting } from "../data/sevenshifts-settings-db";
import {
  GS_SLUG,
  classifyGsMembers,
  gsLoginRefusal,
  normalizeEmail,
  type GsDepartmentUser,
} from "./gs-members";
import { SevenShiftsClient, type SevenShiftsUserRaw } from "./sevenshifts";

export type GsPayload = Omit<GsResponse, "ok">;

export interface GsDeps {
  listDepartmentUsers(departmentId: number): Promise<SevenShiftsUserRaw[]>;
  configured: boolean;
}

/** The real client; tests inject their own. */
export function liveGsDeps(): GsDeps {
  const client = new SevenShiftsClient();
  return {
    configured: client.configured,
    listDepartmentUsers: (departmentId) => client.listUsers({ departmentId }),
  };
}

/** Login rows first, then each rep's own mailbox — `findRepByLoginEmail`'s precedence. */
export async function repIdByEmail(reps: readonly CrmRep[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const r of reps) {
    const email = normalizeEmail(r.email);
    if (email) map.set(email, r.id);
  }
  for (const l of await listRepLogins()) map.set(l.email, l.repId);
  return map;
}

/** Every configured department's active users, de-duplicated by 7shifts user id. */
export async function loadDepartmentUsers(
  deps: GsDeps,
  departmentIds: readonly number[],
): Promise<{ users: GsDepartmentUser[]; error: string | null }> {
  const byId = new Map<number, GsDepartmentUser>();
  let error: string | null = null;
  for (const departmentId of departmentIds) {
    try {
      for (const u of await deps.listDepartmentUsers(departmentId)) {
        const hit = byId.get(u.id);
        if (hit) hit.departmentIds.push(departmentId);
        else byId.set(u.id, { ...u, departmentIds: [departmentId] });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error = error ? `${error} · ${message}` : message;
    }
  }
  return { users: [...byId.values()], error };
}

export async function loadGsPayload(deps: GsDeps): Promise<GsPayload> {
  const [setting, reps] = await Promise.all([getSevenShiftsSetting(), listReps()]);
  const gsRep = reps.find((r) => r.slug === GS_SLUG) ?? null;
  const byEmail = await repIdByEmail(reps);

  let members: GsMemberWire[] = [];
  let membersError: string | null = null;
  if (deps.configured && setting.gsDepartmentIds.length > 0) {
    const loaded = await loadDepartmentUsers(deps, setting.gsDepartmentIds);
    membersError = loaded.error;
    members = classifyGsMembers({
      users: loaded.users,
      repIdByEmail: byEmail,
      reps,
      gsRepId: gsRep?.id ?? null,
    });
  }

  return {
    setting,
    configured: deps.configured,
    gsRep: publicRep(gsRep),
    members,
    membersError,
  };
}

export async function setGsDepartments(input: {
  ids: number[];
  name?: string;
  actorEmail: string;
}): Promise<{ before: unknown; after: SevenShiftsSetting }> {
  const current = await getSevenShiftsSetting();
  const after: SevenShiftsSetting = {
    gsDepartmentIds: input.ids,
    gsDepartmentName: input.name?.trim() || current.gsDepartmentName,
  };
  const { before } = await putSevenShiftsSetting(after, input.actorEmail);
  return { before, after };
}

export interface GsLoginOutcome {
  /** A fixed refusal code, or null when the change was made. */
  refused: string | null;
  changed: boolean;
  member: GsMemberWire | null;
}

/**
 * Tick / untick "works leads as Guest Services" for ONE department member.
 * The member list is re-read from 7shifts so the guard runs against the same
 * facts the screen showed — a stale tick cannot map an address the department
 * no longer holds.
 */
export async function setGsLogin(
  deps: GsDeps,
  input: { email: string; works: boolean; actorEmail: string },
): Promise<GsLoginOutcome & { payload: GsPayload }> {
  const email = normalizeEmail(input.email);
  const payload = await loadGsPayload(deps);
  const member = (email ? payload.members.find((m) => m.email === email) : undefined) ?? undefined;
  const refused = gsLoginRefusal(member, input.works);
  if (refused || !email || !member) {
    return { refused: refused ?? "member_not_eligible", changed: false, member: null, payload };
  }
  const changed = await setRepLogin(email, input.works ? GS_SLUG : null);
  return { refused: null, changed, member, payload: await loadGsPayload(deps) };
}
