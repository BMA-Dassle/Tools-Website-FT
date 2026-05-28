import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { randomUUID } from "crypto";
import { getGfQuoteByShortId } from "@/lib/group-function-db";
import { fetchPersonsByIds } from "@/lib/bmi-office-actions";

/**
 * Live event details from BMI Office for the post-deposit event page.
 *
 * GET /api/group-function/event-details?shortId=...
 *
 * Returns: planner notes (live), waiver URL, participant list, schedule.
 * Caches person lookups in Redis (5-min TTL) to avoid hammering BMI Office.
 */

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const OFFICE_PASS = Buffer.from(OFFICE_PASS_B64, "base64").toString();
const SMS_VERSION = "6251006 202511051229";

const CENTER_CLIENT_KEYS: Record<string, string> = {
  "fort-myers": "headpinzftmyers",
  fasttrax: "headpinzftmyers",
  naples: "headpinznaples",
};

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
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

let cachedToken: string | null = null;
let tokenExpiry = 0;
let tokenClientKey = "";

async function getOfficeToken(clientKey: string): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000 && tokenClientKey === clientKey) return cachedToken;
  const body = `grant_type=password&username=${OFFICE_USER}&password=${OFFICE_PASS}`;
  const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const postData = Buffer.from(body, "utf-8");
    const r = https.request(
      { hostname: OFFICE_HOST, path: "/auth/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": postData.length, clientkey: clientKey, "x-fast-version": SMS_VERSION } },
      (resp) => { let d = ""; resp.on("data", (c) => (d += c)); resp.on("end", () => resolve({ status: resp.statusCode || 500, body: d })); },
    );
    r.on("error", reject);
    r.end(postData);
  });
  if (res.status !== 200) throw new Error(`Office auth failed: ${res.status}`);
  const data = JSON.parse(res.body);
  cachedToken = data.access_token;
  tokenClientKey = clientKey;
  tokenExpiry = Date.now() + parseInt(data.expires_in || "86400", 10) * 1000;
  return cachedToken!;
}

function apiHeaders(token: string, clientKey: string) {
  return { Authorization: `Bearer ${token}`, "x-fast-version": SMS_VERSION, "x-session-id": randomUUID(), clientkey: clientKey };
}

export async function GET(req: NextRequest) {
  const shortId = req.nextUrl.searchParams.get("shortId");
  if (!shortId) return NextResponse.json({ error: "shortId required" }, { status: 400 });

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const clientKey = CENTER_CLIENT_KEYS[quote.center_code] || "headpinzftmyers";

  try {
    const token = await getOfficeToken(clientKey);
    const headers = apiHeaders(token, clientKey);

    const projRes = await httpsGet(`/api/${clientKey}/project/${quote.bmi_reservation_id}`, headers);
    if (projRes.status >= 400) return NextResponse.json({ error: "Failed to fetch project" }, { status: 502 });
    const project = JSON.parse(projRes.body);

    // Notes — public log, most recent
    const publicLog = (project.logs || []).find((l: { public: boolean }) => l.public);
    const notes = publicLog?.memo || quote.notes || "";

    // Waiver URL
    const waiverUrl = project.projectReference
      ? `https://kiosk.sms-timing.com/${clientKey}/subscribe/event?id=${encodeURIComponent(project.projectReference)}`
      : null;

    // Participants — batch lookup via personsByIds
    const projectPersons: Array<{ personId: string; confirmed: string | null }> = project.projectPersons || [];
    const personIds = projectPersons.slice(0, 100).map((p) => p.personId);
    const persons = await fetchPersonsByIds(quote.center_code, personIds);
    const personMap = new Map(persons.map((p) => [p.id, p]));
    const participants = projectPersons.slice(0, 100).map((pp) => {
      const person = personMap.get(pp.personId);
      return {
        name: person ? `${person.firstName} ${person.lastName}`.trim() : "Guest",
        confirmed: Boolean(pp.confirmed),
        confirmedAt: pp.confirmed || null,
      };
    });

    // Schedule
    const schedules: Array<{ resourceId: string; resourceGroupId: string | null; start: string; stop: string; persons: number }> = project.schedules || [];

    return NextResponse.json({
      notes,
      waiverUrl,
      participants,
      totalParticipants: projectPersons.length,
      confirmedCount: projectPersons.filter((p) => p.confirmed).length,
      eventName: project.name || quote.event_name,
      eventDate: project.date || quote.event_date,
      guestCount: project.persons || quote.guest_count,
      scheduleCount: schedules.length,
    });
  } catch (err) {
    console.error("[event-details]", err);
    return NextResponse.json({ error: "Failed to load event details" }, { status: 500 });
  }
}

