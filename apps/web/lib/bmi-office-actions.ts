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
    if (pandoraRes.ok) {
      console.log(
        `[bmi-office] project ${params.projectId} state → ${params.stateId} via Pandora${params.label ? ` (${params.label})` : ""}`,
      );
      return;
    }
    console.warn(
      `[bmi-office] Pandora state update failed (${pandoraRes.status}), falling back to Office API`,
    );
  } catch (err) {
    console.warn("[bmi-office] Pandora state update error, falling back to Office API:", err);
  }

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
    `[bmi-office] project ${params.projectId} state → ${params.stateId}${params.label ? ` (${params.label})` : ""}`,
  );
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
    if (pandoraRes.ok) {
      console.log(`[bmi-office] updated public notes for project ${params.projectId} via Pandora`);
      return;
    }
    console.warn(
      `[bmi-office] Pandora public-notes update failed (${pandoraRes.status}), falling back to Office API`,
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
}): Promise<void> {
  // Private notes are a ROLLING LOG. Pandora /memo/private REPLACES the memo (it
  // does NOT append server-side), so sending just the new line wiped prior
  // entries and any staff-typed notes. We accumulate client-side: read the
  // current memo, merge the new entry, then write the FULL merged text.
  // (Public notes are intentionally replace-only — see updateProjectPublicNotes.)
  // projectId is a string (bmi_reservation_id is TEXT) — JSON.stringify is
  // precision-safe; never Number() it.
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
    return;
  }

  // 2. Merge the new entry into the existing memo (preserves staff text + prior
  //    system entries).
  const mergedMemo = mergePrivateMemo(
    privateLog?.memo || "",
    params.note,
    params.contractUrl || null,
    params.pdfUrl || null,
  );

  // 3. Primary write: Pandora /memo/private with the FULL merged memo (replace,
  //    now carrying the accumulated text).
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
    if (pandoraRes.ok) {
      console.log(`[bmi-office] appended private note for project ${params.projectId} via Pandora`);
      return;
    }
    console.warn(
      `[bmi-office] Pandora private-note write failed (${pandoraRes.status}), falling back to Office API`,
    );
  } catch (err) {
    console.warn("[bmi-office] Pandora private-note write error, falling back to Office API:", err);
  }

  // 4. Fallback: Office API PUT the merged memo into the private log (create it
  //    if none exists). Reuses the project + logs read in step 1.
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

  console.log(`[bmi-office] appended private note for project ${params.projectId} via Office API`);
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
