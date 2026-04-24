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
 *   pageId       (defaults 42960253 — race packs page)
 *   clientKey    (defaults "headpinzftmyers")
 *   depositKind  (default 0 — matches production race-packs confirmation.
 *                 The original Apr-6 working bill used 0. The bug report
 *                 also tested 2 and both failed; pass explicit value to
 *                 isolate which variant BMI's fix applies to.)
 *   regContact   (default "1") — call person/registerContactPerson
 *   regProject   (default "0") — also call person/registerProjectPerson
 *                 (matches the working race-booking flow's pattern:
 *                  see app/book/race/components/OrderSummary.tsx, where
 *                  BOTH calls fire per racer before payment. Credits
 *                  assignment may depend on the racer being a project
 *                  person, not just a contact.)
 *   projectFirst (default "0") — when both regs enabled, call project
 *                 before contact. Lets us isolate whether ordering
 *                 matters for BMI's credit pipeline.
 *   personIdInSell (default "1") — include PersonId in booking/sell
 *                 body. Pass "0" to defer the association entirely to
 *                 the register calls.
 *   includePageId  (default "1") — send PageId in the sell body.
 *                 NOT in BMI's public docs schema but we've always
 *                 sent it; worth testing omission to see if the
 *                 "Online Deposits" page-type change makes PageId
 *                 route the sell through a different handler that
 *                 skips the deposit/credit pipeline.
 *   includeProductXref (default "0") — send `ProductXref: null`
 *                 explicitly (documented field we've been omitting).
 *   doConfirm    (default "1"; pass "0" to stop before payment confirm)
 *   doCancel     (default "1"; pass "0" to leave the test bill open)
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
    // Default to 0 — that's what app/book/race-packs/confirmation
    // uses on every real checkout. Original Apr-6 working bill W24712
    // went through this path. BMI's "fix" may only address one value.
    const depositKindRaw = searchParams.get("depositKind");
    const depositKind = depositKindRaw !== null ? parseInt(depositKindRaw, 10) : 0;
    if (!Number.isFinite(depositKind)) {
      return NextResponse.json({ error: "depositKind must be an integer" }, { status: 400 });
    }
    const regContact = searchParams.get("regContact") !== "0";
    const regProject = searchParams.get("regProject") === "1";
    const projectFirst = searchParams.get("projectFirst") === "1";
    const personIdInSell = searchParams.get("personIdInSell") !== "0";
    const includePageId = searchParams.get("includePageId") !== "0";
    const includeProductXref = searchParams.get("includeProductXref") === "1";

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
      input: { personId, productId: productIdRaw, pageId, clientKey, doConfirm, doCancel, depositKind, regContact, regProject, projectFirst, personIdInSell, includePageId, includeProductXref },
      timestamp: new Date().toISOString(),
    };

    // 1. Snapshot deposits before
    trace.depositsBefore = await depositSnapshot(base, personId);

    // 2. Sell the pack. Body composition is fully controlled by flags
    //    so we can walk:
    //      - PageId on/off       (not in BMI's documented schema)
    //      - ProductXref null    (documented; we've been omitting)
    //      - PersonId in-sell    (our standard, but not strictly needed)
    //    Raw string concat to preserve big-int precision on PersonId.
    const parts: string[] = [
      `"ProductId":${Number(productIdRaw)}`,
      ...(includeProductXref ? [`"ProductXref":null`] : []),
      ...(includePageId ? [`"PageId":${Number(pageId)}`] : []),
      `"Quantity":1`,
      `"OrderId":null`,
      `"ParentOrderItemId":null`,
      `"DynamicLines":[]`,
      ...(personIdInSell ? [`"PersonId":${personId}`] : []),
    ];
    const sellBody = `{${parts.join(",")}}`;
    trace.sellBodySent = sellBody;
    const sellResp = await bmi("booking/sell", { method: "POST", body: sellBody });
    trace.sell = sellResp;

    const orderIdMatch = sellResp.raw.match(/"orderId"\s*:\s*(\d+)/);
    const orderId = orderIdMatch ? orderIdMatch[1] : null;
    trace.orderId = orderId;

    if (!orderId) {
      return NextResponse.json({ ok: false, stoppedAt: "sell", trace }, { status: 500 });
    }

    // 3. Person registration — order controlled by `projectFirst`.
    //    Contact = bill contact; Project = participant on the bill
    //    project. Race booking flow calls BOTH (contact-first); bug
    //    report exhausted single-register variants.
    const contactBody = `{"orderId":${orderId},"PersonId":${personId},"firstName":"Race","lastName":"Pack Test","email":"racepacktest@bma.test","phone":"2395550100"}`;
    const projectBody = `{"personId":${personId},"orderId":${orderId},"firstName":"Race","lastName":"Pack Test"}`;
    const runContact = async () => {
      const r = await bmi("person/registerContactPerson", { method: "POST", body: contactBody });
      trace.registerContact = r;
    };
    const runProject = async () => {
      const r = await bmi("person/registerProjectPerson", { method: "POST", body: projectBody });
      trace.registerProject = r;
    };
    if (projectFirst && regProject) await runProject();
    if (regContact) await runContact();
    if (!projectFirst && regProject) await runProject();

    // 4. Capture the expected total from sell (use first price entry)
    const sellJson = sellResp.body as { prices?: { amount: number; kind: number }[] } | undefined;
    const amount = sellJson?.prices?.[0]?.amount;
    trace.expectedAmount = amount;

    // 5. Payment confirm — depositKind comes from the query param (default 0,
    //    matching production race-packs confirmation).
    if (doConfirm && typeof amount === "number") {
      const payBody = `{"id":"${randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":${amount},"orderId":${orderId},"depositKind":${depositKind}}`;
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
