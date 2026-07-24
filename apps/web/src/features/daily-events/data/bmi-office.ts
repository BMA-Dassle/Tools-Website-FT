import { randomUUID } from "crypto";
import redis from "@/lib/redis";
import { parseWithRawIds, BMI_ID_FIELDS } from "@ft/db";
import {
  SMS_TIMING_BASE_URL,
  SMS_HEADERS,
  RESOURCE_NAMES,
  KIND_NAMES,
  USER_NAMES,
  PAY_METHOD_NAMES,
  RESOURCE_IDS,
  SMS_TIMING_RESOURCE_MAPPINGS,
  SHARED_FM_LOCATIONS,
  BUILTIN_PROJECT_STATES,
} from "../constants";
import type { MetadataLookups, LiveReservation } from "../types";

/**
 * SMS-Timing Office API client for the daily-events feature — a verbatim port
 * of the employee portal's api/lib/sms-timing.ts call patterns (same endpoints,
 * params, sequencing, cache keys and TTLs), with ONE hardening change that does
 * not alter any request: every response is parsed with parseWithRawIds so
 * 17-digit BMI ids survive as strings (the portal used plain JSON parsing —
 * a latent precision bug we must not copy; see tasks/lessons.md § BMI ID
 * Precision).
 *
 * Do NOT reuse lib/bmi-office-actions.ts fetchProject/fetchPersonsByIds here —
 * they parse with JSON.parse.
 */

// Same env + baked defaults as lib/bmi-office-actions.ts (proven in prod).
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const SMS_VERSION = "6251006 202511051229";

/**
 * Id fields quoted on parse. Superset of BMI_ID_FIELDS: the small reference
 * ids are quoted too for uniform string typing (harmless — every read site
 * String()-coerces exactly like the portal did). Any object PUT back to the
 * Office API must be serialized with this SAME list (serializeWithRawIds) so
 * the body is byte-faithful to what the GET returned.
 */
export const OFFICE_ID_FIELDS = [
  ...BMI_ID_FIELDS,
  "resourceId",
  "stateId",
  "kindId",
  "userId",
  "payMethodId",
  "productId",
  "contactPersonId",
  // search/person hits carry the person id as `localId` (17-digit) — quoted so
  // the kiosk license lookup can feed it straight into person fetches.
  "localId",
] as const;

export class OfficeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ── Redis cache wrappers (non-fatal on Redis outage, portal parity) ──

async function cacheGet(key: string): Promise<string | null> {
  try {
    return await redis.get(key);
  } catch {
    return null;
  }
}

async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    await redis.setex(key, ttlSeconds, value);
  } catch {
    // non-fatal — next call fetches fresh
  }
}

// ── Auth (portal getToken: password grant, Redis-cached 23h) ─────────

export async function getOfficeToken(clientKey: string): Promise<string> {
  const cacheKey = `sms-timing-token:${clientKey}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const password = OFFICE_PASS_B64 ? Buffer.from(OFFICE_PASS_B64, "base64").toString() : "";
  const res = await fetch(`${SMS_TIMING_BASE_URL}/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: clientKey,
      "x-fast-version": SMS_VERSION,
      ...SMS_HEADERS,
    },
    body: `grant_type=password&username=${encodeURIComponent(OFFICE_USER)}&password=${encodeURIComponent(password)}`,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new OfficeApiError(res.status, `Office auth failed: ${res.status}`);
  const data = JSON.parse(await res.text()) as { access_token: string };

  await cacheSet(cacheKey, data.access_token, 82800);
  return data.access_token;
}

// ── HTTP helpers (portal apiGet/apiPost/apiPut, precision-safe parse) ─

function apiHeaders(token: string, clientKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    clientkey: clientKey,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    ...SMS_HEADERS,
  };
}

