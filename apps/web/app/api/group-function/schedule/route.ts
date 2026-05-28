import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { randomUUID } from "crypto";
import { getGfQuoteByShortId } from "@/lib/group-function-db";

/**
 * Fetch the event schedule from BMI Office for a group function quote.
 *
 * GET /api/group-function/schedule?shortId=...
 *
 * Returns a timeline of scheduled activities with resource names and times.
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
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

let cachedToken: string | null = null;
let tokenExpiry = 0;
let tokenClientKey = "";

async function getOfficeToken(clientKey: string): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000 && tokenClientKey === clientKey) {
    return cachedToken;
  }
  const body = `grant_type=password&username=${OFFICE_USER}&password=${OFFICE_PASS}`;
  const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const postData = Buffer.from(body, "utf-8");
    const req = https.request(
      {
        hostname: OFFICE_HOST,
        path: "/auth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": postData.length,
          clientkey: clientKey,
          "x-fast-version": SMS_VERSION,
        },
      },
      (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => resolve({ status: r.statusCode || 500, body: d }));
      },
    );
    req.on("error", reject);
    req.end(postData);
  });
  if (res.status !== 200) throw new Error(`Office auth failed: ${res.status}`);
  const data = JSON.parse(res.body);
  cachedToken = data.access_token;
  tokenClientKey = clientKey;
  tokenExpiry = Date.now() + parseInt(data.expires_in || "86400", 10) * 1000;
  return cachedToken!;
}

function apiHeaders(token: string, clientKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    clientkey: clientKey,
  };
}

interface BmiSchedule {
  resourceId: string;
  resourceGroupId: string | null;
  start: string;
  stop: string;
  persons: number;
}

interface BmiResource {
  id: string;
  name: string;
  shortName: string;
  kind: number;
}

interface BmiResourceGroup {
  id: string;
  name: string;
  shortName: string;
  kind: number;
  resources: BmiResource[];
}

let metadataCache: {
  key: string;
  data: { resourceGroups: BmiResourceGroup[]; resources: BmiResource[] };
  expires: number;
} | null = null;

export async function GET(req: NextRequest) {
  const shortId = req.nextUrl.searchParams.get("shortId");
  if (!shortId) {
    return NextResponse.json({ error: "shortId required" }, { status: 400 });
  }

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  const clientKey = CENTER_CLIENT_KEYS[quote.center_code] || "headpinzftmyers";

  try {
    const token = await getOfficeToken(clientKey);
    const headers = apiHeaders(token, clientKey);

    // Fetch project
    const projRes = await httpsGet(
      `/api/${clientKey}/project/${quote.bmi_reservation_id}`,
      headers,
    );
    if (projRes.status >= 400) {
      return NextResponse.json({ error: "Failed to fetch project" }, { status: 502 });
    }
    const project = JSON.parse(projRes.body);
    const schedules: BmiSchedule[] = project.schedules || [];

    if (schedules.length === 0) {
      return NextResponse.json({ schedule: [] });
    }

    // Fetch metadata (cached 5 min)
    let resourceGroups: BmiResourceGroup[] = [];
    let standaloneResources: BmiResource[] = [];

    if (metadataCache && metadataCache.key === clientKey && Date.now() < metadataCache.expires) {
      resourceGroups = metadataCache.data.resourceGroups;
      standaloneResources = metadataCache.data.resources;
    } else {
      const metaRes = await httpsGet(`/api/${clientKey}/metadata`, headers);
      if (metaRes.status < 400) {
        const meta = JSON.parse(metaRes.body);
        resourceGroups = meta.resourceGroups || [];
        standaloneResources = meta.resources || [];
        metadataCache = {
          key: clientKey,
          data: { resourceGroups, resources: standaloneResources },
          expires: Date.now() + 5 * 60_000,
        };
      }
    }

    // Build resource ID → name lookup
    const resourceNames: Record<string, string> = {};
    const groupNames: Record<string, string> = {};
    for (const rg of resourceGroups) {
      groupNames[rg.id] = rg.name;
      for (const r of rg.resources || []) {
        resourceNames[r.id] = r.name;
      }
    }
    for (const r of standaloneResources) {
      resourceNames[r.id] = r.name;
    }

    // Group schedules by resourceGroup + time window
    const grouped: Record<
      string,
      { groupName: string; resourceCount: number; start: string; stop: string; persons: number }
    > = {};
    for (const s of schedules) {
      const key = `${s.resourceGroupId || s.resourceId}-${s.start}-${s.stop}`;
      if (!grouped[key]) {
        const gName = s.resourceGroupId
          ? groupNames[s.resourceGroupId] || resourceNames[s.resourceId] || "Activity"
          : resourceNames[s.resourceId] || "Activity";
        grouped[key] = {
          groupName: gName.replace(/^GF\s+/i, ""),
          resourceCount: 0,
          start: s.start,
          stop: s.stop,
          persons: s.persons,
        };
      }
      grouped[key].resourceCount++;
      if (s.persons > grouped[key].persons) grouped[key].persons = s.persons;
    }

    // Sort by start time
    const timeline = Object.values(grouped)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((g) => ({
        activity: g.groupName,
        count: g.resourceCount,
        start: formatTime(g.start),
        end: formatTime(g.stop),
        startRaw: g.start,
        endRaw: g.stop,
        persons: g.persons,
      }));

    return NextResponse.json({ schedule: timeline });
  } catch (err) {
    console.error("[group-function/schedule]", err);
    return NextResponse.json({ error: "Failed to load schedule" }, { status: 500 });
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/New_York",
    });
  } catch {
    return iso;
  }
}
