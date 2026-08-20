import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * Voxtelesys INBOUND (MO — Mobile Originated) webhook receiver.
 *
 * ── LISTEN-ONLY. This route mutates NO consent state. ───────────────
 * Step 1 of the SMS compliance bring-up (`tasks/sms-compliance-plan.md`):
 * capture real MO payloads so the keyword parser is written against a
 * verified shape instead of a guess. Suppression writes land in a
 * follow-up PR, behind the auth this route already installs.
 *
 * Why a separate route from `../route.ts` (the DR/delivery-receipt
 * webhook), even though both are "Vox posts to us":
 *
 *   1. Different auth posture. The DR route is public and unauthenticated,
 *      which is tolerable — worst case someone writes a wrong delivery
 *      status into an admin log. The moment the same URL can flip
 *      `opted_in`, it becomes a consent-tampering vector: anyone who
 *      finds it could unsubscribe guests from their e-tickets, or
 *      re-subscribe someone who opted out (making every later send
 *      unconsented on a forged record). Hence `?k=` below.
 *   2. Different configuration rail. The DR webhook is registered
 *      PER MESSAGE via the `status_callback` parameter on every send
 *      (`lib/sms-retry.ts` voxSendOnce). MO is configured ON THE DID
 *      itself, in the Vox portal's Messaging Application.
 *   3. Its own hit counter. The DR counter is dominated by outbound
 *      traffic, so it cannot prove the A2P/P2P isolation test — "text
 *      `cancel my 4pm` to a call-center DID and confirm OUR counter
 *      does not move" needs a counter only inbound touches.
 *   4. Its own payload stash. The DR route keeps a SINGLE
 *      `lastPayload` key, clobbered by the next delivery receipt —
 *      seconds of retention on a busy day. We keep a ring buffer so a
 *      whole test sweep survives.
 *
 * Bound DID: **+1 239 441 2867** — the centralized A2P sender, on the
 * existing approved TCR campaign, voice routed to 3CX (Fla. Stat.
 * § 501.059(8)(b) wants a number that answers). Attached in the Vox
 * portal, NOT in code: this route is number-agnostic on purpose, so the
 * DID can be re-pointed without a deploy.
 *
 * Payload shape: deliberately NOT asserted. Vox does not publish the MO
 * shape, and the DR route already learned this the hard way — Vox
 * renamed `id` → `message_id` between API versions and `../route.ts:129-133`
 * has to accept both. So we store the raw body plus the content type,
 * try JSON and then form-encoding, and read nothing we do not have to.
 *
 * The plan's "reject any payload whose `to` is not our A2P DID" guard is
 * deliberately NOT here yet — we do not know which key carries `to`.
 * It lands in the parser PR, written against the captured corpus.
 *
 * Header capture: we also stash the request's header names (values
 * redacted for `authorization` / `cookie`). This answers a question Vox
 * support has not — whether the MO webhook carries any signature we
 * could verify — without waiting on them.
 *
 * Always returns 200 once a body is read. Non-2xx makes Vox retry up to
 * ~5 times, and a retry storm on a listen-only endpoint buys nothing.
 */

/** Keep the last N inbound payloads. A full bring-up sweep is ~8 texts
 *  (STOP / stop / Stop. / trailing space / sentence-embedded / HELP /
 *  START / normal sentence); 50 leaves room to repeat it. */
const RING_SIZE = 50;
const RING_KEY = "sms-webhook:vox:mo:recent";
const RING_TTL = 60 * 60 * 24 * 30;

/** Cap each stored body. MO bodies are one SMS; 2KB is generous. */
const MAX_BODY = 2048;

