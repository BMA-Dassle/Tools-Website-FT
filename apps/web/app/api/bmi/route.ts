import { NextRequest, NextResponse } from "next/server";
import https from "https";
import redis from "@/lib/redis";
import { mirrorMemoIntoNotesByBillId } from "@/lib/bowling-db";
import { bmiWriteBlocked } from "~/features/maintenance";
import { guardBillCancel } from "~/features/kiosk/service/cancel-guard";

// ── Config from env ───────────────────────────────────────────────────────────

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

// ── JWT token cache (per client key) ─────────────────────────────────────────

const ALLOWED_CLIENTS = new Set(["headpinzftmyers", "headpinznaples"]);
const tokenCache: Record<string, { token: string; expiry: number }> = {};

async function getToken(clientKey = BMI_CLIENT_KEY): Promise<string> {
  const cached = tokenCache[clientKey];
  if (cached && Date.now() < cached.expiry - 60_000) {
    return cached.token;
  }

  const res = await fetch(`${BMI_API_URL}/auth/${clientKey}/publicbooking`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "BMI-Subscription-Key": BMI_SUB_KEY,
    },
    body: JSON.stringify({ Username: BMI_USERNAME, Password: BMI_PASSWORD }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`BMI auth failed: ${res.status}`);
  }

  const data = await res.json();
  const token = data.AccessToken || data.accessToken;
  const expiresIn = parseInt(data.ExpiresIn || data.expiresIn || "3600", 10);
  tokenCache[clientKey] = { token, expiry: Date.now() + expiresIn * 1000 };

  return token;
}

function bmiHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "BMI-Subscription-Key": BMI_SUB_KEY,
    "Content-Type": "application/json",
    "Accept-Language": "en",
  };
}

// ── Allowed endpoints ─────────────────────────────────────────────────────────

const ALLOWED_GET = [
  "page",
  "products",
  "availability",
  "image/product",
  "order",
  "person",
  "subscription",
  "membership", // GET /membership → membership product catalog (kind=3)
];

const ALLOWED_POST = [
  "availability",
  "booking/book",
  "booking/sell",
  "booking/memo",
  "booking/removeItem",
  "payment/confirm",
  "person/registerContactPerson",
  "person/registerProjectPerson",
  // Voucher / discount code endpoints (BMI Public API §21/§22).
  // Flagged "not yet released" in BMI docs as of 2026-04-21 — include
  // in the allowlist so we can probe availability without another
  // deploy the moment BMI flips them on.
  "order/applyCode",
  "order/removeCode",
];

const ALLOWED_DELETE = [
  "bill", // bill/{orderId}/cancel
];

// ── Availability read-through cache (semi-live race grids, 2026-07-19) ───────
//
// The heat grids poll availability every 30s so other guests' bookings show
// up without navigating. This 25s RAW-TEXT cache caps what actually reaches
// BMI at ~1 call per (client, date, product, qty) per TTL no matter how many
// kiosks/phones sit on a grid. The cached value is the upstream body STRING,
// byte-for-byte — never JSON.parse'd (17-digit BMI id precision rule).
// Best-effort throughout: any Redis failure falls open to the upstream call.
// ANY successful booking write through this proxy (book / sell / removeItem /
// bill cancel) purges the whole cache, so every device converges within one
// poll and an own-session post-hold refetch reads truly fresh data.

const AVAIL_CACHE_TTL_S = 25;
const AVAIL_INDEX_TTL_S = 21_600; // 6h — the index only outlives entries to be purgeable
const availCacheIndexKey = (clientKey: string) => `bmi:avail:index:${clientKey}`;

/** Cache key from the RAW body — ids regexed, never parsed (precision rule).
 *  Quantity is part of the key: BMI shapes the response by requested qty. */
function availabilityCacheKey(
  clientKey: string,
  date: string | null,
  bodyStr: string,
): string | null {
  const productId = bodyStr.match(/"ProductId"\s*:\s*(\d+)/)?.[1];
  if (!date || !productId) return null;
  const pageId = bodyStr.match(/"PageId"\s*:\s*(\d+)/)?.[1] ?? "";
  const quantity = bodyStr.match(/"Quantity"\s*:\s*(\d+)/)?.[1] ?? "1";
  return `bmi:avail:${clientKey}:${date}:${productId}:${pageId}:${quantity}`;
}