async function officeFetch<T>(
  clientKey: string,
  endpoint: string,
  init?: { method?: string; body?: string },
): Promise<T> {
  const token = await getOfficeToken(clientKey);
  const res = await fetch(`${SMS_TIMING_BASE_URL}/api/${clientKey}/${endpoint}`, {
    method: init?.method || "GET",
    headers: apiHeaders(token, clientKey),
    body: init?.body,
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new OfficeApiError(
      res.status,
      `Office ${init?.method || "GET"} ${endpoint} failed: ${res.status} ${text.slice(0, 300)}`,
    );
  }
  return parseWithRawIds<T>(text, OFFICE_ID_FIELDS);
}

export function officeGet<T>(clientKey: string, endpoint: string): Promise<T> {
  return officeFetch<T>(clientKey, endpoint);
}

/** body must be pre-serialized (serializeWithRawIds / raw-id-safe string). */
export function officePost<T>(clientKey: string, endpoint: string, body: string): Promise<T> {
  return officeFetch<T>(clientKey, endpoint, { method: "POST", body });
}

/** body must be pre-serialized (serializeWithRawIds / raw-id-safe string). */
export function officePut<T>(clientKey: string, endpoint: string, body: string): Promise<T> {
  return officeFetch<T>(clientKey, endpoint, { method: "PUT", body });
}

// ── Metadata lookups (portal getMetadata: ~550KB blob, Redis 2h) ─────

interface MetadataNamed {
  id?: unknown;
  resourceId?: unknown;
  productId?: unknown;
  payMethodId?: unknown;
  stateId?: unknown;
  kindId?: unknown;
  userId?: unknown;
  name?: string;
  productName?: string;
  displayName?: string;
  shortName?: string;
  label?: string;
  firstName?: string;
  lastName?: string;
  children?: MetadataNamed[];
  subResources?: MetadataNamed[];
}

interface MetadataBlob {
  resources?: MetadataNamed[];
  subResources?: MetadataNamed[];
  resourceGroups?: MetadataNamed[];
  allResources?: MetadataNamed[];
  products?: MetadataNamed[];
  payMethods?: MetadataNamed[];
  states?: MetadataNamed[];
  projectStates?: MetadataNamed[];
  stateTypes?: MetadataNamed[];
  kinds?: MetadataNamed[];
  projectKinds?: MetadataNamed[];
  kindTypes?: MetadataNamed[];
  users?: MetadataNamed[];
  teamMembers?: MetadataNamed[];
}

export async function getMetadataLookups(clientKey: string): Promise<MetadataLookups> {
  const cacheKey = `sms-timing-metadata:${clientKey}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    try {
      const parsed: MetadataLookups = JSON.parse(cached);
      // Always merge in current hardcoded names (portal parity)
      for (const [id, name] of Object.entries(RESOURCE_NAMES)) {
        if (!parsed.resourceNames[id] || parsed.resourceNames[id].startsWith("Resource ")) {
          parsed.resourceNames[id] = name;
        }
      }
      for (const [id, name] of Object.entries(USER_NAMES)) {
        if (!parsed.userNames[id]) {
          parsed.userNames[id] = name;
        }
      }
      return parsed;
    } catch {
      /* re-fetch */
    }
  }

  const data = await officeGet<MetadataBlob>(clientKey, "metadata");

  const resourceNames: Record<string, string> = { ...RESOURCE_NAMES };
  for (const arr of [data.resources, data.subResources, data.resourceGroups, data.allResources]) {
    if (Array.isArray(arr)) {
      for (const r of arr) {
        const id = String(r.id || r.resourceId);
        if (!resourceNames[id]) {
          resourceNames[id] = r.name || r.displayName || r.shortName || `Resource ${id}`;
        }
      }
    }
  }
  for (const r of data.resources || []) {
    const id = String(r.id || r.resourceId);
    resourceNames[id] =
      r.name || r.displayName || r.shortName || resourceNames[id] || `Resource ${id}`;
    if (Array.isArray(r.children)) {
      for (const child of r.children) {
        const cid = String(child.id || child.resourceId);
        if (!resourceNames[cid]) {
          resourceNames[cid] =
            child.name || child.displayName || child.shortName || `Resource ${cid}`;
        }
      }
    }
    if (Array.isArray(r.subResources)) {
      for (const sub of r.subResources) {
        const sid = String(sub.id || sub.resourceId);
        if (!resourceNames[sid]) {
          resourceNames[sid] = sub.name || sub.displayName || sub.shortName || `Resource ${sid}`;
        }
      }
    }
  }

  const productNames: Record<string, string> = {};
  for (const p of data.products || []) {
    const id = String(p.id || p.productId);
    productNames[id] = p.name || p.productName || p.displayName || `Product ${id}`;
  }

  const payMethodNames: Record<string, string> = { ...PAY_METHOD_NAMES };
  for (const pm of data.payMethods || []) {
    const id = String(pm.id || pm.payMethodId);
    payMethodNames[id] = pm.name || pm.displayName || payMethodNames[id] || `Method ${id}`;
  }

  const stateNames: Record<string, string> = {};
  for (const arr of [data.states, data.projectStates, data.stateTypes]) {
    if (Array.isArray(arr)) {
      for (const s of arr) {
        const id = String(s.id || s.stateId);
        stateNames[id] = s.name || s.displayName || s.label || `State ${id}`;
      }
    }
  }

  const kindNames: Record<string, string> = { ...KIND_NAMES };
  for (const arr of [data.kinds, data.projectKinds, data.kindTypes]) {
    if (Array.isArray(arr)) {
      for (const k of arr) {
        const id = String(k.id || k.kindId);
        kindNames[id] = k.name || k.displayName || k.label || kindNames[id] || `Kind ${id}`;
      }
    }
  }

  const userNames: Record<string, string> = { ...USER_NAMES };
  for (const arr of [data.users, data.teamMembers]) {
    if (Array.isArray(arr)) {
      for (const u of arr) {
        const id = String(u.id || u.userId);
        const name = u.name || u.displayName || `${u.firstName || ""} ${u.lastName || ""}`.trim();
        if (name) userNames[id] = name;
      }
    }
  }

  const result: MetadataLookups = {
    resourceNames,
    productNames,
    payMethodNames,
    stateNames,
    kindNames,
    userNames,
  };

  await cacheSet(cacheKey, JSON.stringify(result), 7200);
  return result;
}

// ── Live reservations (portal getLiveReservations, verbatim) ─────────

export async function getLiveReservations(
  clientKey: string,
  date: string,
  meta: MetadataLookups,
): Promise<LiveReservation[]> {
  const dateObj = new Date(`${date}T00:00:00`);
  const nextDate = new Date(dateObj);
  nextDate.setDate(nextDate.getDate() + 1);
  const from = `${date}T06:00:00`;
  const until = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}-${String(nextDate.getDate()).padStart(2, "0")}T06:00:00`;

  // Built-in state IDs plus ONLY positive custom state ids from metadata —
  // generic negative ids (-1, -100, …) cause 400s (portal parity).
  const customStateIds = Object.keys(meta.stateNames).filter((id) => Number(id) > 0);
  const allStateIds = [...new Set([...BUILTIN_PROJECT_STATES, ...customStateIds])];
  const stateParams = allStateIds.map((id) => `projectStates=${id}`).join("&");

  try {
    const data = await officeGet<LiveReservation[]>(
      clientKey,
      `liveReservations?from=${from}&until=${until}&${stateParams}&onlyCurrentUser=false`,
    );
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(
      `[daily-events] liveReservations failed for ${clientKey}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

// ── Resource mapping (portal getResourceIdsForLocation) ──────────────
//
// The portal read the shared-FM split from its DB; the website carries the
// exported row in constants (SMS_TIMING_RESOURCE_MAPPINGS). Logic otherwise
// verbatim: non-shared servers use the curated list, shared FM filters the
// mapping by location, curated list as last resort.

export async function getResourceIdsForLocation(
  clientKey: string,
  locationId: number,
): Promise<string[]> {
  if (!SHARED_FM_LOCATIONS.includes(locationId)) {
    const curated = RESOURCE_IDS[clientKey];
    if (curated && curated.length > 0) return curated;
    const meta = await getMetadataLookups(clientKey);
    const allMetaIds = Object.keys(meta.resourceNames);
    return allMetaIds.length > 0 ? allMetaIds : [];
  }

  const mapped = Object.entries(SMS_TIMING_RESOURCE_MAPPINGS)
    .filter(([, locIds]) => locIds.includes(locationId))
    .map(([resId]) => resId);
  if (mapped.length > 0) return mapped;

  return RESOURCE_IDS[clientKey] || [];
}

// ── Raw project / person fetches (ids preserved as strings) ──────────

export function fetchProjectRaw<T = Record<string, unknown>>(
  clientKey: string,
  projectId: string,
): Promise<T> {
  return officeGet<T>(clientKey, `project/${projectId}`);
}

const DIGIT_ID = /^-?\d+$/;

/**
 * POST personprofile/personsByIds with a bare JSON array of NUMERIC id
 * tokens — byte-identical to the portal's working request. The ids are
 * digit strings (from parseWithRawIds); string-injection keeps 17-digit
 * precision without a Number() roundtrip.
 */
export function fetchPersonProfiles<T = Record<string, unknown>[]>(
  clientKey: string,
  personIds: string[],
): Promise<T> {
  for (const id of personIds) {
    if (!DIGIT_ID.test(id)) {
      throw new Error(`fetchPersonProfiles: invalid personId ${JSON.stringify(id)}`);
    }
  }
  return officePost<T>(clientKey, "personprofile/personsByIds", `[${personIds.join(",")}]`);
}

export function fetchPersonRaw<T = Record<string, unknown>>(
  clientKey: string,
  personId: string,
): Promise<T> {
  return officeGet<T>(clientKey, `person/${personId}`);
}
