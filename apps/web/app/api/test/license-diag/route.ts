import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { apiBase } from "@/lib/api-base";
import { fetchPersonRaw } from "~/features/daily-events/data/bmi-office";
import { LICENSE_PRODUCT_ID } from "~/features/booking/service/race-pack-license.server";

/**
 * Diagnostic for standalone FastTrax-license registration (the race-pack license
 * rail). Runs sell(43473520) → registerContactPerson → payment/confirm against
 * the LIVE Public Booking API, then re-reads the person's BMI Office memberships
 * so we can PROVE selling 43473520 attaches the "License Fee" membership (the one
 * external unknown gating go-live). Mirrors the shape of api/test/race-pack-diag.
 *
 * Usage (Vercel preview):
 *   GET /api/test/license-diag?create=1
 *     → mints a FAKE throwaway person (Pandora), waits for cloud sync, then sells
 *       them a license. No real customer touched. Nothing is charged to a card;
 *       payment/confirm books the BMI bill as an external (depositKind 0) payment.
 *   GET /api/test/license-diag?personId=<id>
 *     → run against a specific existing person id.
 *
 * Optional:
 *   pageId + includePageId=1 — send PageId in the sell body (default omitted).
 *   doConfirm (default "1"; "0" stops before payment/confirm)
 *   doCancel  (default "0") — cancel the test bill afterward. LEAVE AT 0 to see
 *             whether the membership persists; the real flow never cancels.
 *   clientKey (default "headpinzftmyers")
 *
 * Read/WRITE against PROD BMI. `probe=1` echoes the input shape without any call.
 */

export const maxDuration = 60;