async function purgeAvailabilityCache(clientKey: string): Promise<void> {
  try {
    const idx = availCacheIndexKey(clientKey);
    const keys = await redis.smembers(idx);
    if (keys.length > 0) await redis.del(...keys);
    await redis.del(idx);
  } catch {
    /* best-effort — entries self-expire in 25s anyway */
  }
}

/** Forward an upstream JSON body EXACTLY as received — no parse, no re-encode,
 *  so 17-digit BMI ids keep every digit. Anything that runs a BMI body through
 *  JSON.parse before it reaches the caller is a precision bug waiting to be
 *  found (see the GET handler's note). */
function jsonPassthrough(text: string, status: number): NextResponse {
  return new NextResponse(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── GET handler ───────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const endpoint = searchParams.get("endpoint");

  if (!endpoint || !ALLOWED_GET.some((e) => endpoint.startsWith(e))) {
    return NextResponse.json({ error: "Endpoint not allowed" }, { status: 403 });
  }

  try {
    const clientKey = searchParams.get("clientKey") || BMI_CLIENT_KEY;
    if (!ALLOWED_CLIENTS.has(clientKey))
      return NextResponse.json({ error: "Invalid client" }, { status: 403 });
    const token = await getToken(clientKey);

    // Build upstream URL — pass through all query params except 'endpoint' and 'clientKey'
    const upstreamParams = new URLSearchParams();
    for (const [k, v] of searchParams) {
      if (k !== "endpoint" && k !== "clientKey") upstreamParams.set(k, v);
    }
    const qs = upstreamParams.toString();
    const url = `${BMI_API_URL}/public-booking/${clientKey}/${endpoint}${qs ? `?${qs}` : ""}`;

    console.log(`[BMI GET] ${url}`);
    const upstream = await fetch(url, {
      headers: bmiHeaders(token),
      cache: "no-store",
    });
    if (!upstream.ok && endpoint.includes("order")) {
      const errBody = await upstream.text();
      console.error(`[BMI GET ERROR] ${upstream.status}: ${errBody}`);
      return jsonPassthrough(errBody, upstream.status);
    }

    // Image endpoint returns binary
    if (endpoint === "image/product") {
      const contentType = upstream.headers.get("content-type") || "image/png";
      const buffer = await upstream.arrayBuffer();
      return new NextResponse(buffer, {
        headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" },
      });
    }

    // RAW TEXT, never re-serialized. `NextResponse.json(await upstream.json())`
    // rounded every 17-digit id on the way through: proven live 2026-08-04 —
    // BMI returned orderId 63000000007234468 and this handler emitted
    // ...460. Callers that dig the id back out of the body text
    // (`extractRawField`, `parseWithRawIds`) were therefore extracting a
    // CORRUPTED id from a response that looked fine, and the same handler serves
    // `person/*`, where the casualty is a personId. Byte-for-byte passthrough is
    // the only safe shape — the precision rule in CLAUDE.md exists for this.
    return jsonPassthrough(await upstream.text(), upstream.status);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "BMI API error" },
      { status: 500 },
    );
  }
}

// ── Office API (SMS-Timing) — post-confirm state verification ────────────────

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "";
const OFFICE_PASS = OFFICE_PASS_B64
  ? Buffer.from(OFFICE_PASS_B64, "base64").toString()
  : process.env.BMI_OFFICE_PASSWORD || "";
const SMS_VERSION = "6251006 202511051229";

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
    const r = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c: string) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 500, body: data }));
    });
    r.on("error", reject);
    r.setTimeout(15_000, () => {
      r.destroy();
      reject(new Error("Timeout"));
    });
    if (body) r.write(body);
    r.end();
  });
}

let officeTokenCache: { token: string; expiry: number; clientKey: string } | null = null;

