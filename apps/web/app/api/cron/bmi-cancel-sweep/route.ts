import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { verifyCron } from "@/lib/cron-auth";

/**
 * GET /api/cron/bmi-cancel-sweep
 *
 * BMI_AUTOCANCEL_WORKAROUND — remove when BMI fixes payment/confirm.
 *
 * Safety-net cron that scans the BMI Office dayplanner for online
 * reservations that have been cancelled (stateId=-4) despite having
 * an external online payment (payMethodId=42603617). Recovers them
 * by setting stateId back to -3 (Confirmation) via Pandora.
 *
 * Runs every 5 minutes. Non-destructive: setting -3 on an already-
 * confirmed project is a no-op.
 */

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "";
const OFFICE_PASS = OFFICE_PASS_B64
  ? Buffer.from(OFFICE_PASS_B64, "base64").toString()
  : process.env.BMI_OFFICE_PASSWORD || "";
const SMS_VERSION = "6251006 202511051229";
const CLIENT_KEY = "headpinzftmyers";
const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";
const PANDORA_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const PANDORA_LOCATION = "LAB52GY480CJF";

function officeReq(
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
      res.on("data", (c: string) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 500, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function getOfficeToken(): Promise<string> {
  const res = await officeReq(
    "POST",
    "/auth/token",
    {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: CLIENT_KEY,
      "x-fast-version": SMS_VERSION,
    },
    `grant_type=password&username=${OFFICE_USER}&password=${encodeURIComponent(OFFICE_PASS)}`,
  );
  if (res.status !== 200) throw new Error(`Office auth failed: ${res.status}`);
  return JSON.parse(res.body).access_token;
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const twoWeeksOut = new Date(now.getTime() + 14 * 86400000).toISOString().slice(0, 10);

  const token = await getOfficeToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": `sweep-${Date.now()}`,
    clientkey: CLIENT_KEY,
  };

  // Get all resource IDs
  const metaRes = await officeReq("GET", `/api/${CLIENT_KEY}/metadata`, headers);
  if (metaRes.status >= 400) {
    return NextResponse.json({ error: "metadata failed" }, { status: 502 });
  }
  const meta = JSON.parse(metaRes.body);
  const ids = new Set<string>();
  for (const r of (meta.resources || []) as Array<{ id: string }>) ids.add(String(r.id));
  for (const g of (meta.resourceGroups || []) as Array<{ resources?: Array<{ id: string }> }>) {
    for (const r of g.resources || []) ids.add(String(r.id));
  }
  const resourceParam = [...ids].map((id) => `resourceIds=${id}`).join("&");

  // Scan dayplanner
  const dpRes = await officeReq(
    "GET",
    `/api/${CLIENT_KEY}/dayPlanner?${resourceParam}&from=${today}&till=${twoWeeksOut}&showAll=true`,
    headers,
  );
  if (dpRes.status >= 400) {
    return NextResponse.json({ error: "dayplanner failed" }, { status: 502 });
  }

  interface DpProject {
    id: string;
    number: string;
    name: string | null;
    displayName: string | null;
    stateId: string;
    kindId: string;
    personId: string;
    date: string;
    persons: number;
  }

  const dp = JSON.parse(dpRes.body);
  const projects: DpProject[] = dp.reservations?.projects || [];

  // Filter: cancelled + named + future
  const cutoff = new Date(today + "T00:00:00");
  const cancelled = projects.filter((p) => {
    if (String(p.stateId) !== "-4") return false;
    const name = (p.name || p.displayName || "").trim();
    if (name === "Online" || name === "") return false;
    if (String(p.personId) === "-6") return false;
    return new Date(p.date) >= cutoff;
  });

  // Check each for external online payment
  const recovered: string[] = [];
  const checked = cancelled.length;

  for (const p of cancelled) {
    const orderId = String(p.id);
    const projRes = await officeReq("GET", `/api/${CLIENT_KEY}/project/${orderId}`, headers);
    if (projRes.status >= 400) continue;

    const proj = JSON.parse(projRes.body);
    const payments = (proj.payments || []) as Array<{
      payMethodId: string;
      deviceCreated: string;
      userCreatedId: string;
    }>;
    const hasOnlinePayment = payments.some(
      (pay) =>
        String(pay.payMethodId) === "42603617" ||
        pay.deviceCreated === "Online Booking" ||
        String(pay.userCreatedId) === "-17",
    );

    if (!hasOnlinePayment) continue;

    // Recover via Pandora
    try {
      const pandoraRes = await fetch(`${PANDORA_BASE}/v2/bmi/reservation/state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PANDORA_KEY}`,
        },
        body: JSON.stringify({
          locationID: PANDORA_LOCATION,
          projectId: orderId,
          stateID: "-3",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (pandoraRes.ok) {
        recovered.push(`${p.number} ${(p.displayName || p.name || "?").trim()}`);
        console.log(`[bmi-cancel-sweep] recovered ${p.number} (${orderId})`);
      }
    } catch (err) {
      console.error(`[bmi-cancel-sweep] failed to recover ${p.number}:`, err);
    }
  }

  return NextResponse.json({
    checked,
    recovered: recovered.length,
    recoveredList: recovered,
  });
}
