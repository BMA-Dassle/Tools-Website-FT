/**
 * Cancel a BMI (race/attraction) reservation server-side.
 *
 * Two mechanisms, tried in order:
 *  1. Public-booking `DELETE bill/{orderId}/cancel` — works ONLY for bills
 *     that never reached payment/confirm (lesson 2026-05-11). Cheap first
 *     attempt; covers confirm_pending rows.
 *  2. Office/Pandora project state → -4 (Cancellation) via setProjectState —
 *     the only working cancel for CONFIRMED projects (same mechanism as
 *     lib/bmi-attraction-cancel.ts). Runs as Office user API2, so
 *     userUpdatedId ≠ -1 and the bmi-cancel-sweep recovery cron treats it as
 *     an intentional cancel (its other gate — the Neon row being marked
 *     cancelled — is also satisfied, since the cascade marks Neon first).
 *
 * Project resolution: BMI's orderId (our bmi_bill_id) is NOT the projectId.
 * The W-number search (`/search?token={W} → kind===2 → localId`) is the
 * authoritative resolver (verifyPostConfirm pattern); the order id itself is
 * the fallback — the Office API resolves projects at the order id for the
 * attraction-cancel path in production.
 *
 * BMI ids exceed MAX_SAFE_INTEGER: every Office body goes through
 * parseWithRawIds; ids stay strings end-to-end (only stateId/userUpdatedId —
 * small enums — are read).
 */
import https from "https";
import { randomUUID } from "crypto";
import { parseWithRawIds } from "@ft/db";
import { setProjectState } from "@/lib/bmi-office-actions";

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const OFFICE_PASS = Buffer.from(OFFICE_PASS_B64, "base64").toString();
const SMS_VERSION = "6251006 202511051229";

export interface BmiCancelResult {
  ok: boolean;
  method: "public_delete" | "office_state" | "already_cancelled" | "unresolved";
  projectId?: string;
  verifiedStateId?: string;
  userUpdatedId?: string;
  detail?: string;
}

// ── Public-booking token (per client key) ────────────────────────────────────

