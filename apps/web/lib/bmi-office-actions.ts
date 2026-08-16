import https from "https";
import { randomUUID } from "crypto";
import { parseWithRawIds } from "@ft/db";

/**
 * BMI Office write actions — update project status + record payment.
 *
 * Called after deposit is paid to:
 * 1. Change project stateId to Confirmation (-3) or Confirmation+Waiver (1191926)
 * 2. Record the deposit payment via projectPayment
 *
 * Also provides batch person lookup via personsByIds.
 */

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const OFFICE_PASS = Buffer.from(OFFICE_PASS_B64, "base64").toString();
const SMS_VERSION = "6251006 202511051229";

const PAY_METHOD_IDS: Record<string, string> = {
  headpinzftmyers: "393797",
  headpinznaples: "39843",
};

const CLIENT_KEYS: Record<string, string> = {
  "fort-myers": "headpinzftmyers",
  fasttrax: "headpinzftmyers",
  naples: "headpinznaples",
};

const WAIVER_STATE_IDS: Record<string, string> = {
  headpinzftmyers: "3274635",
  headpinznaples: "1191926",
};

const WAIVER_ACTIVITIES = [
  "laser tag",
  "gel blaster",
  "racing",
  "race",
  "nexus",
  "kart",
  "vip birthday",
];

let cachedToken: string | null = null;
let tokenExpiry = 0;
let tokenClientKey = "";

function httpsRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: OFFICE_HOST,
      path,
      method,
      headers: { ...headers, "Content-Type": "application/json" },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function getOfficeToken(clientKey: string): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000 && tokenClientKey === clientKey)
    return cachedToken;
  const postBody = `grant_type=password&username=${OFFICE_USER}&password=${OFFICE_PASS}`;
  const res = await httpsRequest(
    "POST",
    "/auth/token",
    {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: clientKey,
      "x-fast-version": SMS_VERSION,
    },
    postBody,
  );
  if (res.status !== 200) throw new Error(`Office auth failed: ${res.status}`);
  const data = JSON.parse(res.body);
  cachedToken = data.access_token;
  tokenClientKey = clientKey;
  tokenExpiry = Date.now() + parseInt(data.expires_in || "86400", 10) * 1000;
  return cachedToken!;
}

function apiHeaders(token: string, clientKey: string) {
  return {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    clientkey: clientKey,
  };
}

// ── Minimal project payload ─────────────────────────────────────────
//
// Field-for-field the payload the Office UI's own "Save project" button sends
// (HAR-captured from office.bmileisure.com). Deliberately omits `schedules`,
// `products`, `projectPersons` and `logs` so a state/name write can never
// rewrite the booking itself.
//
// It does NOT dodge validation — an earlier comment here claimed it "avoids
// overbooking validation on PUT" and that is false: the 2026-08-12 HAR shows
// this exact payload drawing the overbook question (see putProject below).

const PROJECT_CORE_FIELDS = [
  "balance",
  "confirm",
  "invoiceId",
  "partyInfo",
  "projectReference",
  "name",
  "number",
  "displayName",
  "personId",
  "persons",
  "created",
  "updated",
  "date",
  "validityDate",
  "publish",
  "companyId",
  "styleId",
  "stateId",
  "kindId",
  "priority",
  "reservationId",
  "userCreatedId",
  "userUpdatedId",
  "userId",
  "userAgentId",
  "userExternalId",
  "resellerId",
  "id",
] as const;

function toMinimalProject(
  project: Record<string, unknown>,
  extraFields?: string[],
): Record<string, unknown> {
  const minimal: Record<string, unknown> = {};
  for (const key of PROJECT_CORE_FIELDS) {
    if (key in project) minimal[key] = project[key];
  }
  if (extraFields) {
    for (const key of extraFields) {
      if (key in project) minimal[key] = project[key];
    }
  }
  return minimal;
}

// ── PUT /project — answering BMI's confirmation questions ───────────

/**
 * A BMI Office **soft refusal** — a 403 that `confirm:true` overrides.
 *
 * When a project PUT would break a capacity rule, Office replies 403 with an
 * envelope, and WHICH envelope depends on whether the calling login is allowed
 * to be asked. Both were measured on the same record (project 58454076,
 * 2026-08-12), and both are overridden by the same flag:
 *
 *   staff login (may overbook) — a QUESTION:
 *     {"IsQuestion":true,"Kind":4,"OperationId":"24f4…",
 *      "Message":"Total persons (12) is higher than the capacity (0) in HP Arena:
 *                 8/15/2026 6:30:00 PM - 8/15/2026 6:45:00 PM. \n Do you want to overbook?"}
 *
 *   our API2 service account (never asked) — a flat REFUSAL:
 *     {"IsQuestion":false,"Kind":4,"OperationId":"8389…",
 *      "Message":"Total persons (12) is higher than the capacity (0) in HP Arena:
 *                 8/15/2026 6:30:00 PM - 8/15/2026 6:45:00 PM, overbooking is not allowed."}
 *
 * "Overbooking is not allowed" reads final and is not: re-sending the identical
 * body with `confirm:true` returns 200 on that same account. The account CAN
 * overbook; it simply is not offered the dialog. So `IsQuestion` is NOT the test
 * — the presence of this envelope is. A genuine 403 (bad token, no permission)
 * is not JSON in this shape.
 */
export interface OfficePrompt {
  IsQuestion?: boolean;
  Kind?: number;
  Message?: string;
  OperationId?: string;
}

/**
 * Decode the soft-refusal envelope out of a 403, or null if it is a real failure.
 * Pure — exported so the other Office transport (lib/bmi-attraction-cancel.ts,
 * which carries its own https plumbing) recognises one the same way.
 */
export function officePromptFrom(status: number, body: string): OfficePrompt | null {
  if (status !== 403 || !body) return null;
  try {
    const parsed = JSON.parse(body) as OfficePrompt;
    if (!parsed || typeof parsed !== "object") return null;
    // The envelope always carries a Message plus at least one of its two markers.
    const hasMarker = "IsQuestion" in parsed || "OperationId" in parsed;
    return typeof parsed.Message === "string" && hasMarker ? parsed : null;
  } catch {
    return null;
  }
}

/** Collapse a prompt's message to one log-safe line (it carries a literal \n). */
export function officePromptLine(p: OfficePrompt): string {
  return `kind ${p.Kind ?? "?"}${p.IsQuestion ? " (question)" : ""}: ${(p.Message ?? "").replace(/\s+/g, " ").trim()}`;
}