function todayEt(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Headers whose VALUES are safe to keep. Everything else contributes its
 *  name only.
 *
 *  This is an allowlist, not a denylist, because a denylist already failed
 *  here: the first real capture arrived through Vercel's proxy carrying
 *  `x-vercel-oidc-token` (a signed production-scoped identity JWT),
 *  `x-vercel-proxy-signature`, and an `x-vercel-sc-headers` blob with its
 *  own bearer token inside. Redacting `authorization` and `cookie` caught
 *  none of them. An allowlist cannot leak the next credential header
 *  nobody thought of. */
const HEADER_VALUE_ALLOWLIST = new Set([
  "content-type",
  "content-length",
  "user-agent",
  "accept",
  "accept-encoding",
  "date",
]);

/** Values for the allowlisted headers, names for everything else.
 *
 *  Names alone still answer the question this capture exists to answer --
 *  whether Voxtelesys signs MO callbacks -- since a signature header
 *  would show up in `otherHeaderNames` and we could then allowlist it
 *  deliberately. (First capture: it does not. The only signature-shaped
 *  headers came from Vercel's own proxy, and `user-agent` is
 *  `VoxtelesysProxy/1.0`.) */
function captureHeaders(req: NextRequest): {
  values: Record<string, string>;
  otherHeaderNames: string[];
} {
  const values: Record<string, string> = {};
  const otherHeaderNames: string[] = [];
  req.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HEADER_VALUE_ALLOWLIST.has(k)) {
      values[k] = value;
    } else {
      otherHeaderNames.push(k);
    }
  });
  otherHeaderNames.sort();
  return { values, otherHeaderNames };
}

/** Best-effort decode for logging only. Tries JSON, then form-encoding.
 *  Returns null when neither parses — the raw body is stored either way,
 *  which is the whole point of this route. */