const publicTokenCache: Record<string, { token: string; expiry: number }> = {};
async function getPublicToken(clientKey: string): Promise<string> {
  const c = publicTokenCache[clientKey];
  if (c && Date.now() < c.expiry - 60_000) return c.token;
  const res = await fetch(`${BMI_API_URL}/auth/${clientKey}/publicbooking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "BMI-Subscription-Key": BMI_SUB_KEY },
    body: JSON.stringify({ Username: BMI_USERNAME, Password: BMI_PASSWORD }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`BMI public auth ${res.status}`);
  const d = await res.json();
  publicTokenCache[clientKey] = {
    token: d.AccessToken || d.accessToken,
    expiry: Date.now() + parseInt(d.ExpiresIn || d.expiresIn || "3600", 10) * 1000,
  };
  return publicTokenCache[clientKey].token;
}

// ── Office API plumbing (Node https — undici fails against this API) ────────

function officeGet(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: OFFICE_HOST, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error("Office API timeout"));
    });
  });
}

const officeTokenCache: Record<string, { token: string; expiry: number }> = {};
async function getOfficeToken(clientKey: string): Promise<string> {
  const cached = officeTokenCache[clientKey];
  if (cached && Date.now() < cached.expiry - 60_000) return cached.token;
  const body = `grant_type=password&username=${OFFICE_USER}&password=${OFFICE_PASS}`;
  const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = https.request(
      {
        hostname: OFFICE_HOST,
        path: "/auth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(Buffer.byteLength(body)),
          clientkey: clientKey,
          "x-fast-version": SMS_VERSION,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error("Office auth timeout"));
    });
    req.write(body);
    req.end();
  });
  if (res.status !== 200) throw new Error(`Office auth failed (${clientKey}): ${res.status}`);
  const data = JSON.parse(res.body);
  officeTokenCache[clientKey] = {
    token: data.access_token,
    expiry: Date.now() + parseInt(data.expires_in || "86400", 10) * 1000,
  };
  return officeTokenCache[clientKey].token;
}

function officeHeaders(token: string, clientKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    clientkey: clientKey,
  };
}

interface ProjectState {
  stateId?: string;
  userUpdatedId?: string;
  number?: string;
}

async function getProjectState(
  clientKey: string,
  headers: Record<string, string>,
  projectId: string,
): Promise<{ status: number; project: ProjectState | null }> {
  const res = await officeGet(`/api/${clientKey}/project/${projectId}`, headers);
  if (res.status >= 400) return { status: res.status, project: null };
  const p = parseWithRawIds<{ stateId?: unknown; userUpdatedId?: unknown; number?: unknown }>(
    res.body,
  );
  return {
    status: res.status,
    project: {
      stateId: p.stateId != null ? String(p.stateId) : undefined,
      userUpdatedId: p.userUpdatedId != null ? String(p.userUpdatedId) : undefined,
      number: p.number != null ? String(p.number) : undefined,
    },
  };
}

// ── The cancel ───────────────────────────────────────────────────────────────

export async function cancelBmiProject(params: {
  /** From resolveCenter — race projects live under the FastTrax location. */
  pandoraStateSlug: string;
  bmiClientKey: string;
  /** RAW string bill/order id — never Number()'d anywhere in this module. */
  bmiBillId: string;
  bmiReservationNumber?: string;
}): Promise<BmiCancelResult> {
  const { bmiClientKey: ck, bmiBillId } = params;

  // 1. Cheap first attempt — only succeeds for never-confirmed bills.
  try {
    const token = await getPublicToken(ck);
    const res = await fetch(`${BMI_API_URL}/public-booking/${ck}/bill/${bmiBillId}/cancel`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "BMI-Subscription-Key": BMI_SUB_KEY,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });
    const text = (await res.text()).trim();
    if (res.ok && text === "true") {
      console.log(`[bmi-cancel] public delete ok bill=${bmiBillId}`);
      return { ok: true, method: "public_delete" };
    }
    console.log(
      `[bmi-cancel] public delete declined bill=${bmiBillId} (${res.status}/${text.slice(0, 40)}) — using Office state`,
    );
  } catch (err) {
    console.warn(
      `[bmi-cancel] public delete errored bill=${bmiBillId} (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  }

  // 2. Resolve the projectId — W-number search first, order id fallback.
  const token = await getOfficeToken(ck);
  const headers = officeHeaders(token, ck);
  let projectId: string | undefined;
  let project: ProjectState | null = null;

  if (params.bmiReservationNumber) {
    try {
      const searchRes = await officeGet(
        `/api/${ck}/search?token=${encodeURIComponent(params.bmiReservationNumber)}&maxResults=3`,
        headers,
      );
      if (searchRes.status < 400) {
        const results = parseWithRawIds<Array<{ kind?: number; localId?: unknown }>>(
          searchRes.body,
        );
        const hit = Array.isArray(results) ? results.find((r) => r?.kind === 2) : null;
        if (hit?.localId != null) projectId = String(hit.localId);
      }
    } catch (err) {
      console.warn(
        `[bmi-cancel] W-number search failed for ${params.bmiReservationNumber}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const candidates = [...new Set([projectId, bmiBillId].filter((v): v is string => !!v))];
  for (const candidate of candidates) {
    const got = await getProjectState(ck, headers, candidate);
    if (got.project) {
      // When we know the W-number, require it to match before trusting an
      // order-id-resolved project (guards against BMI's orderId≠projectId drift).
      if (
        params.bmiReservationNumber &&
        got.project.number &&
        got.project.number !== params.bmiReservationNumber
      ) {
        console.warn(
          `[bmi-cancel] project ${candidate} number=${got.project.number} ≠ ${params.bmiReservationNumber} — skipping candidate`,
        );
        continue;
      }
      projectId = candidate;
      project = got.project;
      break;
    }
  }

  if (!projectId || !project) {
    return {
      ok: false,
      method: "unresolved",
      detail:
        `BMI project for bill ${bmiBillId}` +
        `${params.bmiReservationNumber ? ` / ${params.bmiReservationNumber}` : ""} could not be resolved — cancel it in BMI manually.`,
    };
  }

  if (project.stateId === "-4") {
    console.log(`[bmi-cancel] project ${projectId} already at -4 — done`);
    return {
      ok: true,
      method: "already_cancelled",
      projectId,
      verifiedStateId: "-4",
      userUpdatedId: project.userUpdatedId,
    };
  }

  // 3. State → -4 (Pandora first, Office PUT fallback — both as user API2).
  await setProjectState({
    centerCode: params.pandoraStateSlug,
    projectId,
    stateId: "-4",
    label: "reservation cancelled (cascade)",
  });

  // 4. Verify + record the writer for sweep-safety evidence.
  const after = await getProjectState(ck, headers, projectId);
  const verifiedStateId = after.project?.stateId;
  const userUpdatedId = after.project?.userUpdatedId;
  if (verifiedStateId !== "-4") {
    return {
      ok: false,
      method: "office_state",
      projectId,
      verifiedStateId,
      userUpdatedId,
      detail: `state write did not stick (now ${verifiedStateId ?? "?"}) — verify in BMI`,
    };
  }
  if (userUpdatedId === "-1") {
    // Should be impossible (we write as API2/Pandora) — but if BMI ever
    // reports the system writer, the Neon cancelled-record gate still keeps
    // the sweep from reverting us. Log it as evidence.
    console.warn(`[bmi-cancel] project ${projectId} shows userUpdatedId=-1 after our write`);
  }
  console.log(
    `[bmi-cancel] project ${projectId} → -4 verified (userUpdatedId=${userUpdatedId ?? "?"})`,
  );
  return { ok: true, method: "office_state", projectId, verifiedStateId, userUpdatedId };
}
