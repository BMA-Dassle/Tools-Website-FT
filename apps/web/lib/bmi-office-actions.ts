import https from "https";
import { randomUUID } from "crypto";

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

// ── Minimal project payload (avoids overbooking validation on PUT) ──

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

// ── Pandora location IDs (for direct Firebird state updates) ───────

const PANDORA_LOCATION_IDS: Record<string, string> = {
  "fort-myers": "TXBSQN0FEKQ11",
  fasttrax: "LAB52GY480CJF",
  naples: "PPTR5G2N0QXF7",
};

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";

// ── Update project state (generic) ──────────────────────────────────

export async function setProjectState(params: {
  centerCode: string;
  projectId: string;
  stateId: string;
  label?: string;
}): Promise<void> {
  const clientKey = CLIENT_KEYS[params.centerCode] || "headpinzftmyers";
  const locationId = PANDORA_LOCATION_IDS[params.centerCode] || "TXBSQN0FEKQ11";

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
    if (getRes.status >= 400) throw new Error(`Failed to fetch project: ${getRes.status}`);
    const project = JSON.parse(getRes.body);
    const minimal = toMinimalProject(project);
    minimal.stateId = params.stateId;
    const putRes = await httpsRequest(
      "PUT",
      `/api/${clientKey}/project`,
      headers,
      JSON.stringify(minimal),
    );
    if (putRes.status >= 400) throw new Error(`Failed to update project status: ${putRes.status}`);
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
    try {
      await viaOfficeApi();
      return;
    } catch (err) {
      console.warn("[bmi-office] Office-API state update failed, trying Pandora:", err);
    }
    if (await viaPandora()) {
      console.log(
        `[bmi-office] project ${params.projectId} state → ${params.stateId} via Pandora (fallback)${params.label ? ` (${params.label})` : ""}`,
      );
      return;
    }
    throw new Error(`state ${params.stateId} update failed on both paths`);
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
  if (getRes.status >= 400) throw new Error(`Failed to fetch project: ${getRes.status}`);
  const project = JSON.parse(getRes.body);

  const minimal = toMinimalProject(project);
  minimal.name = params.name;
  minimal.displayName = params.name;

  const putRes = await httpsRequest(
    "PUT",
    `/api/${clientKey}/project`,
    headers,
    JSON.stringify(minimal),
  );
  if (putRes.status >= 400) throw new Error(`Failed to update project name: ${putRes.status}`);

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
    const putRes = await httpsRequest(
      "PUT",
      `/api/${clientKey}/project`,
      headers,
      JSON.stringify(minimal),
    );
    if (putRes.status >= 400) throw new Error(`Failed to update project notes: ${putRes.status}`);
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

function buildSection(contractUrl: string | null, pdfUrl: string | null, logLines: string): string {
  const links: string[] = [];
  if (contractUrl) links.push(`Contract: ${contractUrl}`);
  if (pdfUrl) links.push(`Signed PDF: ${pdfUrl}`);
  const header = links.length > 0 ? `${links.join("\n")}\n${NOTES_LINKS_MARKER}\n` : "";
  return `${NOTES_SECTION_START}\n${header}${logLines}\n${NOTES_SECTION_END}`;
}

function parseSection(section: string): {
  contractUrl: string | null;
  pdfUrl: string | null;
  logLines: string;
} {
  const markerIdx = section.indexOf(NOTES_LINKS_MARKER + "\n");
  if (markerIdx >= 0) {
    const header = section.slice(0, markerIdx).trim();
    const logLines = section.slice(markerIdx + NOTES_LINKS_MARKER.length + 1).trim();
    const contractMatch = header.match(/Contract:\s*(.+)/);
    const pdfMatch = header.match(/Signed PDF:\s*(.+)/);
    return {
      contractUrl: contractMatch?.[1]?.trim() || null,
      pdfUrl: pdfMatch?.[1]?.trim() || null,
      logLines,
    };
  }
  return { contractUrl: null, pdfUrl: null, logLines: section.trim() };
}

/**
 * Merge a new private-note entry into an existing private memo, keeping ALL
 * existing text — staff's own notes outside the section AND prior system
 * entries inside it — and appending the new line inside the
 * "── FastTrax Web ──" section. Returns the full merged memo.
 */
function mergePrivateMemo(
  existing: string,
  note: string,
  contractUrl: string | null,
  pdfUrl: string | null,
): string {
  const startIdx = existing.indexOf(NOTES_SECTION_START);
  const endIdx = existing.indexOf(NOTES_SECTION_END);

  if (startIdx >= 0 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + NOTES_SECTION_END.length);
    const sectionContent = existing.slice(startIdx + NOTES_SECTION_START.length, endIdx).trim();
    const parsed = parseSection(sectionContent);
    const url = contractUrl || parsed.contractUrl;
    const pdf = pdfUrl || parsed.pdfUrl;
    const updatedLog = parsed.logLines ? `${parsed.logLines}\n${note}` : note;
    return `${before}${buildSection(url, pdf, updatedLog)}${after}`;
  }

  const sep = existing.trim() ? "\n\n" : "";
  return `${existing}${sep}${buildSection(contractUrl, pdfUrl, note)}`;
}

export async function appendProjectPrivateNote(params: {
  centerCode: string;
  projectId: string;
  note: string;
  contractUrl?: string;
  pdfUrl?: string;
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
  const mergedMemo = mergePrivateMemo(
    privateLog?.memo || "",
    params.note,
    params.contractUrl || null,
    params.pdfUrl || null,
  );

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
      const putRes = await httpsRequest(
        "PUT",
        `/api/${clientKey}/project`,
        headers,
        JSON.stringify(minimal),
      );
      if (putRes.status >= 400) {
        throw new Error(`Failed to update private notes: ${putRes.status}`);
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
}): Promise<void> {
  try {
    await updateProjectStatus({
      centerCode: params.centerCode,
      projectId: params.projectId,
      hasWaiverActivities: hasWaiverRequiredActivities(params.lineItems),
    });
    if (params.amountDollars > 0) {
      await recordProjectPayment({
        centerCode: params.centerCode,
        projectId: params.projectId,
        amountDollars: params.amountDollars,
      });
    }
    if (params.note) {
      await appendProjectPrivateNote({
        centerCode: params.centerCode,
        projectId: params.projectId,
        note: `[${noteTimestamp()}] ${params.note}`,
        contractUrl: params.contractUrl,
      });
    }
  } catch (err) {
    console.error(
      `[bmi-office] confirmAndRecordBmiPayment failed for project ${params.projectId}:`,
      err,
    );
  }
}