/**
 * PUT a project, confirming through any soft refusal BMI raises.
 *
 * WHY. Office answers an over-capacity save with 403 + the prompt envelope above,
 * and every caller here treated `status >= 400` as a hard error. So a group
 * function whose resources are overbooked could not have its state moved AT ALL:
 * the send-contract rail's `setProjectState` threw, `leaveSendContract` returned
 * false, and the contract was never sent — re-attempted every 2-minute pass,
 * forever, until sales gave up and moved the project by hand (which takes it out
 * of "Send Contract" and strands it: the cron never scans it again).
 *
 * Owner decision 2026-08-12: confirm. Overbooking is a judgement the sales desk
 * already made when they built the event; a state write is not the place to
 * re-litigate it. Note this needs NO account-level "allow overbooking" setting —
 * the flag alone is sufficient, verified live on API2.
 *
 * HOW. Re-send the IDENTICAL body with `confirm: true` — that is the entire
 * protocol. Measured against the Office UI's own retry (HAR 2026-08-12, project
 * 58454076): the two request bodies differ at exactly one byte,
 * `"confirm":false` → `"confirm":true`. The `OperationId` is never echoed back,
 * no header changes and no query param is added. Reusing the caller's `headers`
 * object keeps the same `x-session-id` across both calls, as the UI does.
 *
 * Confirming EVERY prompt rather than pattern-matching "overbook" is deliberate:
 * this payload carries no schedules, products or people, so a confirm cannot
 * create a conflict that is not already saved on the record — while a prompt we
 * failed to recognise would reproduce the exact silent stall being fixed here.
 * Each one is logged with its kind and text, so an unfamiliar prompt shows up in
 * the run log rather than being waved through in the dark.
 *
 * Exactly ONE retry: `confirm` is already true on it, so a repeat would refuse
 * identically forever.
 */
async function putProject(
  clientKey: string,
  headers: Record<string, string>,
  project: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const path = `/api/${clientKey}/project`;
  const first = await httpsRequest("PUT", path, headers, JSON.stringify(project));
  const prompt = officePromptFrom(first.status, first.body);
  if (!prompt) return first;

  console.log(
    `[bmi-office] project ${project.id ?? "?"} PUT refused softly — retrying with confirm:true ` +
      `(${officePromptLine(prompt)})`,
  );
  // Spread keeps `confirm` in its original position (overwriting an existing key
  // never moves it), so the retry is byte-identical to the UI's.
  const retry = await httpsRequest(
    "PUT",
    path,
    headers,
    JSON.stringify({ ...project, confirm: true }),
  );
  const again = officePromptFrom(retry.status, retry.body);
  if (again) {
    throw new Error(
      `Office project PUT still refused after confirm:true (${officePromptLine(again)})`,
    );
  }
  return retry;
}

// ── Pandora location IDs (for direct Firebird state updates) ───────

const PANDORA_LOCATION_IDS: Record<string, string> = {
  "fort-myers": "TXBSQN0FEKQ11",
  fasttrax: "LAB52GY480CJF",
  naples: "PPTR5G2N0QXF7",
};

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";

/** BMI "Confirmation Kiosk" custom state ids — PER LOCATION (owner 2026-07-21).
 *  Custom state ids are client-key-scoped entities, so the Fort Myers id means
 *  nothing at Naples: writing 55397028 there silently landed nowhere, which is
 *  why Naples kiosk bookings never showed in the kiosk state. Set by the kiosk
 *  post-reserve rail AND by express-lane web bookings (both are "skip Guest
 *  Services" paths staff work from this state). */
export const KIOSK_CONFIRMATION_STATE_IDS: Record<string, string> = {
  "fort-myers": "55397028",
  fasttrax: "55397028",
  naples: "8489113",
};

/** BMI "Confirmation - VIP" custom state ids — PER LOCATION (owner 2026-08-02).
 *  Enumerated live off the Office `metadata` blob's `projectStates[]`:
 *  headpinzftmyers carries `{name:"Confirmation - VIP", id:"55466363", kind:2}`
 *  and headpinznaples carries NO VIP entry at all. Same client-key scoping trap
 *  as the kiosk ids above — so Naples is deliberately ABSENT here rather than
 *  aliased to the FM id, and every caller degrades to plain Confirmation (-3)
 *  when the lookup misses. Racing (and therefore every VIP combo) is Fort
 *  Myers-only today, so the miss is unreachable in practice; it stays a lookup
 *  so a future Naples state is a one-line data change.
 *
 *  Stamped by `~/features/combos/vip-state` on every rail that books or checks
 *  in an Ultimate VIP Experience. Read tasks/lessons.md § "A status field IS a
 *  claim" before adding a writer. */
export const VIP_CONFIRMATION_STATE_IDS: Record<string, string> = {
  "fort-myers": "55466363",
  fasttrax: "55466363",
};

// billId ↔ Office projectId arithmetic lives in lib/bmi-office-ids.ts — PURE, so
// client components (the confirmation pages build reservation-scoped waiver
// links) can import it without dragging this module's node `https`/`crypto`
// into the bundle. Re-exported here so existing server callers keep their import.
export { officeProjectIdFromBillId, billIdFromOfficeProjectId } from "./bmi-office-ids";

/**
 * The Office API answered, and the answer was "there is no such project".
 *
 * Worth its own type because it is the one ≥400 that WILL NOT change its mind. A
 * cancelled or re-parented project never comes back (see the order-reparenting
 * notes in docs/) — so a caller that retries a 404 is not being patient, it is
 * spending its attempt budget on a settled fact. Everything else, especially a
 * 5xx, is the vendor being unwell and says nothing about the project.
 *
 * Live cost of not having this (2026-08-15): sync row #1049 spent all 40 attempts
 * over 4h33m re-fetching project 63000000008492343, which is gone from Office and
 * from all three Pandora locations, and reported "Failed to fetch project: 404"
 * forty times as if the next try might differ.
 */
export class BmiProjectNotFoundError extends Error {
  readonly projectId: string;
  constructor(projectId: string) {
    super(`Failed to fetch project: 404 — project ${projectId} does not exist in Office`);
    this.name = "BmiProjectNotFoundError";
    this.projectId = projectId;
  }
}

// ── Update project state (generic) ──────────────────────────────────