const DEFAULT_CLIENT_KEY = "headpinzftmyers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const clientKey = searchParams.get("clientKey") || DEFAULT_CLIENT_KEY;
    const create = searchParams.get("create") === "1";
    let personId = searchParams.get("personId");
    // Which product to sell. 43473520 = kind-1 "License Fee" (charge line);
    // 11253570 = kind-3 Membership (the actual license record). Test both.
    const productId = searchParams.get("productId") || LICENSE_PRODUCT_ID;
    if (!/^\d{1,20}$/.test(productId)) {
      return NextResponse.json({ error: "bad productId" }, { status: 400 });
    }
    const pageId = searchParams.get("pageId");
    const includePageId = searchParams.get("includePageId") === "1" && !!pageId;
    const doConfirm = searchParams.get("doConfirm") !== "0";
    const doCancel = searchParams.get("doCancel") === "1";

    // List the membership product catalog (GET /membership) — find the FastTrax
    // license membership's Id/XRef to sell. No person / side effects needed.
    if (searchParams.get("listMemberships") === "1") {
      const res = await fetch(`${apiBase()}/api/bmi?endpoint=membership&clientKey=${clientKey}`);
      const text = await res.text();
      let memberships: unknown = text;
      try {
        memberships = JSON.parse(text);
      } catch {
        /* keep raw */
      }
      return NextResponse.json({ ok: res.ok, status: res.status, memberships });
    }

    if (!create && (!personId || !/^\d{1,20}$/.test(personId))) {
      return NextResponse.json(
        { error: "Provide create=1 (mint a fake person) or personId=<digits>" },
        { status: 400 },
      );
    }

    if (searchParams.get("probe") === "1") {
      return NextResponse.json({
        ok: true,
        probe: true,
        inputShape: {
          create,
          personId,
          productId,
          clientKey,
          pageId,
          includePageId,
          doConfirm,
          doCancel,
        },
        message: "Probe only — no BMI call. Drop probe=1 to actually run.",
      });
    }

    // Self-call the UNPROTECTED base (production origin via apiBase), never the
    // request host — a preview host sits behind Vercel SSO and 401s the internal
    // /api/bmi call. The real registerStandaloneLicense uses apiBase() too.
    const base = apiBase();
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
      input: { create, personId, productId, clientKey, pageId, includePageId, doConfirm, doCancel },
      timestamp: new Date().toISOString(),
    };

    // 0. Mint a fake throwaway person (Pandora → Firebird). booking/sell hits the
    //    cloud, which lags Firebird a few seconds — the sell loop below retries.
    if (create) {
      const suffix = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 900 + 100)}`;
      const fake = {
        firstName: "Ztest",
        lastName: `Licdiag${suffix}`,
        email: `licdiag+${suffix}@bma.test`,
        phone: `239555${suffix.slice(-4)}`,
        birthdate: "1990-01-01",
      };
      trace.fakePerson = fake;
      const createRes = await fetch(`${apiBase()}/api/pandora`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fake),
      });
      const createData = await createRes.json().catch(() => ({}));
      trace.create = {
        status: createRes.status,
        personId: createData.personId,
        error: createData.error,
      };
      if (!createData.personId) {
        return NextResponse.json({ ok: false, stoppedAt: "create-person", trace }, { status: 502 });
      }
      personId = String(createData.personId);
    }

    trace.personId = personId;
    trace.membershipsBefore = await membershipSnapshot(clientKey, personId!);

    // 1. Sell the license → new bill. Retry to absorb Firebird→cloud sync lag
    //    for a just-created person (the web legacy race-pack path polls the same).
    const sellParts = [
      `"ProductId":${productId}`,
      ...(includePageId ? [`"PageId":${Number(pageId)}`] : []),
      `"Quantity":1`,
      `"OrderId":null`,
      `"ParentOrderItemId":null`,
      `"DynamicLines":[]`,
      `"PersonId":${personId}`,
    ];
    const sellBody = `{${sellParts.join(",")}}`;
    trace.sellBodySent = sellBody;

    const maxSellTries = create ? 6 : 1;
    let sell: Awaited<ReturnType<typeof bmi>> | null = null;
    let billId: string | null = null;
    for (let i = 1; i <= maxSellTries; i++) {
      sell = await bmi("booking/sell", sellBody);
      billId = rawField(sell.raw, "orderId");
      if (billId) {
        trace.sellTries = i;
        break;
      }
      if (i < maxSellTries) await sleep(5000);
    }
    trace.sell = sell;
    trace.billId = billId;
    if (!billId) {
      return NextResponse.json({ ok: false, stoppedAt: "sell", personId, trace }, { status: 500 });
    }

    // 2. Register the contact person on the bill.
    const regBody = `{"orderId":${billId},"PersonId":${personId},"firstName":"License","lastName":"Diag Test","email":"licensediag@bma.test","phone":"2395550100"}`;
    trace.register = await bmi("person/registerContactPerson", regBody);

    // 3. Confirm (depositKind 0 = external). Use BMI's own line price if present.
    const sellJson = sell!.body as { prices?: Array<{ amount?: number }> } | undefined;
    const amount = sellJson?.prices?.[0]?.amount ?? 4.99;
    trace.confirmAmount = amount;
    if (doConfirm) {
      const payBody = `{"id":"${randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":${amount},"orderId":${billId},"depositKind":0}`;
      trace.paymentConfirm = await bmi("payment/confirm", payBody);
      await sleep(2500);
    }

    // Re-poll memberships — the Office record lags the sale a few seconds.
    let after = await membershipSnapshot(clientKey, personId!);
    for (let i = 0; i < 3 && !(after as { activeLicense?: boolean }).activeLicense; i++) {
      await sleep(4000);
      after = await membershipSnapshot(clientKey, personId!);
    }
    trace.membershipsAfter = after;

    const before = trace.membershipsBefore as { activeLicense?: boolean };
    const licenseAttached =
      (after as { activeLicense?: boolean }).activeLicense === true &&
      before?.activeLicense !== true;
    trace.licenseAttached = licenseAttached;

    if (doCancel) {
      const cancelResp = await fetch(
        `${base}/api/bmi?endpoint=${encodeURIComponent(`bill/${billId}/cancel`)}&clientKey=${clientKey}`,
        { method: "DELETE" },
      );
      trace.cancel = { status: cancelResp.status };
    }

    return NextResponse.json({
      ok: true,
      licenseAttached,
      personId,
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
