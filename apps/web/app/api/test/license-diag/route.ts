import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { fetchPersonRaw } from "~/features/daily-events/data/bmi-office";
import { LICENSE_PRODUCT_ID } from "~/features/booking/service/race-pack-license.server";

/**
 * Diagnostic for standalone FastTrax-license registration (the race-pack license
 * rail). Runs sell(43473520) → registerContactPerson → payment/confirm against
 * the LIVE Public Booking API for a test person, then re-reads their BMI Office
 * memberships so we can PROVE selling 43473520 attaches the "License Fee"
 * membership (the one external unknown gating go-live). Mirrors the shape of
 * api/test/race-pack-diag.
 *
 * Usage (Vercel preview):
 *   GET /api/test/license-diag?personId=<TEST_PERSON_ID>
 *
 * Optional:
 *   pageId       — send PageId in the sell body (default: omitted). Set this if
 *                  the sell can't CREATE a bill without a page.
 *   includePageId (default "0") — only meaningful with pageId set.
 *   doConfirm    (default "1"; "0" stops before payment/confirm)
 *   doCancel     (default "0") — cancel the test bill afterward. LEAVE AT 0 to
 *                  see whether the membership persists; the real flow never cancels.
 *   clientKey    (default "headpinzftmyers")
 *
 * Read/WRITE against PROD BMI — use known test person ids only. `probe=1` echoes
 * the input shape without any BMI call.
 */

const DEFAULT_CLIENT_KEY = "headpinzftmyers";

function baseUrl(req: NextRequest) {
  const host = req.headers.get("host") || "localhost:3000";
  const proto = host.includes("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}

async function membershipSnapshot(clientKey: string, personId: string) {
  try {
    const person = await fetchPersonRaw<{
      memberships?: Array<{ name?: string; stops?: string | null }>;
    }>(clientKey, personId);
    const now = Date.now();
    const all = (person.memberships ?? []).map((m) => ({
      name: m.name ?? "",
      stops: m.stops ?? null,
      active: !m.stops || new Date(m.stops).getTime() > now,
    }));
    return {
      all,
      activeLicense: all.some((m) => m.name.toLowerCase().includes("license") && m.active),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "membership read failed" };
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const personId = searchParams.get("personId");
    const clientKey = searchParams.get("clientKey") || DEFAULT_CLIENT_KEY;
    const pageId = searchParams.get("pageId");
    const includePageId = searchParams.get("includePageId") === "1" && !!pageId;
    const doConfirm = searchParams.get("doConfirm") !== "0";
    const doCancel = searchParams.get("doCancel") === "1";

    if (!personId || !/^\d{1,20}$/.test(personId)) {
      return NextResponse.json(
        { error: "Required query param: personId (digits)" },
        { status: 400 },
      );
    }

    if (searchParams.get("probe") === "1") {
      return NextResponse.json({
        ok: true,
        probe: true,
        inputShape: { personId, clientKey, pageId, includePageId, doConfirm, doCancel },
        message: "Probe only — no BMI call. Drop probe=1 to actually run.",
      });
    }

    const base = baseUrl(req);
    const bmi = async (endpoint: string, body: string) => {
      const url = `${base}/api/bmi?endpoint=${encodeURIComponent(endpoint)}&clientKey=${clientKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw */
      }
      return { status: res.status, body: parsed, raw: text };
    };
    const rawField = (text: string, field: string) =>
      text.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`))?.[1] ?? null;

    const trace: Record<string, unknown> = {
      input: { personId, clientKey, pageId, includePageId, doConfirm, doCancel },
      timestamp: new Date().toISOString(),
    };

    trace.membershipsBefore = await membershipSnapshot(clientKey, personId);

    // 1. Sell the license → new bill.
    const sellParts = [
      `"ProductId":${LICENSE_PRODUCT_ID}`,
      ...(includePageId ? [`"PageId":${Number(pageId)}`] : []),
      `"Quantity":1`,
      `"OrderId":null`,
      `"ParentOrderItemId":null`,
      `"DynamicLines":[]`,
      `"PersonId":${personId}`,
    ];
    const sellBody = `{${sellParts.join(",")}}`;
    trace.sellBodySent = sellBody;
    const sell = await bmi("booking/sell", sellBody);
    trace.sell = sell;
    const billId = rawField(sell.raw, "orderId");
    trace.billId = billId;
    if (!billId) {
      return NextResponse.json({ ok: false, stoppedAt: "sell", trace }, { status: 500 });
    }

    // 2. Register the contact person.
    const regBody = `{"orderId":${billId},"PersonId":${personId},"firstName":"License","lastName":"Diag Test","email":"licensediag@bma.test","phone":"2395550100"}`;
    trace.register = await bmi("person/registerContactPerson", regBody);

    // 3. Confirm (depositKind 0). Use BMI's own line price if present.
    const sellJson = sell.body as { prices?: Array<{ amount?: number }> } | undefined;
    const amount = sellJson?.prices?.[0]?.amount ?? 4.99;
    trace.confirmAmount = amount;
    if (doConfirm) {
      const payBody = `{"id":"${randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":${amount},"orderId":${billId},"depositKind":0}`;
      trace.paymentConfirm = await bmi("payment/confirm", payBody);
      await new Promise((r) => setTimeout(r, 2500));
    }

    trace.membershipsAfter = await membershipSnapshot(clientKey, personId);

    const before = trace.membershipsBefore as { activeLicense?: boolean };
    const after = trace.membershipsAfter as { activeLicense?: boolean };
    trace.licenseAttached = after?.activeLicense === true && before?.activeLicense !== true;

    if (doCancel) {
      const cancelResp = await fetch(
        `${base}/api/bmi?endpoint=${encodeURIComponent(`bill/${billId}/cancel`)}&clientKey=${clientKey}`,
        { method: "DELETE" },
      );
      trace.cancel = { status: cancelResp.status };
    }

    return NextResponse.json({
      ok: true,
      licenseAttached: trace.licenseAttached,
      billId,
      membershipsAfter: trace.membershipsAfter,
      trace,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Diag error" },
      { status: 500 },
    );
  }
}
