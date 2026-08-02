import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { randomUUID } from "crypto";
import redis from "@/lib/redis";
import { checkinOtpBypassAllowed } from "~/features/kiosk/checkin/server";

// ── Config ──────────────────────────────────────────────────────────────────

const OFFICE_HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
// Base64-encoded to avoid dotenv $variable expansion: JGMxbjFlbGxv = $c1n1ello
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const OFFICE_PASS = Buffer.from(OFFICE_PASS_B64, "base64").toString();
const SMS_VERSION = "6251006 202511051229";

// ── HTTPS helpers (Node fetch/undici doesn't work with this API) ────────────

function httpsGet(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: OFFICE_HOST, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

function httpsPost(
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: OFFICE_HOST,
        path,
        method: "POST",
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.write(body);
    req.end();
  });
}

// ── Token cache ─────────────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getOfficeToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) {
    return cachedToken;
  }

  const body = `grant_type=password&username=${OFFICE_USER}&password=${OFFICE_PASS}`;
  console.log(`[BMI Office auth] user=${OFFICE_USER}`);
  const res = await httpsPost("/auth/token", body, {
    "Content-Type": "application/x-www-form-urlencoded",
    clientkey: CLIENT_KEY,
    "x-fast-version": SMS_VERSION,
  });

  if (res.status !== 200) {
    console.error(`[BMI Office auth] ${res.status}: ${res.body}`);
    throw new Error(`Office auth failed: ${res.status}`);
  }

  const data = JSON.parse(res.body);
  cachedToken = data.access_token;
  const expiresIn = parseInt(data.expires_in || "86400", 10);
  tokenExpiry = Date.now() + expiresIn * 1000;

  return cachedToken!;
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    clientkey: CLIENT_KEY,
  };
}

// ── Guest-verification gate (2026-07-18) ────────────────────────────────────
//
// This proxy exposes racer PII (names, birthdates, phones, emails, login
// codes, credit balances). It used to be fully unauthenticated — anyone could
// enumerate `?action=person&id=…`. Now:
//
//   search   — open (the lookup UIs must find the account BEFORE the OTP is
//              sent) but rate-limited per IP.
//   person   — requires ONE of:
//                • x-internal-key header === CRON_SECRET (server-to-server),
//                • a verified-session cookie (issued below),
//                • ?verify=phone:<digits> / email:<addr> matching the Redis
//                  flag `sms-verify` PUT sets on a successful OTP,
//                • ?code=<loginCode> that MATCHES the fetched person's BMI
//                  login-code tag (validated server-side AFTER the upstream
//                  fetch; on mismatch nothing is returned). Keeps the
//                  web/kiosk login-code mode working — the code itself is
//                  the secret, now actually enforced.
//              A successful person fetch marks `verified:person:<id>` and
//              issues the session cookie, so follow-up deposits + the
//              post-verification flows (linked family, credit refetches)
//              work without re-proving.
//   deposits — requires internal key, session cookie, verify flag, or a
//              prior verified person fetch (`verified:person:<personId>`).
//   project  — open (no customer PII; used by post-payment confirmations).
//
// Client lookup flows were reordered to match (OTP verify BEFORE the
// person/deposits fetch) — see ReturningRacerLookup + RacePackFlow.

const VERIFIED_SESSION_COOKIE = "bmi_lookup_session";
const SESSION_TTL_S = 900; // 15 min — covers account pick + linked-family adds
const RATE_LIMITS: Record<string, number> = { search: 30, person: 60, deposits: 60 };

function normalizePhoneDigits(raw: string): string {
  return raw.replace(/\D/g, "").replace(/^1/, "");
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : null)?.trim() || "unknown";
}