export async function setProjectState(params: {
  centerCode: string;
  projectId: string;
  stateId: string;
  label?: string;
  /** Custom-state (kiosk) only: after the Office PUT lands, re-read the project
   *  state up to `ensureAttempts` times (gap `ensureGapMs`, default 4000ms) and
   *  re-assert the custom id if it has drifted. Needed because the reserve flow's
   *  inline `-3` confirm write goes via PANDORA, which returns 200 immediately but
   *  propagates to Firebird ASYNCHRONOUSLY — it can land AFTER this Office PUT and
   *  clobber the custom state back to plain Confirmation (live 2026-07-22: ~80% of
   *  kiosk bookings reverted to `-3`). Re-asserting across the propagation window
   *  makes the custom state the durable final write. Default 0 = no reassert, so
   *  the built-in `-3` / web callers below are unchanged. */
  ensureAttempts?: number;
  ensureGapMs?: number;
  /** Custom-state only: how many times to re-read the state to CONFIRM the write
   *  landed before throwing (default 3, gap `confirmGapMs` = 1200ms). Distinct
   *  from `ensureAttempts`, which re-ASSERTS a state that drifted after landing;
   *  this decides whether it ever landed at all. Lower it only where a caller
   *  genuinely does not care whether the write took. */
  confirmAttempts?: number;
  confirmGapMs?: number;
}): Promise<void> {
  const clientKey = CLIENT_KEYS[params.centerCode] || "headpinzftmyers";
  const locationId = PANDORA_LOCATION_IDS[params.centerCode] || "TXBSQN0FEKQ11";

  // Read the current project state via the Office API (for reassert verification).
  const readOfficeState = async (): Promise<string | null> => {
    try {
      const token = await getOfficeToken(clientKey);
      const headers = apiHeaders(token, clientKey);
      const getRes = await httpsRequest(
        "GET",
        `/api/${clientKey}/project/${params.projectId}`,
        headers,
      );
      if (getRes.status >= 400) return null;
      const p = JSON.parse(getRes.body) as { stateId?: string | number };
      return p?.stateId != null ? String(p.stateId) : null;
    } catch {
      return null;
    }
  };

  const viaPandora = async (): Promise<boolean> => {
    try {
      const pandoraKey = process.env.SWAGGER_ADMIN_KEY || "";
      const pandoraRes = await fetch(`${PANDORA_BASE}/v2/bmi/reservation/state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pandoraKey}`,
        },
        body: JSON.stringify({
          locationID: locationId,
          projectId: params.projectId,
          stateID: params.stateId,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      return pandoraRes.ok;
    } catch {
      return false;
    }
  };

  const viaOfficeApi = async (): Promise<void> => {
    const token = await getOfficeToken(clientKey);
    const headers = apiHeaders(token, clientKey);
    const getRes = await httpsRequest(
      "GET",
      `/api/${clientKey}/project/${params.projectId}`,
      headers,
    );
    if (getRes.status === 404) throw new BmiProjectNotFoundError(params.projectId);
    if (getRes.status >= 400) throw new Error(`Failed to fetch project: ${getRes.status}`);
    const project = JSON.parse(getRes.body);
    const minimal = toMinimalProject(project);
    minimal.stateId = params.stateId;
    const putRes = await putProject(clientKey, headers, minimal);
    if (putRes.status >= 400)
      throw new Error(
        `Failed to update project status: ${putRes.status} ${putRes.body.slice(0, 200)}`,
      );
    console.log(
      `[bmi-office] project ${params.projectId} state → ${params.stateId} via Office API${params.label ? ` (${params.label})` : ""}`,
    );
  };

  // CUSTOM state ids (e.g. the kiosk's 55397028): Pandora returns 200 but
  // silently normalizes/no-ops the write — live 2026-07-18, W52109 logged
  // "55397028 via Pandora" while BMI showed plain Confirmation (the same
  // 200-and-no-op pathology as the converted-reservation memo lesson). The
  // Office project PUT is the path that actually lands custom states, so they
  // go OFFICE-FIRST; built-in states (negative ids, e.g. -3) keep Pandora
  // first — that path is proven for them.
  const isCustomState = !params.stateId.startsWith("-");
  if (isCustomState) {
    // OFFICE RAIL ONLY — there is deliberately NO Pandora fallback here (owner
    // 2026-08-12: "never fall back to pandora, just leave them in Send Contract").
    //
    // Pandora 200s and silently NO-OPS custom state ids — documented three times
    // in tasks/lessons.md. As a fallback it could therefore only ever do one of
    // two things: nothing, or lie about having done nothing. On 2026-08-03 it did
    // the second, and the dispatch cron read that lie as its loop-breaker: ~88
    // duplicate contract emails to 4 guests in 45 minutes.
    //
    // The fallback's last apparent justification was the 403s on PUT /project —
    // now known to be BMI asking "do you want to overbook?" rather than an outage
    // (see putProject). Those are answered on this rail. What remains is a throw,
    // which is the right outcome: the project stays in "Send Contract", no guest
    // email goes out, and the next 2-minute pass retries cleanly. A contract that
    // arrives one pass late beats one that arrives twenty-five times.
    await viaOfficeApi();

    // CONFIRM the write landed. A 200 is not proof for a custom state id, and
    // resolving on an unproven write is how this function used to lie to its
    // callers. Retried with a gap: a state write propagates to Firebird
    // ASYNCHRONOUSLY (the same reason ensureAttempts exists below).
    //
    // An UNREADABLE verify leaves the write assumed-good — the Office PUT is the
    // proven path for custom ids and reads can fail on their own. Positively
    // reading a DIFFERENT state always throws.
    const confirmAttempts = params.confirmAttempts ?? 3;
    const confirmGapMs = params.confirmGapMs ?? 1200;
    let observed: string | null = null;
    for (let i = 0; i < confirmAttempts; i++) {
      observed = await readOfficeState();
      if (observed === params.stateId) break;
      if (i < confirmAttempts - 1) await new Promise((r) => setTimeout(r, confirmGapMs));
    }
    if (observed !== params.stateId && observed !== null) {
      throw new Error(
        `state ${params.stateId} written via office but project ${params.projectId} reads ` +
          `${observed} — treating as NOT landed`,
      );
    }
    // Self-heal against a late-landing cross-backend `-3` write (the kiosk
    // propagation race). Watch the state across a short window; each time it has
    // drifted off the custom id, PUT it again. The inline `-3` is a one-shot
    // Pandora write, so once it has propagated and been overwritten here, it
    // stays put.
    const attempts = params.ensureAttempts ?? 0;
    const gapMs = params.ensureGapMs ?? 4000;
    for (let i = 0; i < attempts; i++) {
      await new Promise((r) => setTimeout(r, gapMs));
      const cur = await readOfficeState();
      if (cur === params.stateId) continue;
      console.warn(
        `[bmi-office] project ${params.projectId} state drifted to ${cur ?? "?"} (expected ${params.stateId}) — re-asserting${params.label ? ` (${params.label})` : ""}`,
      );
      try {
        await viaOfficeApi();
      } catch (err) {
        console.warn(
          "[bmi-office] custom-state re-assert PUT failed (will retry if attempts remain):",
          err,
        );
      }
    }
    return;
  }

  if (await viaPandora()) {
    console.log(
      `[bmi-office] project ${params.projectId} state → ${params.stateId} via Pandora${params.label ? ` (${params.label})` : ""}`,
    );
    return;
  }
  console.warn(`[bmi-office] Pandora state update failed, falling back to Office API`);
  await viaOfficeApi();
}

// ── Update project to Confirmation (after deposit paid) ─────────────

export async function updateProjectStatus(params: {
  centerCode: string;
  projectId: string;
  hasWaiverActivities?: boolean;
}): Promise<void> {
  await setProjectState({
    centerCode: params.centerCode,
    projectId: params.projectId,
    stateId: "-3",
    label: "Confirmation",
  });
}

// ── Record payment ──────────────────────────────────────────────────

import type { ProjectPaymentFailureSource } from "@/lib/bmi-project-payment-retry";

export async function recordProjectPayment(params: {
  centerCode: string;
  projectId: string;
  amountDollars: number;
}): Promise<{ paymentReference: string }> {
  const clientKey = CLIENT_KEYS[params.centerCode] || "headpinzftmyers";
  const token = await getOfficeToken(clientKey);
  const headers = apiHeaders(token, clientKey);
  const payMethodId = PAY_METHOD_IDS[clientKey] || "393797";

  const body = JSON.stringify({
    projectId: params.projectId,
    kind: 2,
    date: new Date().toISOString(),
    amount: params.amountDollars,
    payMethodId,
    state: 0,
    created: null,
    voidedDate: null,
  });

  const res = await httpsRequest("POST", `/api/${clientKey}/projectPayment`, headers, body);
  if (res.status >= 400)
    throw new Error(`Failed to record payment: ${res.status} ${res.body.slice(0, 200)}`);

  const data = JSON.parse(res.body);
  console.log(
    `[bmi-office] payment recorded for project ${params.projectId}: $${params.amountDollars} ref=${data.paymentReference?.slice(0, 20)}`,
  );
  return { paymentReference: data.paymentReference || "" };
}

// ── Per-person qualification reads (kiosk mid-session refresh) ──────
// Same office endpoints the sign-in lookup proxies (/api/bmi-office
// action=person / action=deposits), callable server-side with internal
// credentials — the kiosk's verified-session cookie only lives 15 min, so a
// mid-session refresh can't ride the client-side auth.

const LOOKUP_CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";

/**
 * CREATE a person on the BMI CLOUD via the Office API — the cloud-first mint
 * (owner 2026-08-12: "cloud is first, pandora second").
 *
 * WHY THIS RAIL. Two cloud mints exist and only this one is complete:
 *   public-booking `registerContactPerson`/`registerProjectPerson` with no
 *     personId DOES mint, but has no birthdate field at all — so the person
 *     lands on the center's local server answering Pandora with 500 "Response
 *     Validator Error" until a separate PATCH repairs it, and its phone never
 *     arrives. It also REQUIRES an orderId, so it cannot mint before a booking.
 *   THIS (`POST /api/{ck}/person`) takes `birthDate` plus addresses[].{email,
 *     mobile} and needs no order — measured 2026-08-12, the person lands
 *     READABLE (clean 200 with birthdate + email + phoneNumber, both FM
 *     locations) in ~28-32s, needing no repair followup at all.
 *
 * Payload is the Office UI's own request (HAR-captured from
 * office.bmileisure.com), kept FIELD-FOR-FIELD including the `-1`/`-5`
 * sentinels and the nested birthCity/city stubs: this is a full-entity POST and
 * the UI is the only proven caller, so a trimmed body is an untested body.
 * Office calls the surname `name`.
 *
 * The four consent flags are sent TRUE per the owner (2026-08-12), verified
 * echoed back true. The booking/waiver flow that collects the guest must carry
 * the matching consent language — these authorize marketing email and SMS.
 *
 * Returns the new 17-digit person id. Parsed with raw-id handling: a bare
 * JSON.parse would round it (house hard rule).
 */
export async function createOfficePerson(params: {
  firstName: string;
  lastName: string;
  /** ISO `YYYY-MM-DD`. Strongly recommended — a person with no birthdate reads
   *  500 on Pandora forever, which every consumer treats as "no waiver". */
  birthdate?: string | null;
  email?: string | null;
  phone?: string | null;
  centerCode?: string;
  /** Office person category. -5 is what the UI sends for a guest record. */
  personCategoryId?: number;
  gender?: number;
}): Promise<{ personId: string }> {
  const clientKey = CLIENT_KEYS[params.centerCode ?? "fort-myers"] || "headpinzftmyers";
  const token = await getOfficeToken(clientKey);
  const digits = String(params.phone ?? "").replace(/\D/g, "");
  const category = params.personCategoryId ?? -5;
  const cityStub = { countryId: "-1", name: null, zip: null, region: { name: null } };
  const body = {
    id: null,
    alias: null,
    bic: null,
    birthCity: cityStub,
    firstName: params.firstName,
    name: params.lastName,
    name2: null,
    free1: null,
    free2: null,
    // 0 = unspecified; the HAR hardcoded 1 because that UI form had a value.
    gender: params.gender ?? 0,
    height: null,
    iban: null,
    isAnonymized: false,
    isChargeMe: false,
    isCompleted: true,
    kind: 0,
    languageId: "-1",
    nationalityId: "-1",
    nationalNumber: null,
    number: null,
    passport: null,
    password: null,
    privateMemo: null,
    publicMemo: null,
    publicPicture: true,
    register: null,
    restrictProcessing: false,
    vat: null,
    visibility: 2,
    weight: null,
    personCategoryId: category,
    originalPersonCategoryId: category,
    acceptMailCommercial: true,
    acceptMailScores: true,
    acceptSmsCommercial: true,
    acceptSmsScores: true,
    addresses: [
      {
        id: null,
        kind: 0,
        email: params.email || null,
        phone: null,
        phone2: null,
        city: cityStub,
        isAnonymized: false,
        street: null,
        number: null,
        mobile: digits.length >= 10 ? digits : null,
        box: "",
      },
    ],
    birthDate: params.birthdate || null,
    memberships: [],
    tags: [],
  };
  const res = await httpsRequest(
    "POST",
    `/api/${clientKey}/person`,
    apiHeaders(token, clientKey),
    JSON.stringify(body),
  );
  if (res.status >= 400) {
    throw new Error(`Office person create failed: ${res.status} ${res.body.slice(0, 200)}`);
  }
  const parsed = parseWithRawIds<{ id?: string }>(res.body);
  const personId = parsed?.id ? String(parsed.id) : "";
  if (!/^\d+$/.test(personId)) {
    throw new Error(`Office person create returned no id: ${res.body.slice(0, 200)}`);
  }
  console.log(
    `[bmi-office] created cloud person ${personId} (${params.firstName} ${params.lastName}` +
      `${params.birthdate ? `, dob ${params.birthdate}` : ", NO DOB — will read 500 on Pandora"})`,
  );
  return { personId };
}

/** Raw office person record by id (memberships[], tags[], birthDate, …), or
 *  null on any failure. personId is a raw digit string — never Number() it. */
export async function fetchOfficePerson(
  personId: string,
  clientKey: string = LOOKUP_CLIENT_KEY,
): Promise<Record<string, unknown> | null> {
  try {
    const token = await getOfficeToken(clientKey);
    const res = await httpsRequest(
      "GET",
      `/api/${clientKey}/person/${personId}`,
      apiHeaders(token, clientKey),
    );
    if (res.status >= 400) return null;
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

/** Office deposit/history rows for a person (2-year lookback — the same window
 *  the sign-in lookup uses), or null on any failure. */
export async function fetchOfficeDepositHistory(
  personId: string,
  clientKey: string = LOOKUP_CLIENT_KEY,
): Promise<Array<{ depositKind?: string | null; balance?: number | null }> | null> {
  try {
    const token = await getOfficeToken(clientKey);
    const now = new Date();
    const from = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate())
      .toISOString()
      .split(".")[0];
    const until = now.toISOString().split(".")[0];
    const res = await httpsRequest(
      "GET",
      `/api/${clientKey}/deposit/history?personId=${personId}&from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`,
      apiHeaders(token, clientKey),
    );
    if (res.status >= 400) return null;
    const rows = JSON.parse(res.body);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

// ── Batch person lookup ─────────────────────────────────────────────

export interface PersonInfo {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}

export async function fetchPersonsByIds(
  centerCode: string,
  personIds: string[],
): Promise<PersonInfo[]> {
  if (personIds.length === 0) return [];
  const clientKey = CLIENT_KEYS[centerCode] || "headpinzftmyers";
  const token = await getOfficeToken(clientKey);
  const headers = apiHeaders(token, clientKey);

  const res = await httpsRequest(
    "POST",
    `/api/${clientKey}/personprofile/personsByIds`,
    headers,
    JSON.stringify(personIds),
  );
  if (res.status >= 400) return [];

  const persons = JSON.parse(res.body) as Array<{
    id: string;
    firstName: string;
    name: string;
    addresses?: Array<{ email?: string; mobile?: string }>;
  }>;

  return persons.map((p) => ({
    id: p.id,
    firstName: p.firstName || "",
    lastName: p.name || "",
    email: p.addresses?.[0]?.email || null,
    phone: p.addresses?.[0]?.mobile || null,
  }));
}

// ── Fetch project (read-only) ──────────────────────────────────────

export async function fetchProject(
  centerCode: string,
  projectId: string,
): Promise<Record<string, unknown> | null> {
  const clientKey = CLIENT_KEYS[centerCode] || "headpinzftmyers";
  const token = await getOfficeToken(clientKey);
  const headers = apiHeaders(token, clientKey);
  const res = await httpsRequest("GET", `/api/${clientKey}/project/${projectId}`, headers);
  if (res.status >= 400) return null;
  return JSON.parse(res.body);
}

/**
 * Read a project WITHOUT rounding its 17-digit ids, keyed by clientKey.
 *
 * `fetchProject` above JSON.parses bare. That is survivable for its callers
 * (they read name / state / balance) and FATAL for anything that reads
 * `bills[].id`, which is 17-digit: a rounded bill id names a different order or
 * none at all, and the failure is silent — you get an id-shaped number back.
 * See tasks/lessons.md § BMI ID Precision → INBOUND, and the standing warning
 * in ~/features/daily-events/data/bmi-office.ts.
 *
 * Takes a clientKey rather than a centerCode because its callers (the waiver
 * attach path) resolve the client from a BMI locationId, not from our own
 * center slug.
 */
export async function fetchProjectRawIds(
  clientKey: string,
  projectId: string,
): Promise<Record<string, unknown> | null> {
  const token = await getOfficeToken(clientKey);
  const headers = apiHeaders(token, clientKey);
  const res = await httpsRequest("GET", `/api/${clientKey}/project/${projectId}`, headers);
  if (res.status >= 400) return null;
  return parseWithRawIds<Record<string, unknown>>(res.body);
}

// ── Remove a person from a reservation (Office projectPerson row) ──

/**
 * Detach a person from a reservation — the Office UI's own call, proven by HAR
 * capture + live probe 2026-07-31 (scripts/office-projectperson-remove-probe.mts,
 * PASS on project 55762353: add verified, delete verified, net-zero row set).
 *
 *   DELETE /api/{clientKey}/projectPerson?id={projectPersonRowId}
 *
 * Keyed on the projectPersons[] ROW id, not the personId — so this re-reads the
 * project to find the row, deletes it, and re-reads again to CONFIRM the row is
 * gone. A bare 200 is never trusted (tasks/lessons.md "removeItem 200 ≠
 * success"). The person's WAIVER is untouched by construction: this only
 * detaches them from the reservation roster; the Pandora signature record and
 * their account survive.
 *
 * Own raw-id parse here — projectPersons carries 17-digit row ids and person
 * ids, and the module's fetchProject JSON.parses bare (fine for its callers,
 * fatal here).
 */
export async function removeProjectPersonRow(params: {
  clientKey: string;
  projectId: string;
  personId: string;
}): Promise<
  | { removed: true; rowId: string }
  | { removed: false; reason: "not-on-project" | "delete-failed" | "still-present" }
> {
  const { clientKey, projectId, personId } = params;
  const token = await getOfficeToken(clientKey);
  const headers = apiHeaders(token, clientKey);

  const parseRawIds = (text: string): Record<string, unknown> =>
    JSON.parse(text.replace(/"(\w*[iI]d)"\s*:\s*(\d{15,})/g, '"$1":"$2"'));
  const rowsOf = (project: Record<string, unknown>) =>
    ((project.projectPersons ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      personId: String(r.personId),
    }));

  const before = await httpsRequest("GET", `/api/${clientKey}/project/${projectId}`, headers);
  if (before.status >= 400) throw new Error(`project GET failed: ${before.status}`);
  const row = rowsOf(parseRawIds(before.body)).find((r) => r.personId === personId);
  if (!row) return { removed: false, reason: "not-on-project" };

  const del = await httpsRequest(
    "DELETE",
    `/api/${clientKey}/projectPerson?id=${encodeURIComponent(row.id)}`,
    headers,
  );
  if (del.status >= 400) return { removed: false, reason: "delete-failed" };

  const after = await httpsRequest("GET", `/api/${clientKey}/project/${projectId}`, headers);
  if (after.status >= 400) throw new Error(`verify GET failed: ${after.status}`);
  const stillThere = rowsOf(parseRawIds(after.body)).some((r) => r.personId === personId);
  return stillThere
    ? { removed: false, reason: "still-present" }
    : { removed: true, rowId: row.id };
}

// ── Update project name ────────────────────────────────────────────

export async function updateProjectName(params: {
  centerCode: string;
  projectId: string;
  name: string;
}): Promise<void> {
  // Primary: Pandora direct Firebird update (bypasses overbooking validation)
  const locationId = PANDORA_LOCATION_IDS[params.centerCode] || "TXBSQN0FEKQ11";
  try {
    const pandoraKey = process.env.SWAGGER_ADMIN_KEY || "";
    const pandoraRes = await fetch(`${PANDORA_BASE}/v2/bmi/reservation/name`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pandoraKey}`,
      },
      body: JSON.stringify({
        locationID: locationId,
        projectId: params.projectId,
        name: params.name,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (pandoraRes.ok) {
      console.log(
        `[bmi-office] updated project name ${params.projectId} → "${params.name}" via Pandora`,
      );
      return;
    }
    console.warn(
      `[bmi-office] Pandora name update failed (${pandoraRes.status}), falling back to Office API`,
    );
  } catch (err) {
    console.warn("[bmi-office] Pandora name update error, falling back to Office API:", err);
  }

  // Fallback: Office API with minimal PUT
  const clientKey = CLIENT_KEYS[params.centerCode] || "headpinzftmyers";
  const token = await getOfficeToken(clientKey);
  const headers = apiHeaders(token, clientKey);

  const getRes = await httpsRequest(
    "GET",
    `/api/${clientKey}/project/${params.projectId}`,
    headers,
  );
  if (getRes.status === 404) throw new BmiProjectNotFoundError(params.projectId);
  if (getRes.status >= 400) throw new Error(`Failed to fetch project: ${getRes.status}`);
  const project = JSON.parse(getRes.body);

  const minimal = toMinimalProject(project);
  minimal.name = params.name;
  minimal.displayName = params.name;

  const putRes = await putProject(clientKey, headers, minimal);
  if (putRes.status >= 400)
    throw new Error(`Failed to update project name: ${putRes.status} ${putRes.body.slice(0, 200)}`);

  console.log(`[bmi-office] updated project name ${params.projectId} → "${params.name}"`);
}

// ── Update public notes ────────────────────────────────────────────

export async function updateProjectPublicNotes(params: {
  centerCode: string;
  projectId: string;
  notes: string;
}): Promise<void> {
  // Primary: Pandora direct Firebird update. /memo/public REPLACES the public
  // note (1:1 with the Office set below). projectId is already a string
  // (bmi_reservation_id is TEXT) — JSON.stringify is precision-safe; never Number() it.
  const locationId = PANDORA_LOCATION_IDS[params.centerCode] || "TXBSQN0FEKQ11";
  try {
    const pandoraKey = process.env.SWAGGER_ADMIN_KEY || "";
    const pandoraRes = await fetch(`${PANDORA_BASE}/v2/bmi/reservation/memo/public`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pandoraKey}`,
      },
      body: JSON.stringify({
        locationID: locationId,
        projectId: params.projectId,
        memo: params.notes,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // Pandora can 200 with {"success":false} (or even "success":true without
    // the write landing — see appendProjectPrivateNote) — never trust HTTP
    // status alone.
    const pandoraBody = (await pandoraRes.json().catch(() => null)) as { success?: boolean } | null;
    if (pandoraRes.ok && pandoraBody?.success === true) {
      console.log(`[bmi-office] updated public notes for project ${params.projectId} via Pandora`);
      return;
    }
    console.warn(
      `[bmi-office] Pandora public-notes update failed (${pandoraRes.status}, success=${pandoraBody?.success}), falling back to Office API`,
    );
  } catch (err) {
    console.warn(
      "[bmi-office] Pandora public-notes update error, falling back to Office API:",
      err,
    );
  }

  // Fallback: Office API GET-find-public-log-modify-PUT
  const clientKey = CLIENT_KEYS[params.centerCode] || "headpinzftmyers";
  const token = await getOfficeToken(clientKey);
  const headers = apiHeaders(token, clientKey);

  const getRes = await httpsRequest(
    "GET",
    `/api/${clientKey}/project/${params.projectId}`,
    headers,
  );
  if (getRes.status === 404) throw new BmiProjectNotFoundError(params.projectId);
  if (getRes.status >= 400) throw new Error(`Failed to fetch project: ${getRes.status}`);
  const project = JSON.parse(getRes.body);

  const logs = (project.logs || []) as Array<{ public: boolean; memo: string; id: string }>;
  const publicLog = logs.find((l) => l.public);

  if (!publicLog) {
    const createRes = await httpsRequest(
      "POST",
      `/api/${clientKey}/projectLog`,
      headers,
      JSON.stringify({
        projectId: params.projectId,
        public: true,
        kind: 1,
        action: 7,
        memo: params.notes,
      }),
    );
    if (createRes.status >= 400)
      throw new Error(`Failed to create public log: ${createRes.status}`);
  } else {
    publicLog.memo = params.notes;
    const minimal = toMinimalProject(project, ["logs"]);
    minimal.logs = logs;
    const putRes = await putProject(clientKey, headers, minimal);
    if (putRes.status >= 400)
      throw new Error(
        `Failed to update project notes: ${putRes.status} ${putRes.body.slice(0, 200)}`,
      );
  }

  console.log(`[bmi-office] updated public notes for project ${params.projectId}`);
}

// ── Append to private notes ────────────────────────────────────────

export function noteTimestamp(): string {
  return new Date().toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  });
}

const NOTES_SECTION_START = "── FastTrax Web ──";
const NOTES_SECTION_END = "── End FastTrax Web ──";

const NOTES_LINKS_MARKER = "──";

/**
 * The sticky links staff read off a project's private memo.
 *
 * `Waiver Organizer` opens the waiver page WITH the roster — who has signed and who
 * has not; `Waiver Sign Only` is the link to hand a guest. Both are here so
 * the desk can answer "who still needs to sign?" and "send me the link" without
 * digging through the guest's email — the same reason the contract URL is here.
 *
 * "Organizer" is the owner's word for it, what the guest emails print, AND the
 * stored capability value — one vocabulary end to end, so a label can never drift
 * from the enum it describes.
 */
interface SectionLinks {
  contractUrl: string | null;
  pdfUrl: string | null;
  waiverOrganizerUrl: string | null;
  waiverSignUrl: string | null;
}

const EMPTY_LINKS: SectionLinks = {
  contractUrl: null,
  pdfUrl: null,
  waiverOrganizerUrl: null,
  waiverSignUrl: null,
};

/** Label ↔ field, in the order they render. Prefixes are regex-plain on purpose. */
const LINK_LABELS: Array<[keyof SectionLinks, string]> = [
  ["contractUrl", "Contract"],
  ["pdfUrl", "Signed PDF"],
  ["waiverOrganizerUrl", "Waiver Organizer"],
  ["waiverSignUrl", "Waiver Sign Only"],
];

function buildSection(links: SectionLinks, logLines: string): string {
  const lines = LINK_LABELS.filter(([key]) => links[key]).map(
    ([key, label]) => `${label}: ${links[key]}`,
  );
  const header = lines.length > 0 ? `${lines.join("\n")}\n${NOTES_LINKS_MARKER}\n` : "";
  return `${NOTES_SECTION_START}\n${header}${logLines}\n${NOTES_SECTION_END}`;
}

function parseSection(section: string): SectionLinks & { logLines: string } {
  const markerIdx = section.indexOf(NOTES_LINKS_MARKER + "\n");
  if (markerIdx < 0) return { ...EMPTY_LINKS, logLines: section.trim() };
  const header = section.slice(0, markerIdx).trim();
  const logLines = section.slice(markerIdx + NOTES_LINKS_MARKER.length + 1).trim();
  const parsed = { ...EMPTY_LINKS, logLines };
  for (const [key, label] of LINK_LABELS) {
    // Anchored to line start so "Signed PDF" cannot be captured by a looser
    // prefix, and so a URL containing a label word can never be re-read as one.
    const m = new RegExp(`^${label}:\\s*(.+)$`, "m").exec(header);
    parsed[key] = m?.[1]?.trim() || null;
  }
  return parsed;
}

/**
 * Merge a new private-note entry into an existing private memo, keeping ALL
 * existing text — staff's own notes outside the section AND prior system
 * entries inside it — and appending the new line inside the
 * "── FastTrax Web ──" section. Returns the full merged memo.
 */
function mergePrivateMemo(existing: string, note: string, incoming: SectionLinks): string {
  const startIdx = existing.indexOf(NOTES_SECTION_START);
  const endIdx = existing.indexOf(NOTES_SECTION_END);

  if (startIdx >= 0 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + NOTES_SECTION_END.length);
    const sectionContent = existing.slice(startIdx + NOTES_SECTION_START.length, endIdx).trim();
    const parsed = parseSection(sectionContent);
    // Exact-duplicate suppression: a retried rail (e.g. kiosk post-reserve
    // re-run) appending the identical entry is a no-op instead of a repeated
    // line. Timestamped portal notes stay unique by their prefix, so genuine
    // repeat notes from staff still land.
    if (parsed.logLines.includes(note)) return existing;
    // Links are STICKY per field: a caller that knows only about the contract must
    // never blank a waiver link a previous append already recorded, and vice versa.
    const merged: SectionLinks = { ...EMPTY_LINKS };
    for (const [key] of LINK_LABELS) merged[key] = incoming[key] || parsed[key];
    const updatedLog = parsed.logLines ? `${parsed.logLines}\n${note}` : note;
    return `${before}${buildSection(merged, updatedLog)}${after}`;
  }

  const sep = existing.trim() ? "\n\n" : "";
  return `${existing}${sep}${buildSection(incoming, note)}`;
}

/**
 * Test seam — the PURE memo merge, no network. Exported so the sticky-link rules
 * can be pinned: this function is the only thing standing between "append a note"
 * and "silently blank a link a previous append recorded".
 */
export { mergePrivateMemo as _mergePrivateMemo };
export type { SectionLinks as _SectionLinks };

export async function appendProjectPrivateNote(params: {
  centerCode: string;
  projectId: string;
  note: string;
  contractUrl?: string;
  pdfUrl?: string;
  /** Waiver page WITH the roster — the organizer's link. Sticky once set. */
  waiverOrganizerUrl?: string;
  /** Sign-only waiver link, safe to hand a guest. Sticky once set. */
  waiverSignUrl?: string;
  /** BMI bill/order id (raw 17-digit string — NEVER Number() it). When
   *  provided, enables the public `booking/memo` fallback — the only write
   *  path verified to reach CONVERTED racing reservations (see below). */
  billId?: string;
}): Promise<boolean> {
  // Private notes are a ROLLING LOG. Pandora /memo/private REPLACES the memo (it
  // does NOT append server-side), so sending just the new line wiped prior
  // entries and any staff-typed notes. We accumulate client-side: read the
  // current memo, merge the new entry, then write the FULL merged text.
  // (Public notes are intentionally replace-only — see updateProjectPublicNotes.)
  // projectId is a string (bmi_reservation_id is TEXT) — JSON.stringify is
  // precision-safe; never Number() it.
  //
  // WRITE PATHS (2026-07-10, verified live on racing reservation W49623):
  // both Pandora /memo/private AND the Office project PUT return success on a
  // converted racing reservation without the write EVER appearing in the
  // Booking app or on subsequent reads — silent no-ops. The only path that
  // demonstrably lands there is the public-booking `booking/memo` endpoint
  // (the one the booking flow itself uses). So: try Office (works for group
  // functions), VERIFY by re-reading, and escalate to booking/memo when the
  // verify fails and we know the billId. Pandora is the last resort.
  const clientKey = CLIENT_KEYS[params.centerCode] || "headpinzftmyers";
  const locationId = PANDORA_LOCATION_IDS[params.centerCode] || "TXBSQN0FEKQ11";

  // 1. Read the current private memo via the Office API (the same store Pandora
  //    writes to). Hold the project + logs for the Office PUT fallback below.
  const token = await getOfficeToken(clientKey);
  const headers = apiHeaders(token, clientKey);

  let project: Record<string, unknown>;
  let logs: Array<{ public: boolean; memo: string; id: string }>;
  let privateLog: { public: boolean; memo: string; id: string } | undefined;
  try {
    const getRes = await httpsRequest(
      "GET",
      `/api/${clientKey}/project/${params.projectId}`,
      headers,
    );
    if (getRes.status >= 400) throw new Error(`GET project ${getRes.status}`);
    project = JSON.parse(getRes.body);
    logs = (project.logs || []) as Array<{ public: boolean; memo: string; id: string }>;
    privateLog = logs.find((l) => !l.public);
  } catch (err) {
    // Never send a replacing write we couldn't base on the current text — that
    // would wipe prior entries. Skip this (non-fatal) audit line instead.
    console.warn(
      `[bmi-office] private-note read failed for project ${params.projectId}; skipping append to avoid overwrite:`,
      err,
    );
    return false;
  }

  // 2. Merge the new entry into the existing memo (preserves staff text + prior
  //    system entries).
  const mergedMemo = mergePrivateMemo(privateLog?.memo || "", params.note, {
    contractUrl: params.contractUrl || null,
    pdfUrl: params.pdfUrl || null,
    waiverOrganizerUrl: params.waiverOrganizerUrl || null,
    waiverSignUrl: params.waiverSignUrl || null,
  });

  // Re-read the private memo and report whether the appended note landed.
  const noteVisible = async (): Promise<boolean> => {
    try {
      const res = await httpsRequest(
        "GET",
        `/api/${clientKey}/project/${params.projectId}`,
        headers,
      );
      if (res.status >= 400) return false;
      const fresh = JSON.parse(res.body) as { logs?: Array<{ public: boolean; memo: string }> };
      return (fresh.logs || []).some((l) => !l.public && (l.memo || "").includes(params.note));
    } catch {
      return false;
    }
  };

  // 3. Primary write: Office API PUT into the private log (create it if none
  //    exists) — works for group-function projects. VERIFIED by re-read, not
  //    trusted: on converted racing reservations this PUT 200s and no-ops.
  try {
    if (!privateLog) {
      const createRes = await httpsRequest(
        "POST",
        `/api/${clientKey}/projectLog`,
        headers,
        JSON.stringify({
          projectId: params.projectId,
          public: false,
          kind: 1,
          action: 7,
          memo: mergedMemo,
        }),
      );
      if (createRes.status >= 400) {
        throw new Error(`Failed to create private log: ${createRes.status}`);
      }
    } else {
      privateLog.memo = mergedMemo;
      const minimal = toMinimalProject(project, ["logs"]);
      minimal.logs = logs;
      const putRes = await putProject(clientKey, headers, minimal);
      if (putRes.status >= 400) {
        throw new Error(
          `Failed to update private notes: ${putRes.status} ${putRes.body.slice(0, 200)}`,
        );
      }
    }
    if (await noteVisible()) {
      console.log(
        `[bmi-office] appended private note for project ${params.projectId} via Office API`,
      );
      return true;
    }
    console.warn(
      `[bmi-office] Office private-note PUT accepted but note not visible on re-read for project ${params.projectId} — escalating`,
    );
  } catch (err) {
    console.warn(
      `[bmi-office] Office private-note write failed for project ${params.projectId}, escalating:`,
      err,
    );
  }

  // 4. Escalation: public-booking `booking/memo` with the FULL merged memo —
  //    the write path the booking flow itself uses, and the only one verified
  //    to land on converted racing reservations. Needs the bill/order id.
  //    Mirrors into our Neon reservation notes exactly like the /api/bmi
  //    proxy does, so the admin Notes tab stays in sync.
  if (params.billId && /^\d+$/.test(params.billId)) {
    try {
      const memoOk = await writeBookingMemo(clientKey, params.billId, mergedMemo);
      if (memoOk && (await noteVisible())) {
        try {
          const { mirrorMemoIntoNotesByBillId } = await import("@/lib/bowling-db");
          await mirrorMemoIntoNotesByBillId(params.billId, mergedMemo);
        } catch {
          /* notes mirror is best-effort, never blocks the BMI write */
        }
        console.log(
          `[bmi-office] appended private note for project ${params.projectId} via booking/memo (bill ${params.billId})`,
        );
        return true;
      }
      console.warn(
        `[bmi-office] booking/memo escalation ${memoOk ? "wrote but note not visible on re-read" : "failed"} for bill ${params.billId}`,
      );
    } catch (err) {
      console.warn(`[bmi-office] booking/memo escalation error for bill ${params.billId}:`, err);
    }
  }

  // 5. Last resort: Pandora /memo/private. Known to 200 {"success":true}
  //    without landing (see header comment) — check body.success and treat
  //    the result as best-effort.
  try {
    const pandoraKey = process.env.SWAGGER_ADMIN_KEY || "";
    const pandoraRes = await fetch(`${PANDORA_BASE}/v2/bmi/reservation/memo/private`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pandoraKey}`,
      },
      body: JSON.stringify({
        locationID: locationId,
        projectId: params.projectId,
        memo: mergedMemo,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const pandoraBody = (await pandoraRes.json().catch(() => null)) as { success?: boolean } | null;
    if (pandoraRes.ok && pandoraBody?.success === true) {
      console.log(
        `[bmi-office] appended private note for project ${params.projectId} via Pandora (unverified)`,
      );
      return true;
    }
    console.warn(
      `[bmi-office] Pandora private-note fallback failed (${pandoraRes.status}, success=${pandoraBody?.success})`,
    );
  } catch (err) {
    console.warn("[bmi-office] Pandora private-note fallback error:", err);
  }
  return false;
}

// ── Public-booking booking/memo write (server-side) ─────────────────

const BMI_PUBLIC_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";
const publicTokenCache: Record<string, { token: string; expiry: number }> = {};

export async function getPublicBookingToken(clientKey: string): Promise<string> {
  const cached = publicTokenCache[clientKey];
  if (cached && Date.now() < cached.expiry - 60_000) return cached.token;
  const res = await fetch(`${BMI_PUBLIC_API_URL}/auth/${clientKey}/publicbooking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "BMI-Subscription-Key": BMI_SUB_KEY },
    body: JSON.stringify({ Username: BMI_USERNAME, Password: BMI_PASSWORD }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`BMI public auth failed: ${res.status}`);
  const data = await res.json();
  const token = data.AccessToken || data.accessToken;
  const expiresIn = parseInt(data.ExpiresIn || data.expiresIn || "3600", 10);
  publicTokenCache[clientKey] = { token, expiry: Date.now() + expiresIn * 1000 };
  return token;
}

/** POST public-booking booking/memo — REPLACES the reservation's booking
 *  memo (the Booking app "Memo and image" tab). Callers must pass the FULL
 *  merged text. orderId is raw-injected into the JSON body (17-digit id —
 *  JSON.stringify would survive, but Number()/parse round-trips would not;
 *  keep the raw-injection pattern the rest of the codebase uses). */
async function writeBookingMemo(clientKey: string, billId: string, memo: string): Promise<boolean> {
  const token = await getPublicBookingToken(clientKey);
  const res = await fetch(`${BMI_PUBLIC_API_URL}/public-booking/${clientKey}/booking/memo`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "BMI-Subscription-Key": BMI_SUB_KEY,
      "Content-Type": "application/json",
      "Accept-Language": "en",
    },
    body: `{"orderId":${billId},"memo":${JSON.stringify(memo)}}`,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.warn(`[bmi-office] booking/memo write failed: ${res.status}`);
  }
  return res.ok;
}

// ── Update project product price ───────────────────────────────────

export async function updateProjectProduct(params: {
  centerCode: string;
  projectId: string;
  productId: string;
  projectProductId: string;
  productName: string;
  pricePerUnit: number;
}): Promise<void> {
  const clientKey = CLIENT_KEYS[params.centerCode] || "headpinzftmyers";
  const token = await getOfficeToken(clientKey);
  const headers = apiHeaders(token, clientKey);

  const body = JSON.stringify({
    projectId: params.projectId,
    productId: params.productId,
    id: params.projectProductId,
    quantity: 1,
    pricePerUnit: params.pricePerUnit,
    totalPrice: params.pricePerUnit,
    isVisible: true,
    discountMetaId: null,
    name: null,
    dynamicGroups: null,
  });

  const res = await httpsRequest("PUT", `/api/${clientKey}/projectProduct`, headers, body);
  if (res.status >= 400) {
    throw new Error(`Failed to update projectProduct: ${res.status} ${res.body.slice(0, 200)}`);
  }

  console.log(
    `[bmi-office] updated service charge for project ${params.projectId}: ${params.productName} → $${params.pricePerUnit.toFixed(2)}`,
  );
}

// ── Helper: detect waiver-required activities ───────────────────────

export function hasWaiverRequiredActivities(lineItems: Array<{ name: string }>): boolean {
  return lineItems.some((item) =>
    WAIVER_ACTIVITIES.some((w) => item.name.toLowerCase().includes(w)),
  );
}

// ── Single point: BMI side-effects when a group-function payment is collected ──
//
// EVERY path that collects money for a group function (deposit, 72h balance auto-charge,
// web /pay, re-sign reprice delta) must call this so BMI stays in sync. Historically only
// the deposit route confirmed + recorded the payment, so balance/delta collections left
// the event on "Pending Signed Contract" and showing a balance still owed in BMI
// (JW Marriott, 2026-06-22). Keep this the ONE place that does it — new payment paths call
// this instead of re-implementing updateProjectStatus + recordProjectPayment and dropping
// a step. Fully non-fatal: a BMI hiccup never fails the (already-captured) Square payment.
export async function confirmAndRecordBmiPayment(params: {
  centerCode: string;
  projectId: string;
  lineItems: Array<{ name: string }>;
  /** Dollars collected on THIS payment (deposit, balance, or reprice delta). <=0 skips. */
  amountDollars: number;
  /** Optional private-note line (path-specific context: GAN, "balance", "delta", etc.). */
  note?: string;
  contractUrl?: string;
  /** Which flow is calling — tags the retry row so the sweep and the admin board
   *  can tell a deposit from an auto-charged balance. */
  source?: ProjectPaymentFailureSource;
  /** GF quote id, so a queued retry can recompute the true gap from
   *  `collected_cents` rather than trusting the amount we were handed. */
  quoteId?: number | null;
  /** Stable per-payment reference for the retry queue's idempotency key —
   *  the Square payment id where the caller has one. */
  sourceRef?: string;
}): Promise<void> {
  // Each step is isolated. Previously a single try wrapped all three, so a
  // failing state update silently skipped the payment AND the note — the widest
  // possible blast radius from the narrowest failure.
  try {
    await updateProjectStatus({
      centerCode: params.centerCode,
      projectId: params.projectId,
      hasWaiverActivities: hasWaiverRequiredActivities(params.lineItems),
    });
  } catch (err) {
    console.error(`[bmi-office] project state update failed for ${params.projectId}:`, err);
  }

  if (params.amountDollars > 0) {
    const amountCents = Math.round(params.amountDollars * 100);
    try {
      await recordProjectPayment({
        centerCode: params.centerCode,
        projectId: params.projectId,
        amountDollars: params.amountDollars,
      });
    } catch (err) {
      // The card is already charged. Never throw — but never drop it either:
      // queue it so the sweep posts it once BMI is healthy again.
      console.error(
        `[bmi-office] recordProjectPayment failed for project ${params.projectId}:`,
        err,
      );
      try {
        const { enqueueProjectPaymentFailure } = await import("@/lib/bmi-project-payment-retry");
        await enqueueProjectPaymentFailure({
          source: params.source ?? "manual",
          sourceRef: params.sourceRef ?? `project-${params.projectId}-${amountCents}`,
          quoteId: params.quoteId ?? null,
          centerCode: params.centerCode,
          projectId: params.projectId,
          amountCents,
          initialError: err instanceof Error ? err.message.slice(0, 300) : String(err),
        });
      } catch (enqueueErr) {
        console.error(`[bmi-office] could not queue unposted payment:`, enqueueErr);
      }
    }
  }

  if (params.note) {
    try {
      await appendProjectPrivateNote({
        centerCode: params.centerCode,
        projectId: params.projectId,
        note: `[${noteTimestamp()}] ${params.note}`,
        contractUrl: params.contractUrl,
      });
    } catch (err) {
      console.error(`[bmi-office] private note failed for project ${params.projectId}:`, err);
    }
  }
}
