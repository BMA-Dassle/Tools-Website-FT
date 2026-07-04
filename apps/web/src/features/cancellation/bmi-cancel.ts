/**
 * Cancel a BMI (race/attraction) reservation server-side.
 *
 * The PROJECT is the source of truth — it is what the dayplanner shows, what
 * holds the heat capacity, and what staff see as Confirmation. So the cancel
 * is: resolve the Office project (W-number search → kind===2 → localId; the
 * order id as fallback) and drive it to -4 via setProjectState (Pandora →
 * Office, as user API2 so the bmi-cancel-sweep treats it as intentional).
 *
 * The public-booking `DELETE bill/{orderId}/cancel` is ONLY a supplementary
 * bill-record cleanup, and the primary path ONLY for bills that never
 * confirmed (no project exists yet). PROVEN 2026-07-03 (bills
 * 63000000004148142/…180): on a CONFIRMED bill the public delete returns
 * `true`, deletes the BILL record (a "Cancellation" row appears in the BMI
 * UI — looks like success!) — but the real project stays Confirmation and
 * keeps the slot. Treating that `true` as terminal was exactly the first
 * live bug of this cascade. Never short-circuit on it.
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

  // 1. Resolve the PROJECT — W-number search first, order id fallback. The
  //    project is the source of truth; the public bill delete NEVER comes
  //    first (on confirmed bills it returns `true` while the project lives on
  //    — the 2026-07-03 W47613/W47615 incident).
  let officeErr: string | undefined;
  let projectId: string | undefined;
  let project: ProjectState | null = null;
  let headers: Record<string, string> | null = null;
  try {
    const token = await getOfficeToken(ck);
    headers = officeHeaders(token, ck);
  } catch (err) {
    officeErr = err instanceof Error ? err.message : String(err);
    console.warn(`[bmi-cancel] Office auth failed for bill=${bmiBillId}:`, officeErr);
  }

  if (headers && params.bmiReservationNumber) {
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

  if (headers) {
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
  }

  // 2. No project resolvable → this bill (probably) never confirmed. The
  //    public bill delete IS the real cancel for that shape.
  if (!projectId || !project) {
    const deleted = await publicBillDelete(ck, bmiBillId);
    if (deleted) {
      console.log(`[bmi-cancel] no project; public delete ok bill=${bmiBillId}`);
      return { ok: true, method: "public_delete" };
    }
    return {
      ok: false,
      method: "unresolved",
      detail:
        `BMI project for bill ${bmiBillId}` +
        `${params.bmiReservationNumber ? ` / ${params.bmiReservationNumber}` : ""} could not be resolved` +
        `${officeErr ? ` (Office: ${officeErr})` : ""} and the public bill delete declined — cancel it in BMI manually.`,
    };
  }

  if (project.stateId === "-4") {
    console.log(`[bmi-cancel] project ${projectId} already at -4 — done`);
    void publicBillDelete(ck, bmiBillId); // bill-record cleanup, best-effort
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

  // 4. Verify + record the writer for sweep-safety evidence. Pandora's write
  //    lands ASYNCHRONOUSLY — the 2026-07-03 remediation read back -3 for a
  //    few seconds before flipping — so poll briefly before declaring failure.
  let verifiedStateId: string | undefined;
  let userUpdatedId: string | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    const after = await getProjectState(ck, headers!, projectId);
    verifiedStateId = after.project?.stateId;
    userUpdatedId = after.project?.userUpdatedId;
    if (verifiedStateId === "-4") break;
  }
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

  // 5. Bill-record cleanup (best-effort): removes the still-live bill record
  //    so the BMI reservations list shows the cancellation everywhere. Never
  //    affects the result — the project (-4) is what matters.
  void publicBillDelete(ck, bmiBillId);

  return { ok: true, method: "office_state", projectId, verifiedStateId, userUpdatedId };
}

/**
 * Public-booking `DELETE bill/{orderId}/cancel`. On a confirmed bill this
 * deletes the BILL record only (the project lives on) — which is why it is
 * cleanup/fallback, never the primary cancel. Returns whether BMI reported
 * `true`.
 */
async function publicBillDelete(ck: string, bmiBillId: string): Promise<boolean> {
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
    const ok = res.ok && text === "true";
    console.log(
      `[bmi-cancel] public bill delete bill=${bmiBillId}: ${ok ? "true" : `${res.status}/${text.slice(0, 40)}`}`,
    );
    return ok;
  } catch (err) {
    console.warn(
      `[bmi-cancel] public bill delete errored bill=${bmiBillId} (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
