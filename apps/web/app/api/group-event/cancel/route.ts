import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { randomUUID } from "crypto";
import { getGroupEvent } from "@/lib/group-events";

/**
 * Cancel a group-event reservation via the BMI Office API.
 *
 * POST { slug, billId }
 *
 * Flow:
 *   1. GET /api/{ck}/project/{billId}   → full project entity
 *   2. Extract personId(s) from project  (saved so guest keeps waiver link on rebook)
 *   3. PUT /api/{ck}/project             → same entity with stateId: "-4" (Cancelled)
 *   4. Return { ok, personId }
 */

const OFFICE_HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const OFFICE_PASS = Buffer.from(OFFICE_PASS_B64, "base64").toString();
const SMS_VERSION = "6251006 202511051229";
const STATE_CANCELLED = "-4";

// ── HTTPS helpers (same pattern as bmi-office/route.ts) ────────────────────

function httpsGet(
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
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

function httpsRequest(
  method: string,
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: OFFICE_HOST,
        path,
        method,
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.write(body);
    req.end();
  });
}

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getOfficeToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  const body = `grant_type=password&username=${OFFICE_USER}&password=${OFFICE_PASS}`;
  const res = await httpsRequest("POST", "/auth/token", body, {
    "Content-Type": "application/x-www-form-urlencoded",
    clientkey: CLIENT_KEY,
    "x-fast-version": SMS_VERSION,
  });
  if (res.status !== 200) throw new Error(`Office auth failed: ${res.status}`);
  const data = JSON.parse(res.body);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + parseInt(data.expires_in || "86400", 10) * 1000;
  return cachedToken!;
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    clientkey: CLIENT_KEY,
    "Content-Type": "application/json",
  };
}

/** Extract person IDs from a BMI project entity.
 *  The Office API project may contain contactPersonId, projectPersons, etc.
 *  We look in multiple places to be defensive. */
function extractPersonId(project: Record<string, unknown>): string | null {
  // projectPersons is an array of { personId, ... } objects
  const persons = project.projectPersons as { personId?: number | string }[] | undefined;
  if (Array.isArray(persons) && persons.length > 0 && persons[0].personId) {
    return String(persons[0].personId);
  }
  // contactPersonId is set when registerContactPerson was called
  if (project.contactPersonId && String(project.contactPersonId) !== "0") {
    return String(project.contactPersonId);
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { slug, billId } = await req.json();
    if (!slug || !billId) {
      return NextResponse.json({ error: "slug and billId required" }, { status: 400 });
    }

    const event = getGroupEvent(slug);
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    const token = await getOfficeToken();
    const headers = apiHeaders(token);

    // 1. GET the full project entity — billId is the raw string
    const getRes = await httpsGet(`/api/${CLIENT_KEY}/project/${billId}`, headers);
    if (getRes.status !== 200) {
      console.error(`[group-cancel] GET project ${billId} failed: ${getRes.status}`);
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const project = JSON.parse(getRes.body);

    // 2. Extract personId before we cancel — caller stores it for rebook
    const personId = extractPersonId(project);
    console.log(`[group-cancel] project ${billId}: personId=${personId || "none"}`);

    // Already cancelled?
    if (String(project.stateId) === STATE_CANCELLED) {
      return NextResponse.json({ ok: true, personId, alreadyCancelled: true });
    }

    // 3. PUT back with stateId → Cancelled
    project.stateId = STATE_CANCELLED;
    const putRes = await httpsRequest(
      "PUT",
      `/api/${CLIENT_KEY}/project`,
      JSON.stringify(project),
      headers,
    );

    if (putRes.status !== 200) {
      console.error(
        `[group-cancel] PUT project ${billId} failed: ${putRes.status} ${putRes.body.substring(0, 200)}`,
      );
      return NextResponse.json({ error: "Failed to cancel" }, { status: 500 });
    }

    console.log(`[group-cancel] cancelled project ${billId} (${CLIENT_KEY})`);
    return NextResponse.json({ ok: true, personId });
  } catch (err) {
    console.error("[group-cancel] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cancel failed" },
      { status: 500 },
    );
  }
}