/** Sliding 5-minute per-IP counter. Fails OPEN on Redis errors. */
async function rateLimited(req: NextRequest, action: string): Promise<boolean> {
  const limit = RATE_LIMITS[action];
  if (!limit) return false;
  try {
    const key = `rl:bmi-office:${action}:${clientIp(req)}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 300);
    return count > limit;
  } catch {
    return false;
  }
}

function isInternal(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.get("x-internal-key") === secret;
}

async function hasVerifiedSession(req: NextRequest): Promise<boolean> {
  const tok = req.cookies.get(VERIFIED_SESSION_COOKIE)?.value;
  if (!tok || !/^[a-f0-9][a-f0-9-]{10,40}$/i.test(tok)) return false;
  try {
    return (await redis.get(`verified:session:${tok}`)) === "1";
  } catch {
    return false;
  }
}

/** ?verify=phone:<digits> | email:<addr> → the flag sms-verify PUT wrote. */
async function verifyParamOk(searchParams: URLSearchParams): Promise<boolean> {
  const verify = searchParams.get("verify") || "";
  try {
    if (verify.startsWith("phone:")) {
      const digits = normalizePhoneDigits(verify.slice(6));
      return digits.length >= 10 && (await redis.get(`verified:${digits}`)) === "1";
    }
    if (verify.startsWith("email:")) {
      const email = verify.slice(6).trim().toLowerCase();
      return email.includes("@") && (await redis.get(`verified:email:${email}`)) === "1";
    }
  } catch {
    /* fall through */
  }
  return false;
}

/** Issue (or renew) the verified-session cookie on a response. */
async function grantSession(req: NextRequest, res: NextResponse): Promise<void> {
  try {
    let tok = req.cookies.get(VERIFIED_SESSION_COOKIE)?.value;
    if (!tok || !/^[a-f0-9][a-f0-9-]{10,40}$/i.test(tok)) tok = randomUUID();
    await redis.set(`verified:session:${tok}`, "1", "EX", SESSION_TTL_S);
    res.cookies.set(VERIFIED_SESSION_COOKIE, tok, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_TTL_S,
      path: "/",
    });
  } catch {
    /* cookie grant is best-effort — the verify flag still covers this request */
  }
}

/** Extract the person's login-code tags (BMI person.tags[].tag). */
function personLoginCodes(person: unknown): string[] {
  const tags = (person as { tags?: Array<{ tag?: unknown }> })?.tags;
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) =>
      String(t?.tag ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

// ── GET handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    const token = await getOfficeToken();

    // Person search by email/name — open (pre-OTP account discovery) but
    // rate-limited: enumeration now costs 30 requests per 5 min per IP.
    if (action === "search") {
      if (await rateLimited(req, "search")) {
        return NextResponse.json(
          { error: "Too many lookups — try again shortly" },
          { status: 429 },
        );
      }
      const query = searchParams.get("q") || "";
      const max = searchParams.get("max") || "20";
      if (!query) {
        return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
      }

      const path = `/api/${CLIENT_KEY}/search/person?token=${encodeURIComponent(query)}&maxResults=${max}`;
      const res = await httpsGet(path, apiHeaders(token));
      console.log(`[BMI Office search] ${res.status} (${query})`);

      if (res.status >= 400) {
        // Token might be stale — clear and retry
        cachedToken = null;
        tokenExpiry = 0;
        const newToken = await getOfficeToken();
        const retry = await httpsGet(path, apiHeaders(newToken));
        return NextResponse.json(JSON.parse(retry.body), {
          status: retry.status >= 400 ? 500 : 200,
        });
      }

      return NextResponse.json(JSON.parse(res.body));
    }

    // Person details by ID — full PII: verification required (see gate doc).
    if (action === "person") {
      const id = searchParams.get("id") || "";
      if (!id) {
        return NextResponse.json({ error: "Missing id parameter" }, { status: 400 });
      }
      if (await rateLimited(req, "person")) {
        return NextResponse.json(
          { error: "Too many lookups — try again shortly" },
          { status: 429 },
        );
      }

      const internal = isInternal(req);
      const loginCode = (searchParams.get("code") || "").trim().toLowerCase();
      // Test-kiosk OTP bypass (kiosk 99, owner 2026-08-02): honored ONLY when
      // the claimed kioskId is on the server's env allowlist
      // (KIOSK_CHECKIN_OTP_BYPASS_KIOSK_IDS — default unset, off). Same
      // spoofability trade-off as the check-in bypass: list it only while
      // testing.
      const testBypass = checkinOtpBypassAllowed(searchParams.get("kioskId"));
      if (testBypass) {
        console.warn(
          `[bmi-office] OTP TEST-BYPASS person fetch by ${searchParams.get("kioskId")} (${clientIp(req)})`,
        );
      }
      const preAuthed =
        internal ||
        testBypass ||
        (await hasVerifiedSession(req)) ||
        (await verifyParamOk(searchParams));
      if (!preAuthed && !loginCode) {
        return NextResponse.json(
          { error: "Verification required", verificationRequired: true },
          { status: 403 },
        );
      }

      const path = `/api/${CLIENT_KEY}/person/${id}`;
      const res = await httpsGet(path, apiHeaders(token));
      if (res.status >= 400) {
        return NextResponse.json(JSON.parse(res.body), { status: 500 });
      }
      const person = JSON.parse(res.body);

      // Login-code mode: the typed code must MATCH this person's BMI tag —
      // otherwise nothing is returned (a wrong code can't harvest PII).
      if (!preAuthed && loginCode && !personLoginCodes(person).includes(loginCode)) {
        return NextResponse.json(
          { error: "Verification required", verificationRequired: true },
          { status: 403 },
        );
      }

      // Success → deposits for this person + follow-up lookups may proceed.
      await redis.set(`verified:person:${id}`, "1", "EX", SESSION_TTL_S).catch(() => {});
      const response = NextResponse.json(person);
      if (!internal) await grantSession(req, response);
      return response;
    }

    // Project details by ID (returns projectReference for waiver link)
    if (action === "project") {
      const id = searchParams.get("id") || "";
      if (!id) {
        return NextResponse.json({ error: "Missing id parameter" }, { status: 400 });
      }

      const path = `/api/${CLIENT_KEY}/project/${id}`;
      const res = await httpsGet(path, apiHeaders(token));
      if (res.status >= 400) {
        // Token might be stale
        cachedToken = null;
        tokenExpiry = 0;
        const newToken = await getOfficeToken();
        const retry = await httpsGet(path, apiHeaders(newToken));
        return NextResponse.json(JSON.parse(retry.body), {
          status: retry.status >= 400 ? 500 : 200,
        });
      }
      return NextResponse.json(JSON.parse(res.body));
    }

    // Deposit history — credit balances: verification required (see gate doc).
    if (action === "deposits") {
      const personId = searchParams.get("personId") || "";
      if (!personId) {
        return NextResponse.json({ error: "Missing personId parameter" }, { status: 400 });
      }
      if (await rateLimited(req, "deposits")) {
        return NextResponse.json(
          { error: "Too many lookups — try again shortly" },
          { status: 429 },
        );
      }
      const depositsAuthed =
        isInternal(req) ||
        (await hasVerifiedSession(req)) ||
        (await verifyParamOk(searchParams)) ||
        (await redis.get(`verified:person:${personId}`).catch(() => null)) === "1";
      if (!depositsAuthed) {
        return NextResponse.json(
          { error: "Verification required", verificationRequired: true },
          { status: 403 },
        );
      }
      // Default: look back 2 years
      const now = new Date();
      const from =
        searchParams.get("from") ||
        new Date(now.getFullYear() - 2, now.getMonth(), now.getDate()).toISOString().split(".")[0];
      const until = searchParams.get("until") || now.toISOString().split(".")[0];

      const path = `/api/${CLIENT_KEY}/deposit/history?personId=${personId}&from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`;
      const res = await httpsGet(path, apiHeaders(token));
      if (res.status >= 400) {
        cachedToken = null;
        tokenExpiry = 0;
        const newToken = await getOfficeToken();
        const retry = await httpsGet(path, apiHeaders(newToken));
        return NextResponse.json(JSON.parse(retry.body), {
          status: retry.status >= 400 ? 500 : 200,
        });
      }
      return NextResponse.json(JSON.parse(res.body));
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Office API error" },
      { status: 500 },
    );
  }
}
