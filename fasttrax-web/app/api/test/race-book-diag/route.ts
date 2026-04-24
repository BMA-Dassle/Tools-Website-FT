import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

/**
 * Diagnostic endpoint for the "credit double-dip on check-in" bug report.
 *
 * Books a race for a specific personId on a given date using their
 * race credits (depositKind=2), snapshots deposits before + after,
 * and leaves the booking in place so staff can physically check in
 * the racer and confirm whether a SECOND credit gets deducted.
 *
 * Usage:
 *   GET /api/test/race-book-diag?personId=409523&productId=43734229
 *       &pageId=43734751&date=2026-04-25
 *
 * Optional:
 *   clientKey    (defaults "headpinzftmyers")
 *   heatIndex    (default 0; picks the Nth available time block)
 *   doConfirm    (default 1; set 0 to stop after booking/book)
 *   time         (default "15:00"; HH:MM UTC — dayplanner picks slots
 *                 from this time forward on the given date. Default
 *                 15:00 UTC = 11 AM ET which covers most weekend
 *                 opens. Passing "T00:00:00Z" returns zero proposals.)
 *   confirmDepositKind (default 2) — value to pass in payment/confirm.
 *                 Production uses 2 (Credit). Workaround test for the
 *                 check-in double-deduct bug uses 0 (Money) — theory
 *                 is BMI's check-in handler re-fires the credit
 *                 pipeline only on bills tagged as credit-paid. The
 *                 credit itself still auto-applies at booking/book
 *                 regardless of this value.
 *
 * UNLIKE race-pack-diag, this does NOT auto-cancel the bill — the
 * whole point is to leave a live booking in place so staff can
 * check the racer in and observe whether another credit is taken.
 *
 * Read/write against PROD BMI. Use with known test personIds.
 */

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
  const arr = Array.isArray(json) ? json : json.data || [];
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
    const productId = searchParams.get("productId");
    const pageId = searchParams.get("pageId");
    const date = searchParams.get("date"); // YYYY-MM-DD
    const clientKey = searchParams.get("clientKey") || DEFAULT_CLIENT_KEY;
    const heatIndex = parseInt(searchParams.get("heatIndex") || "0", 10);
    const doConfirm = searchParams.get("doConfirm") !== "0";
    const timeStr = searchParams.get("time") || "15:00"; // HH:MM UTC
    const confirmDepositKindRaw = searchParams.get("confirmDepositKind");
    const confirmDepositKind = confirmDepositKindRaw !== null
      ? parseInt(confirmDepositKindRaw, 10)
      : 2;
    if (!Number.isFinite(confirmDepositKind)) {
      return NextResponse.json({ error: "confirmDepositKind must be an integer" }, { status: 400 });
    }

    if (!personId || !productId || !pageId || !date) {
      return NextResponse.json(
        { error: "Required: personId, productId, pageId, date (YYYY-MM-DD)" },
        { status: 400 },
      );
    }

    const base = baseUrl(req);
    const sms = async (endpoint: string, init: RequestInit = {}) => {
      const url = `${base}/api/sms?endpoint=${encodeURIComponent(endpoint)}`;
      const res = await fetch(url, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers || {}) },
      });
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep raw */ }
      return { status: res.status, body: parsed, raw: text };
    };
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
      input: { personId, productId, pageId, date, clientKey, heatIndex, doConfirm },
      timestamp: new Date().toISOString(),
    };

    // 1. Snapshot deposits BEFORE
    trace.depositsBefore = await depositSnapshot(base, personId);

    // 2. Dayplanner — fetch available heat blocks for the date.
    //    Matches HeatPicker.fetchHeatsFrom: date as UTC midnight for
    //    the requested day so BMI returns that day's slots.
    const dayplannerBody = JSON.stringify({
      productId: Number(productId),
      pageId: Number(pageId),
      quantity: 1,
      dynamicLines: null,
      date: `${date}T${timeStr}:00.000Z`,
    });
    const dpResp = await sms("dayplanner/dayplanner", { method: "POST", body: dayplannerBody });
    trace.dayplanner = { status: dpResp.status, proposalCount: Array.isArray((dpResp.body as { proposals?: unknown[] })?.proposals) ? (dpResp.body as { proposals: unknown[] }).proposals.length : 0 };

    const proposals = (dpResp.body as { proposals?: Array<{ blocks: Array<{ block: { resourceId: number; start: string } }>; productLineId?: unknown }> })?.proposals || [];
    if (proposals.length === 0) {
      return NextResponse.json({ ok: false, stoppedAt: "dayplanner-empty", trace }, { status: 200 });
    }

    const chosen = proposals[Math.min(heatIndex, proposals.length - 1)];
    trace.chosenProposal = {
      index: Math.min(heatIndex, proposals.length - 1),
      start: chosen.blocks?.[0]?.block?.start,
      resourceId: chosen.blocks?.[0]?.block?.resourceId,
    };

    // 3. booking/book — raw-string personId injection to preserve big-int precision
    const bookPayload: Record<string, unknown> = {
      productId: String(productId),
      quantity: 1,
      resourceId: Number(chosen.blocks[0]?.block?.resourceId) || -1,
      proposal: {
        blocks: chosen.blocks.map((pb) => ({
          productLineIds: (pb as { productLineIds?: unknown[] }).productLineIds || [],
          block: { ...pb.block, resourceId: Number(pb.block.resourceId) || -1 },
        })),
        productLineId: chosen.productLineId ?? null,
      },
    };
    let bookBody = JSON.stringify(bookPayload);
    bookBody = bookBody.slice(0, -1) + `,"personId":${personId}}`;
    trace.bookBodySent = bookBody;

    const bookResp = await bmi("booking/book", { method: "POST", body: bookBody });
    trace.book = bookResp;

    const bookRaw = bookResp.raw;
    const orderIdMatch = bookRaw.match(/"orderId"\s*:\s*(\d+)/);
    const orderId = orderIdMatch ? orderIdMatch[1] : null;
    trace.orderId = orderId;

    if (!orderId) {
      return NextResponse.json({ ok: false, stoppedAt: "booking/book", trace }, { status: 500 });
    }

    // 4. Order overview — shows if credit was applied (depositKind=2 on totals)
    const ovResp = await bmi(`order/${orderId}/overview`, { method: "GET" });
    trace.overview = { status: ovResp.status, totals: (ovResp.body as { total?: unknown })?.total, lines: (ovResp.body as { lines?: unknown[] })?.lines?.length };
    const totals = ((ovResp.body as { total?: { amount?: number; depositKind?: number }[] })?.total) || [];
    const creditTotal = totals.find((t) => t.depositKind === 2);
    const cashTotal = totals.find((t) => t.depositKind === 0);
    trace.creditApplied = creditTotal?.amount ?? 0;
    trace.cashOwed = cashTotal?.amount ?? 0;

    // 5. Payment confirm with amount=0 and the chosen depositKind.
    //    The actual credit is already applied to the bill by
    //    booking/book (see overview totals). This call just closes
    //    out the bill. Production sends depositKind=2 (Credit), but
    //    we're testing whether depositKind=0 (Money) avoids the
    //    check-in double-deduct bug.
    if (doConfirm) {
      const payBody = `{"id":"${randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":0,"orderId":${orderId},"depositKind":${confirmDepositKind}}`;
      trace.paymentConfirmBodySent = payBody;
      const payResp = await bmi("payment/confirm", { method: "POST", body: payBody });
      trace.paymentConfirm = payResp;
      await new Promise((r) => setTimeout(r, 2500));
    }

    // 6. Snapshot deposits AFTER
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
    trace.creditConsumed = Object.values(diff).some((d) => d.delta < 0);

    return NextResponse.json({
      ok: true,
      orderId,
      heatStart: (trace.chosenProposal as { start?: string }).start,
      creditApplied: trace.creditApplied,
      cashOwed: trace.cashOwed,
      creditConsumed: trace.creditConsumed,
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