async function getOfficeToken(clientKey: string): Promise<string> {
  if (
    officeTokenCache &&
    officeTokenCache.clientKey === clientKey &&
    Date.now() < officeTokenCache.expiry - 60_000
  ) {
    return officeTokenCache.token;
  }
  const res = await officeReq(
    "POST",
    "/auth/token",
    {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: clientKey,
      "x-fast-version": SMS_VERSION,
    },
    `grant_type=password&username=${OFFICE_USER}&password=${encodeURIComponent(OFFICE_PASS)}`,
  );
  if (res.status !== 200) throw new Error(`Office auth: ${res.status}`);
  const data = JSON.parse(res.body);
  const token = data.access_token;
  officeTokenCache = { token, clientKey, expiry: Date.now() + 3500_000 };
  return token;
}

/**
 * After payment/confirm returns 200, check BMI's own Office API to see
 * what state the project is actually in. Logs the result to Redis as
 * irrefutable evidence of the orderId/projectId mismatch and stuck states.
 */
async function verifyPostConfirm(
  clientKey: string,
  orderId: string,
  wNumber: string,
): Promise<void> {
  try {
    const token = await getOfficeToken(clientKey);
    const h: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "x-fast-version": SMS_VERSION,
      "x-session-id": `verify-${Date.now()}`,
      clientkey: clientKey,
    };

    // 1. Search by W-number to find the projectId
    const searchRes = await officeReq(
      "GET",
      `/api/${clientKey}/search?token=${wNumber}&maxResults=3`,
      h,
    );
    const searchResults = searchRes.status < 400 ? JSON.parse(searchRes.body) : [];
    const projectResult = Array.isArray(searchResults)
      ? searchResults.find((r: { kind?: number }) => r.kind === 2)
      : null;
    const projectId = projectResult?.localId ? String(projectResult.localId) : null;

    // 2. Fetch project at orderId (what booking/book returned)
    const projAtOrderId = await officeReq("GET", `/api/${clientKey}/project/${orderId}`, h);

    // 3. Fetch project at projectId (what search returned)
    let projAtProjectId: { status: number; body: string } | null = null;
    if (projectId && projectId !== orderId) {
      projAtProjectId = await officeReq("GET", `/api/${clientKey}/project/${projectId}`, h);
    }

    function extractState(res: { status: number; body: string } | null) {
      if (!res || res.status >= 400)
        return { httpStatus: res?.status ?? 0, stateId: null, userUpdatedId: null };
      try {
        const p = JSON.parse(res.body);
        return {
          httpStatus: res.status,
          stateId: String(p.stateId ?? "?"),
          userUpdatedId: String(p.userUpdatedId ?? "?"),
        };
      } catch {
        return { httpStatus: res.status, stateId: null, userUpdatedId: null };
      }
    }

    const orderIdState = extractState(projAtOrderId);
    const projectIdState = projectId ? extractState(projAtProjectId) : null;

    const stateNames: Record<string, string> = {
      "-1": "New",
      "-2": "Reservation",
      "-3": "Confirmation",
      "-4": "Cancellation",
      "-5": "Arrived",
      "-100": "Pending online",
      "-101": "Payment started",
      "-102": "Paid online",
      // Custom (client-key-scoped) states staff actually work from. Without these
      // a debug dump prints a bare 8-digit id. Ids: lib/bmi-office-actions.ts
      // KIOSK_CONFIRMATION_STATE_IDS / VIP_CONFIRMATION_STATE_IDS.
      "3274635": "Confirmation + Waiver",
      "55397028": "Confirmation - Kiosk",
      "55466363": "Confirmation - VIP",
      "8489113": "Confirmation - Kiosk (Naples)",
    };

    const logEntry = {
      type: "post-confirm-verify",
      timestamp: new Date().toISOString(),
      clientKey,
      wNumber,
      orderId,
      projectId,
      orderIdMatchesProjectId: orderId === projectId,
      offset: projectId ? String(BigInt(projectId) - BigInt(orderId)) : null,
      orderIdLookup: {
        ...orderIdState,
        stateName: stateNames[orderIdState.stateId ?? ""] || orderIdState.stateId,
      },
      projectIdLookup: projectIdState
        ? {
            ...projectIdState,
            stateName: stateNames[projectIdState.stateId ?? ""] || projectIdState.stateId,
          }
        : null,
      isConfirmed: orderIdState.stateId === "-3" || projectIdState?.stateId === "-3",
      verdict:
        orderIdState.stateId === "-3" || projectIdState?.stateId === "-3"
          ? "OK — project in Confirmation"
          : orderId !== projectId
            ? `BUG — orderId≠projectId (offset ${projectId ? BigInt(projectId) - BigInt(orderId) : "?"}), ` +
              `neither in Confirmation (orderId=${orderIdState.stateId}, projectId=${projectIdState?.stateId})`
            : `BUG — payment/confirm returned 200 but project state is ${orderIdState.stateId} (${stateNames[orderIdState.stateId ?? ""] || "?"})`,
    };

    await redis.lpush("bmi:api:log", JSON.stringify(logEntry));
    await redis.ltrim("bmi:api:log", 0, 4999);

    console.log(
      `[post-confirm-verify] ${wNumber} orderId=${orderId} projectId=${projectId || "same"} ` +
        `offset=${logEntry.offset || "0"} orderIdState=${orderIdState.stateId} ` +
        `projectIdState=${projectIdState?.stateId || "n/a"} → ${logEntry.isConfirmed ? "OK" : "BUG"}`,
    );
  } catch (err) {
    console.error("[post-confirm-verify] failed:", err);
  }
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const endpoint = searchParams.get("endpoint");

  if (!endpoint || !ALLOWED_POST.some((e) => endpoint.startsWith(e))) {
    return NextResponse.json({ error: "Endpoint not allowed" }, { status: 403 });
  }

  // ── Vendor outage (maintenance mode) ────────────────────────────────────
  // The LAST line of defence while BMI is down: refuse the writes that OPEN a
  // sale, so a cached page, a tab left open mid-flow, or a surface we missed
  // can never create a bill we can't fulfil. Only booking/book + booking/sell
  // are refused — payment/confirm, removeItem, memo and the DELETE cancel stay
  // open so an already-charged session can finish and abandoned holds can still
  // be released (blocking teardown is how holds get stranded on heats).
  if (bmiWriteBlocked(endpoint)) {
    console.warn(`[bmi.maintenance] refused ${endpoint} — vendor outage active`);
    return NextResponse.json(
      {
        error: "Booking is temporarily unavailable — our booking vendor is having an outage.",
        maintenance: true,
      },
      { status: 503 },
    );
  }

  try {
    const clientKey = searchParams.get("clientKey") || BMI_CLIENT_KEY;
    if (!ALLOWED_CLIENTS.has(clientKey))
      return NextResponse.json({ error: "Invalid client" }, { status: 403 });
    const token = await getToken(clientKey);

    // Build upstream URL with query params
    const upstreamParams = new URLSearchParams();
    for (const [k, v] of searchParams) {
      if (k !== "endpoint" && k !== "clientKey") upstreamParams.set(k, v);
    }
    const qs = upstreamParams.toString();
    const url = `${BMI_API_URL}/public-booking/${clientKey}/${endpoint}${qs ? `?${qs}` : ""}`;

    // Pass request body as raw text to avoid JSON number precision loss on orderId
    const bodyStr = await req.text();

    // Availability read-through cache — HIT returns the stored raw text
    // without touching BMI (the grids poll every 30s; see cache block above).
    const availKey =
      endpoint === "availability"
        ? availabilityCacheKey(clientKey, searchParams.get("date"), bodyStr)
        : null;
    if (availKey) {
      try {
        const cached = await redis.get(availKey);
        if (cached) {
          return new NextResponse(cached, {
            status: 200,
            headers: { "Content-Type": "application/json", "X-Bmi-Cache": "hit" },
          });
        }
      } catch {
        /* fall open to upstream */
      }
    }

    console.log(`[BMI POST] ${url}`);

    const upstream = await fetch(url, {
      method: "POST",
      headers: bmiHeaders(token),
      body: bodyStr,
      cache: "no-store",
    });

    const rawText = await upstream.text();
    console.log(`[BMI POST] ${endpoint} → ${upstream.status} (${rawText.length} bytes)`);

    if (availKey && upstream.ok) {
      try {
        await redis.set(availKey, rawText, "EX", AVAIL_CACHE_TTL_S);
        await redis.sadd(availCacheIndexKey(clientKey), availKey);
        await redis.expire(availCacheIndexKey(clientKey), AVAIL_INDEX_TTL_S);
      } catch {
        /* best-effort */
      }
    }

    // Any successful booking WRITE invalidates the availability cache — every
    // polling grid (this device and every other one) converges within one
    // poll, and an own-session post-hold refetch reads truly fresh data.
    if (
      upstream.ok &&
      (endpoint.startsWith("booking/book") ||
        endpoint.startsWith("booking/sell") ||
        endpoint.startsWith("booking/removeItem"))
    ) {
      await purgeAvailabilityCache(clientKey);
    }

    // Log all booking-related calls to Redis for BMI evidence
    const LOGGED_ENDPOINTS = [
      "booking/book",
      "booking/sell",
      "booking/memo",
      "booking/removeItem",
      "payment/confirm",
      "person/registerContactPerson",
      "person/registerProjectPerson",
    ];
    const orderIdMatch = bodyStr.match(/"orderId"\s*:\s*(\d+)/);
    const resNumMatch = rawText.match(/"reservationNumber"\s*:\s*"(W\d+)"/);
    const personIdMatch = bodyStr.match(/"personId"\s*:\s*(\d+)/);

    if (LOGGED_ENDPOINTS.some((e) => endpoint.startsWith(e))) {
      try {
        const logEntry = JSON.stringify({
          endpoint,
          timestamp: new Date().toISOString(),
          clientKey,
          httpStatus: upstream.status,
          orderId: orderIdMatch?.[1] || null,
          wNumber: resNumMatch?.[1] || null,
          personId: personIdMatch?.[1] || null,
          request: bodyStr.substring(0, 1000),
          response: rawText.substring(0, 1000),
        });
        await redis.lpush("bmi:api:log", logEntry);
        await redis.ltrim("bmi:api:log", 0, 4999);
      } catch {
        // Redis failure is non-fatal
      }
    }

    // Mirror booking/memo writes into OUR reservation notes so the admin
    // Notes tab shows what BMI got (owner request 2026-07-08) — this covers
    // the race-disclaimer memo and the confirmation page's combined combo
    // memo, both of which flow through this proxy. Best-effort; replace-
    // placeholder/append semantics in the helper protect staff edits.
    if (endpoint.startsWith("booking/memo") && upstream.ok && orderIdMatch?.[1]) {
      try {
        // Quote the raw orderId digits BEFORE parsing so JSON.parse can't
        // round the 17-digit id; we only need the (properly unescaped) memo.
        const parsed = JSON.parse(bodyStr.replace(/"orderId"\s*:\s*(\d+)/, '"orderId":"$1"')) as {
          memo?: unknown;
        };
        if (typeof parsed.memo === "string" && parsed.memo.trim()) {
          await mirrorMemoIntoNotesByBillId(orderIdMatch[1], parsed.memo);
        }
      } catch {
        /* non-fatal — notes mirror never affects the BMI write */
      }
    }

    // After successful payment/confirm, verify the project state via
    // BMI's own Office API and log the result. This is the smoking gun:
    // "Your API said 200 OK but your Office shows state -101."
    if (
      endpoint === "payment/confirm" &&
      upstream.status === 200 &&
      orderIdMatch?.[1] &&
      resNumMatch?.[1]
    ) {
      // Brief delay to let BMI's internal state settle
      await new Promise((r) => setTimeout(r, 2000));
      await verifyPostConfirm(clientKey, orderIdMatch[1], resNumMatch[1]);
    }
    return new NextResponse(rawText, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "BMI API error" },
      { status: 500 },
    );
  }
}

