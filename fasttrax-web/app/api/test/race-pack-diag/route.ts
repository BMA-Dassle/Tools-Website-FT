import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

/**
 * Diagnostic endpoint for the BMI race-pack credit bug.
 *
 * Runs the full sell → register → confirm → check-deposits flow against
 * the live Public Booking API and reports every step so we can see where
 * (if anywhere) credits fail to load.
 *
 * Usage:
 *   GET /api/test/race-pack-diag?personId=63000000003063503&productId=13079165
 *
 * Optional:
 *   pageId    (defaults 42960253 — race packs page)
 *   clientKey (defaults "headpinzftmyers")
 *   doConfirm (default "1"; pass "0" to stop before payment confirm)
 *   doCancel  (default "1"; pass "0" to leave the test bill open)
 *
 * This is read/write against PROD BMI. Don't run it casually.
 * Use known-test person IDs only.
 */

const DEFAULT_PAGE_ID = 42960253;
const DEFAULT_CLIENT_KEY = "headpinzftmyers";

function baseUrl(req: NextRequest) {
  const host = req.headers.get("host") || "localhost:3000";
  const proto = host.includes("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}

async function depositSnapshot(base: string, personId: string) {
  const res = await fetch(`${base}/api/bmi-office?action=deposits&personId=${personId}`);
  if (!res.ok) return { error: `deposit history HTTP ${res.status}` };
  const json = await res.json();
  // history is usually an array of entries
  const arr = Array.isArray(json) ? json : json.data || [];
  // Group by depositKind, sum balance
  const byKind: Record<string, number> = {};
  for (const d of arr) {
    const kind = d.depositKind || d.DepositKind || "unknown";
    const bal = typeof d.balance === "number" ? d.balance : (typeof d.Balance === "number" ? d.Balance : 0);
    byKind[kind] = (byKind[kind] || 0) + bal;
  }
  return { byKind, totalEntries: arr.length };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const personId = searchParams.get("personId");
    const productIdRaw = searchParams.get("productId");
    const pageId = searchParams.get("pageId") || String(DEFAULT_PAGE_ID);
    const clientKey = searchParams.get("clientKey") || DEFAULT_CLIENT_KEY;
    const doConfirm = searchParams.get("doConfirm") !== "0";
    const doCancel = searchParams.get("doCancel") !== "0";

    if (!personId || !productIdRaw) {
      return NextResponse.json(
        { error: "Required query params: personId, productId" },
        { status: 400 },
      );
    }

    const base = baseUrl(req);
    const bmi = async (endpoint: string, init: RequestInit = {}) => {
      const url = `${base}/api/bmi?endpoint=${encodeURIComponent(endpoint)}&clientKey=${clientKey}`;
      const res = await fetch(url, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers || {}) },
      });
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep raw */ }
      return { status: res.status, body: parsed, raw: text };
    };

    const trace: Record<string, unknown> = {
      input: { personId, productId: productIdRaw, pageId, clientKey, doConfirm, doCancel },
      timestamp: new Date().toISOString(),
    };

    // 1. Snapshot deposits before
    trace.depositsBefore = await depositSnapshot(base, personId);

    // 2. Sell the pack WITH personId (raw string JSON to avoid precision loss on big IDs)
    const sellBody = `{"ProductId":${Number(productIdRaw)},"PageId":${Number(pageId)},"Quantity":1,"OrderId":null,"ParentOrderItemId":null,"DynamicLines":[],"PersonId":${personId}}`;
    const sellResp = await bmi("booking/sell", { method: "POST", body: sellBody });
    trace.sell = sellResp;

    const orderIdMatch = sellResp.raw.match(/"orderId"\s*:\s*(\d+)/);
    const orderId = orderIdMatch ? orderIdMatch[1] : null;
    trace.orderId = orderId;

    if (!orderId) {
      return NextResponse.json({ ok: false, stoppedAt: "sell", trace }, { status: 500 });
    }

    // 3. Register contact person
    const regBody = `{"orderId":${orderId},"PersonId":${personId},"firstName":"Race","lastName":"Pack Test","email":"racepacktest@bma.test","phone":"2395550100"}`;
    const regResp = await bmi("person/registerContactPerson", { method: "POST", body: regBody });
    trace.register = regResp;

    // 4. Capture the expected total from sell (use first price entry)
    const sellJson = sellResp.body as { prices?: { amount: number; kind: number }[] } | undefined;
    const amount = sellJson?.prices?.[0]?.amount;
    trace.expectedAmount = amount;

    // 5. Payment confirm with depositKind=2 (External Online) — simulates PSP success
    if (doConfirm && typeof amount === "number") {
      const payBody = `{"id":"${randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":${amount},"orderId":${orderId},"depositKind":2}`;
      const payResp = await bmi("payment/confirm", { method: "POST", body: payBody });
      trace.paymentConfirm = payResp;

      // Wait a moment for BMI to process
      await new Promise((r) => setTimeout(r, 2500));
    }

    // 6. Snapshot deposits after
    trace.depositsAfter = await depositSnapshot(base, personId);

    // 7. Diff
    const before = (trace.depositsBefore as { byKind?: Record<string, number> }).byKind || {};
    const after = (trace.depositsAfter as { byKind?: Record<string, number> }).byKind || {};
    const diff: Record<string, { before: number; after: number; delta: number }> = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = before[k] || 0;
      const a = after[k] || 0;
      if (a !== b) diff[k] = { before: b, after: a, delta: a - b };
    }
    trace.depositDiff = diff;
    trace.creditsLoaded = Object.values(diff).some((d) => d.delta > 0);

    // 8. Cancel the test bill so it doesn't clutter BMI (unless asked to keep)
    if (doCancel) {
      const cancelResp = await fetch(`${base}/api/bmi?endpoint=${encodeURIComponent(`bill/${orderId}/cancel`)}&clientKey=${clientKey}`, { method: "DELETE" });
      trace.cancel = { status: cancelResp.status };
    }

    return NextResponse.json({
      ok: true,
      creditsLoaded: trace.creditsLoaded,
      orderId,
      expectedAmount: amount,
      depositDiff: diff,
      trace,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Diag error" },
      { status: 500 },
    );
  }
}
