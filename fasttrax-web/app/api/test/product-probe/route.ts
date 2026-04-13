import { NextRequest, NextResponse } from "next/server";

/**
 * Probe a BMI product to understand its shape before wiring it into the booking UI.
 *
 *   GET /api/test/product-probe?productId=44276020&pageId=25850658
 *
 * Runs:
 *   1. booking/sell with Quantity=1 (creates a test bill so we see what BMI emits)
 *   2. Reads the bill overview to see line items (combos expand into child lines)
 *   3. Cancels the test bill
 */

function baseUrl(req: NextRequest) {
  const host = req.headers.get("host") || "localhost:3000";
  const proto = host.includes("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const productId = searchParams.get("productId");
  const pageId = searchParams.get("pageId");
  const clientKey = searchParams.get("clientKey") || "headpinzftmyers";

  if (!productId || !pageId) {
    return NextResponse.json(
      { error: "Required: productId, pageId" },
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

  const trace: Record<string, unknown> = { input: { productId, pageId, clientKey } };

  // 1. Sell one unit
  const sellBody = `{"ProductId":${Number(productId)},"PageId":${Number(pageId)},"Quantity":1,"OrderId":null,"ParentOrderItemId":null,"DynamicLines":[]}`;
  const sell = await bmi("booking/sell", { method: "POST", body: sellBody });
  trace.sell = sell;

  const orderIdMatch = sell.raw.match(/"orderId"\s*:\s*(\d+)/);
  const orderId = orderIdMatch?.[1] || null;
  trace.orderId = orderId;

  if (orderId) {
    // 2. Fetch bill overview
    const overview = await bmi(`bill/${orderId}/overview`);
    trace.overview = overview;

    // 2b. Fetch scheduled lines (what's bookable to heats)
    const schedLines = await bmi(`bill/${orderId}/scheduledLines`);
    trace.scheduledLines = schedLines;

    // 3. Cancel
    const cancelRes = await fetch(`${base}/api/bmi?endpoint=${encodeURIComponent(`bill/${orderId}/cancel`)}&clientKey=${clientKey}`, { method: "DELETE" });
    trace.cancel = { status: cancelRes.status };
  }

  return NextResponse.json(trace);
}