function decodeBody(raw: string, contentType: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to form decoding */
    }
  }
  if (
    contentType.includes("x-www-form-urlencoded") ||
    (!trimmed.startsWith("{") && trimmed.includes("="))
  ) {
    try {
      return Object.fromEntries(new URLSearchParams(trimmed));
    } catch {
      /* not form-encoded either */
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  const day = todayEt();
  const receivedAt = new Date().toISOString();

  // Auth. `VOX_MO_TOKEN` unset = bring-up mode: accept everything, and
  // say so in ?stats=1 so an un-secured endpoint cannot go unnoticed.
  // Once set, a bad token is counted and dropped — never 500'd, so Vox
  // does not retry a request we will never accept.
  // Accepted two ways so we can use whatever the Vox portal's
  // "Authentication" column actually offers on this application: a
  // Bearer header if it supports one, else the `?k=` query param. The
  // 3CX application on the same trunk group runs `Authentication: none`
  // with an unguessable path segment, so a query token is the realistic
  // fallback rather than a compromise.
  const expected = process.env.VOX_MO_TOKEN || "";
  const supplied =
    new URL(req.url).searchParams.get("k") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const authed = expected === "" || supplied === expected;

  try {
    const tx = redis.multi();
    tx.incr(`sms-webhook:vox:mo:hits:${day}`);
    tx.expire(`sms-webhook:vox:mo:hits:${day}`, RING_TTL);
    tx.set("sms-webhook:vox:mo:lastHit", receivedAt, "EX", RING_TTL);
    if (!authed) {
      tx.incr(`sms-webhook:vox:mo:rejected:${day}`);
      tx.expire(`sms-webhook:vox:mo:rejected:${day}`, RING_TTL);
    }
    await tx.exec();
  } catch {
    /* counter is best-effort — never block on it */
  }

  if (!authed) {
    console.warn("[sms-webhook/vox/mo] rejected: bad or missing ?k= token");
    return NextResponse.json({ ok: false, error: "unauthorized" });
  }

  let raw = "";
  try {
    raw = await req.text();
  } catch (err) {
    console.warn("[sms-webhook/vox/mo] body read failed:", err);
    return NextResponse.json({ ok: false, error: "unreadable body" });
  }

  const contentType = req.headers.get("content-type") || "";
  const decoded = decodeBody(raw, contentType);

  // The capture itself. Raw body is the load-bearing field — `decoded`
  // is a convenience and may be null.
  try {
    const record = JSON.stringify({
      receivedAt,
      contentType,
      raw: raw.slice(0, MAX_BODY),
      decoded,
      ...captureHeaders(req),
    });
    const tx = redis.multi();
    tx.lpush(RING_KEY, record);
    tx.ltrim(RING_KEY, 0, RING_SIZE - 1);
    tx.expire(RING_KEY, RING_TTL);
    await tx.exec();
  } catch (err) {
    console.warn("[sms-webhook/vox/mo] stash failed:", err);
  }

  // Log a one-liner too, so Vercel logs show the sweep even if Redis is
  // unavailable. No PII beyond what Vox just sent us.
  console.log(
    `[sms-webhook/vox/mo] inbound ct=${contentType || "none"} bytes=${raw.length} ` +
      `decoded=${decoded ? "yes" : "no"}`,
  );

  // LISTEN-ONLY: no consent write, no auto-reply. Deliberate.
  return NextResponse.json({ ok: true, captured: true, mode: "listen-only" });
}

/** GET serves two purposes: a 200 for Vox's endpoint validation when it
 *  saves the Messaging Application, and — with `?stats=1` — the captured
 *  sweep, so payload shapes can be read without Vercel log access.
 *
 *  Reading ALWAYS requires a matching secret — including in bring-up
 *  mode. The asymmetry against POST is deliberate: POST stays lenient
 *  with no token so a portal misconfiguration cannot silently lose
 *  captures, but what it captures is guest message bodies and mobile
 *  numbers. An unset env var must never turn that into a public endpoint.
 *
 *  Accepts `CRON_SECRET` as well as `VOX_MO_TOKEN`, so reading needs no
 *  new secret — CRON_SECRET already guards this app's privileged
 *  endpoints. They are NOT interchangeable in the other direction:
 *  whatever we hand Voxtelesys sits in their portal config, their logs,
 *  and our request logs, so the portal URL must never carry CRON_SECRET.
 *  A dedicated VOX_MO_TOKEN keeps that blast radius at "someone reads
 *  the capture buffer" instead of "someone runs our crons." */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  if (url.searchParams.get("stats") !== "1") {
    return NextResponse.json({ ok: true, hint: "POST Voxtelesys MO callbacks here" });
  }

  const accepted = [process.env.CRON_SECRET, process.env.VOX_MO_TOKEN].filter(
    (s): s is string => typeof s === "string" && s !== "",
  );
  if (accepted.length === 0) {
    return NextResponse.json({
      ok: false,
      error: "stats unavailable: no CRON_SECRET or VOX_MO_TOKEN configured",
    });
  }
  const supplied = url.searchParams.get("k") || "";
  if (!accepted.includes(supplied)) {
    return NextResponse.json({ ok: false, error: "unauthorized" });
  }

  const day = todayEt();
  try {
    const [hits, rejected, lastHit, recent] = await Promise.all([
      redis.get(`sms-webhook:vox:mo:hits:${day}`),
      redis.get(`sms-webhook:vox:mo:rejected:${day}`),
      redis.get("sms-webhook:vox:mo:lastHit"),
      redis.lrange(RING_KEY, 0, RING_SIZE - 1),
    ]);
    return NextResponse.json({
      ok: true,
      mode: "listen-only",
      // Whether the POST path is secured. False means the endpoint is
      // accepting unauthenticated inbound — fine during bring-up, but it
      // should not stay that way unnoticed.
      postTokenConfigured: (process.env.VOX_MO_TOKEN || "") !== "",
      hitsToday: hits ? parseInt(hits, 10) : 0,
      rejectedToday: rejected ? parseInt(rejected, 10) : 0,
      lastHit: lastHit || null,
      captured: recent.map(safeJson),
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "stats read failed",
    });
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