// ── DELETE handler ────────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const endpoint = searchParams.get("endpoint");

  if (!endpoint || !ALLOWED_DELETE.some((e) => endpoint.startsWith(e))) {
    return NextResponse.json({ error: "Endpoint not allowed" }, { status: 403 });
  }

  try {
    const clientKey = searchParams.get("clientKey") || BMI_CLIENT_KEY;
    if (!ALLOWED_CLIENTS.has(clientKey))
      return NextResponse.json({ error: "Invalid client" }, { status: 403 });

    // ── Captured-money guard (2026-08-10, W59702 / $420.68) ─────────────────
    // The kiosk exit unwind (idle reset / Start Over / update reload) cancels
    // its session bill through this handler. An unwind may only release what
    // is still merely HELD: if the tender ledger says money was captured and
    // no booking row exists yet, this bill is the captured-no-reserve resume's
    // anchor — cancelling it makes the payment unrecoverable in place (every
    // Square idempotency key derives from the bill id). Refuse with 409; old
    // kiosk clients already treat a non-confirmed cancel as log-and-move-on
    // (the 1.16.8 backstop), so nothing user-facing breaks. Tooling that has
    // verified the money (refunded / moved) may pass force=1.
    const cancelMatch = endpoint.match(/^bill\/(\d+)\/cancel$/);
    if (cancelMatch) {
      const guard = await guardBillCancel(cancelMatch[1], searchParams.get("force") === "1");
      if (guard.blocked) {
        console.error(
          `[bmi.delete] REFUSED bill/${cancelMatch[1]}/cancel — ${guard.reason}. ` +
            `The resume/tender-sweep owns this bill; use force=1 only after the money is accounted for.`,
        );
        return NextResponse.json(
          {
            success: false,
            code: "CAPTURED_UNRESERVED",
            error:
              "This bill has a captured payment and no booking yet — cancelling it would strand the money. " +
              "Finish or resume the checkout instead; staff tooling may retry with force=1 after verifying the payment.",
          },
          { status: 409 },
        );
      }
    }

    const token = await getToken(clientKey);
    const url = `${BMI_API_URL}/public-booking/${clientKey}/${endpoint}`;

    const upstream = await fetch(url, {
      method: "DELETE",
      headers: bmiHeaders(token),
      cache: "no-store",
    });

    // Cancel returns raw `true`/`false`
    const text = await upstream.text();
    // A bill cancel frees every heat it held — purge the availability cache so
    // the polling grids see the freed capacity within one poll.
    if (upstream.ok) await purgeAvailabilityCache(clientKey);
    // Bill cancels release abandoned holds (kiosk start-over / idle timeout) —
    // an unlogged failure here leaves a reservation blocking its heats, so every
    // outcome must be traceable in the runtime logs (7/19 incident).
    const logLine = `[bmi.delete] ${clientKey} ${endpoint} → ${upstream.status} ${text.slice(0, 120)}`;
    if (upstream.ok && text === "true") console.log(logLine);
    else console.error(logLine);
    // Normalize the reply BEFORE it leaves the proxy. BMI's bare `true`
    // JSON-parses to the boolean `true`, so callers that (reasonably) looked for
    // `{success:true}` saw `undefined` and logged every successful cancel as a
    // failure — for a year, on every kiosk start-over (2026-08-04, proven on
    // bill 63000000007234468: three "not confirmed" attempts against an Office
    // project that was already fully cancelled). A boolean body becomes
    // `{success:<bool>}`; object bodies (BMI's error envelopes) pass through.
    try {
      const parsed: unknown = JSON.parse(text);
      return NextResponse.json(typeof parsed === "boolean" ? { success: parsed } : parsed, {
        status: upstream.status,
      });
    } catch {
      return NextResponse.json({ success: text === "true" }, { status: upstream.status });
    }
  } catch (err) {
    console.error(`[bmi.delete] ${endpoint} threw:`, err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "BMI API error" },
      { status: 500 },
    );
  }
}
