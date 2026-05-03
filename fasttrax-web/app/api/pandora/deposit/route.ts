import { NextRequest, NextResponse } from "next/server";

/**
 * Internal write proxy for Pandora's add/remove-deposit endpoint.
 *
 *   POST /api/pandora/deposit
 *
 * Body:
 *   {
 *     locationId:     "LAB52GY480CJF" | "TXBSQN0FEKQ11" | "PPTR5G2N0QXF7",
 *     personId:       "46080884",
 *     depositKindId:  "1234",     // BMI deposit-kind ID (e.g. ViewPoint Credit)
 *     amount:         number,     // signed: positive = add, negative = remove. 0 is rejected upstream.
 *     activates?:     ISO string, // defaults server-side to now
 *     expires?:       ISO string  // defaults server-side to 2999-12-31
 *   }
 *
 * Upstream: POST /v2/bmi/deposit
 *
 * ── Trust gate ──────────────────────────────────────────────────────────────
 * Mutating BMI deposit balances on behalf of customers is a server-only
 * concern. Browser-originated requests are rejected outright. Callers must
 * pass `x-pandora-internal: ${SWAGGER_ADMIN_KEY}` — same shared-secret
 * pattern the participants endpoint uses to gate full-PII access.
 *
 * Today the only legitimate caller is `/api/pov-codes?action=claim-from-credit`
 * (and its sweep-retry cron), which decrements the ViewPoint Credit balance
 * after issuing voucher codes to a participant.
 */

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";

const ALLOWED_LOCATIONS = new Set([
  "LAB52GY480CJF", // FastTrax
  "TXBSQN0FEKQ11", // HeadPinz Fort Myers
  "PPTR5G2N0QXF7", // HeadPinz Naples
]);

interface DepositBody {
  locationId?: unknown;
  personId?: unknown;
  depositKindId?: unknown;
  amount?: unknown;
  activates?: unknown;
  expires?: unknown;
}

export async function POST(req: NextRequest) {
  // Trust gate first — never lets an unauthenticated request burn a
  // Pandora call.
  const internalHeader = req.headers.get("x-pandora-internal");
  if (!API_KEY || internalHeader !== API_KEY) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: DepositBody;
  try {
    body = (await req.json()) as DepositBody;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const locationId = typeof body.locationId === "string" ? body.locationId : "";
  const personId = typeof body.personId === "string" ? body.personId : String(body.personId ?? "");
  const depositKindId =
    typeof body.depositKindId === "string"
      ? body.depositKindId
      : String(body.depositKindId ?? "");
  const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
  const activates = typeof body.activates === "string" ? body.activates : undefined;
  const expires = typeof body.expires === "string" ? body.expires : undefined;

  if (!ALLOWED_LOCATIONS.has(locationId)) {
    return NextResponse.json({ error: "invalid locationId" }, { status: 400 });
  }
  if (!personId || !/^\d+$/.test(personId)) {
    return NextResponse.json({ error: "invalid personId" }, { status: 400 });
  }
  if (!depositKindId || !/^\d+$/.test(depositKindId)) {
    return NextResponse.json({ error: "invalid depositKindId" }, { status: 400 });
  }
  if (!Number.isFinite(amount) || amount === 0 || !Number.isInteger(amount)) {
    return NextResponse.json(
      { error: "amount must be a non-zero integer (negative removes, positive adds)" },
      { status: 400 },
    );
  }

  // Audit log every call. PersonID + signed amount + caller hint
  // make it easy to retrace what happened in case of a balance
  // dispute. The shared-secret gate already proves this is server-
  // side; we don't log the secret itself.
  const callerHint = req.headers.get("x-pandora-caller") || "unknown";
  console.log(
    `[pandora/deposit] caller=${callerHint} loc=${locationId} person=${personId} kind=${depositKindId} amount=${amount}`,
  );

  // 12s upstream timeout. The endpoint is a single-row INSERT into
  // T_DEPOSIT — should always be sub-second. A timeout here means
  // BMA/Pandora is in trouble; bubble the error and let the caller
  // retry via the sweep cron.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);

  try {
    const upstreamBody: Record<string, unknown> = {
      locationID: locationId,
      personID: personId,
      depositKindID: depositKindId,
      amount,
    };
    if (activates) upstreamBody.activates = activates;
    if (expires) upstreamBody.expires = expires;

    const res = await fetch(`${PANDORA_URL}/bmi/deposit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(upstreamBody),
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const text = await res.text();
    if (!res.ok) {
      console.error(`[pandora/deposit] upstream ${res.status}: ${text.slice(0, 500)}`);
      return NextResponse.json(
        { error: `upstream ${res.status}`, body: text.slice(0, 500) },
        { status: 502 },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return NextResponse.json(
      { success: true, data: parsed },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const msg = isTimeout ? "upstream timeout" : err instanceof Error ? err.message : "fetch failed";
    console.error(`[pandora/deposit] ${msg}`);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
