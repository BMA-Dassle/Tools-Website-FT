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

// ── Update project status ───────────────────────────────────────────

export async function updateProjectStatus(params: {
  centerCode: string;
  projectId: string;
  hasWaiverActivities: boolean;
}): Promise<void> {
  const clientKey = CLIENT_KEYS[params.centerCode] || "headpinzftmyers";
  const newStateId = params.hasWaiverActivities ? WAIVER_STATE_IDS[clientKey] || "-3" : "-3";

  // Primary: Pandora direct Firebird update (bypasses overbooking validation)
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
        stateID: newStateId,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (pandoraRes.ok) {
      console.log(
        `[bmi-office] project ${params.projectId} status → ${newStateId} via Pandora (${params.hasWaiverActivities ? "Confirmation+Waiver" : "Confirmation"})`,
      );
      return;
    }
    console.warn(
      `[bmi-office] Pandora state update failed (${pandoraRes.status}), falling back to Office API`,
    );
  } catch (err) {
    console.warn("[bmi-office] Pandora state update error, falling back to Office API:", err);
  }

  // Fallback: Office API with minimal PUT
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
  minimal.stateId = newStateId;

  const putRes = await httpsRequest(
    "PUT",
    `/api/${clientKey}/project`,
    headers,
    JSON.stringify(minimal),
  );
  if (putRes.status >= 400) throw new Error(`Failed to update project status: ${putRes.status}`);

  console.log(
    `[bmi-office] project ${params.projectId} status → ${newStateId} (${params.hasWaiverActivities ? "Confirmation+Waiver" : "Confirmation"})`,
  );
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

  if (publicLog) {
    publicLog.memo = params.notes;
  }

  const minimal = toMinimalProject(project, ["logs"]);
  minimal.logs = logs;

  const putRes = await httpsRequest(
    "PUT",
    `/api/${clientKey}/project`,
    headers,
    JSON.stringify(minimal),
  );
  if (putRes.status >= 400) throw new Error(`Failed to update project notes: ${putRes.status}`);

  console.log(`[bmi-office] updated public notes for project ${params.projectId}`);
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
