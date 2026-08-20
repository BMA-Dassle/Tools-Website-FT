import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { randomInt } from "crypto";
import { a2pSender } from "~/features/sms/sender";

// ── Voxtelesys config ─────────────────────────────────────────────────────
const VOX_API_KEY = process.env.VOX_API_KEY || "";
const VOX_FROM = a2pSender();

// ── SendGrid config (for email OTP) ─────────────────────────────────────────
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";

const CODE_TTL = 300; // 5 minutes (SMS — texts land in seconds)
const EMAIL_CODE_TTL = 600; // 10 minutes — email delivery is slower, and kiosk guests
// have to pull out a phone and dig the message out of spam/Promotions first.
const EMAIL_CODE_MAX_AGE_MS = 30 * 60_000; // hard cap on how long resends can keep one code alive
const MAX_ATTEMPTS = 3;

/** Normalize phone to digits only */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, ""); // strip +1 or leading 1
}

/** Send SMS via Voxtelesys API */
async function sendSms(to: string, body: string, fromOverride?: string): Promise<boolean> {
  if (!VOX_API_KEY) {
    console.error("[sms-verify] Missing VOX_API_KEY");
    return false;
  }
  const toFormatted = to.length === 10 ? `+1${to}` : `+${to}`;

  const res = await fetch("https://smsapi.voxtelesys.net/api/v2/sms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${VOX_API_KEY}`,
    },
    body: JSON.stringify({
      to: toFormatted,
      from: fromOverride || VOX_FROM,
      body,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[sms-verify] Voxtelesys error:", res.status, err);
    return false;
  }
  return true;
}

/** Send OTP email via SendGrid */
async function sendEmailOtp(to: string, code: string): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    console.error("[sms-verify] No SENDGRID_API_KEY");
    return false;
  }
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: "FastTrax Entertainment" },
      subject: "Your FastTrax Verification Code",
      content: [
        {
          type: "text/plain",
          value: `Your FastTrax verification code is: ${code}\n\nThis code expires in 10 minutes.`,
        },
        {
          type: "text/html",
          value: `<div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:20px"><h2 style="color:#000418">FastTrax Verification</h2><p>Your verification code is:</p><div style="background:#f0f0f0;border-radius:8px;padding:20px;text-align:center;font-size:32px;letter-spacing:8px;font-weight:bold;color:#000418">${code}</div><p style="color:#666;font-size:12px;margin-top:16px">This code expires in 10 minutes.</p></div>`,
        },
      ],
    }),
  });
  if (!res.ok) {
    console.error("[sms-verify] SendGrid error:", res.status, await res.text());
    return false;
  }
  return true;
}

/**
 * POST — Send verification code via SMS or email
 * Body: { phone: "2397762044" } OR { email: "user@example.com" }
 * Returns: { sent: true } or { error: "..." }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { phone, email, from, brand } = body;

    if (!phone && !email)
      return NextResponse.json({ error: "Phone or email required" }, { status: 400 });

    // Generate unique 6-digit code
    let code = String(randomInt(100000, 999999));

    if (phone) {
      // SMS flow
      const normalized = normalizePhone(phone);
      if (normalized.length !== 10) {
        return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
      }
      await redis.set(
        `smsverify:${normalized}`,
        JSON.stringify({ code, attempts: 0, createdAt: new Date().toISOString() }),
        "EX",
        CODE_TTL,
      );
      // BRANDING ONLY. `brand` is the explicit field; `from` is a
      // legacy DID-shaped hint some callers still send. Neither
      // selects the sender -- that is always a2pSender().
      const isHeadPinz = brand ? brand === "headpinz" : Boolean(from);
      const smsBody = isHeadPinz
        ? `Your HeadPinz verification code is: ${code}`
        : `Your FastTrax verification code is: ${code}`;
      // `from` is a legacy brand hint from the caller, NOT a sender.
      // The DID always comes from a2pSender() -- a client must not
      // get to pick which of our numbers we send from.
      const sent = await sendSms(normalized, smsBody);
      if (!sent) return NextResponse.json({ error: "Failed to send SMS" }, { status: 500 });
      console.log(
        `[sms-verify] SMS code sent to ${normalized.slice(0, 3)}***${normalized.slice(-4)}`,
      );
    } else {
      // Email flow
      const normalized = email.trim().toLowerCase();
      const key = `smsverify:email:${normalized}`;
      // Resend-safe: guests tap "Resend code" when the email is slow to land, and a
      // fresh code would invalidate every email already in flight — the guest then
      // types a code that WAS valid and is told "Incorrect code" (kiosk manager
      // reports 2026-07-27; one guest requested 5 codes in 5 minutes). Reuse the
      // outstanding code so every delivered email works. The attempt counter
      // carries over so resending never resets brute-force protection, and
      // EMAIL_CODE_MAX_AGE_MS stops repeated resends from keeping one code alive
      // indefinitely.
      let payload = { code, attempts: 0, createdAt: new Date().toISOString() };
      let reused = false;
      const existing = await redis.get(key).catch(() => null);
      if (existing) {
        try {
          const prev = JSON.parse(existing);
          const age = Date.now() - Date.parse(String(prev.createdAt ?? ""));
          if (prev.code && (prev.attempts ?? 0) < MAX_ATTEMPTS && age < EMAIL_CODE_MAX_AGE_MS) {
            code = String(prev.code);
            payload = prev;
            reused = true;
          }
        } catch {
          // Unparseable stored value — fall through to the fresh code.
        }
      }
      await redis.set(key, JSON.stringify(payload), "EX", EMAIL_CODE_TTL);
      const sent = await sendEmailOtp(normalized, code);
      if (!sent) return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
      console.log(
        `[sms-verify] Email code ${reused ? "re-sent" : "sent"} to ${normalized.slice(0, 3)}***`,
      );
    }

    return NextResponse.json({ sent: true });
  } catch (err) {
    console.error("[sms-verify] POST error:", err);
    return NextResponse.json({ error: "Failed to send code" }, { status: 500 });
  }
}

// ── Square config (for post-verify customer fetch) ──────────────────────
const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";

/**
 * PUT — Verify code
 * Body: { phone: "2397762044", code: "123456", squareCustomerId?: "..." }
 *       OR { email: "x@y.com", code: "123456" }
 *
 * Returns: { verified: true, customer?: {...} } or { verified: false, attemptsLeft: N }
 *
 * When squareCustomerId is provided and the code is correct, fetches the
 * Square customer record and returns it inline. This is the ONLY path that
 * exposes customer PII — the lookup endpoint deliberately withholds it.
 */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { phone, email, code, squareCustomerId } = body;
    if ((!phone && !email) || !code)
      return NextResponse.json({ error: "Phone/email and code required" }, { status: 400 });

    const redisKey = phone
      ? `smsverify:${normalizePhone(phone)}`
      : `smsverify:email:${email.trim().toLowerCase()}`;
    // Masked identifier for logs — failed verifies were previously invisible,
    // which hid the kiosk "invalid code" reports (2026-07-27) until managers
    // escalated. Never log the full phone/email.
    const idMask = phone
      ? `${normalizePhone(phone).slice(0, 3)}***${normalizePhone(phone).slice(-4)}`
      : `${email.trim().toLowerCase().slice(0, 3)}***`;
    const stored = await redis.get(redisKey);
    if (!stored) {
      console.log(`[sms-verify] Verify failed for ${idMask}: no code outstanding (expired?)`);
      return NextResponse.json({
        verified: false,
        error: "Code expired. Please request a new one.",
        attemptsLeft: 0,
      });
    }

    const data = JSON.parse(stored);
    if (data.attempts >= MAX_ATTEMPTS) {
      await redis.del(redisKey);
      console.log(`[sms-verify] Verify failed for ${idMask}: too many attempts`);
      return NextResponse.json({
        verified: false,
        error: "Too many attempts. Please request a new code.",
        attemptsLeft: 0,
      });
    }

    if (data.code === code.trim()) {
      await redis.del(redisKey);
      console.log(`[sms-verify] Code verified for ${idMask}`);

      // Mark the identifier as verified (5 min TTL) so downstream APIs can
      // gate PII on it (/api/bmi-office reads both flags).
      if (phone) {
        await redis.set(`verified:${normalizePhone(phone)}`, "1", "EX", 300).catch(() => {});
      } else if (email) {
        await redis
          .set(`verified:email:${email.trim().toLowerCase()}`, "1", "EX", 300)
          .catch(() => {});
      }

      // Phone verified — now safe to return customer PII if requested
      let customer = undefined;
      if (squareCustomerId && SQUARE_TOKEN) {
        try {
          const custRes = await fetch(`${SQUARE_BASE}/customers/${squareCustomerId}`, {
            headers: {
              Authorization: `Bearer ${SQUARE_TOKEN}`,
              "Square-Version": "2024-12-18",
              "Content-Type": "application/json",
            },
          });
          if (custRes.ok) {
            const custData = await custRes.json();
            const c = custData.customer;
            if (c) {
              customer = {
                id: c.id,
                firstName: c.given_name || "",
                lastName: c.family_name || "",
                email: c.email_address || "",
                phone: c.phone_number || "",
                profileComplete: !!(c.given_name && c.family_name),
              };
              console.log(
                `[sms-verify] Customer fetched: id=${c.id}` +
                  ` name="${c.given_name ?? ""} ${c.family_name ?? ""}"` +
                  ` email=${c.email_address ? "yes" : "no"}`,
              );
            }
          } else {
            console.warn(
              `[sms-verify] Customer fetch failed: ${custRes.status} customerId=${squareCustomerId}`,
            );
          }
        } catch (fetchErr) {
          console.warn("[sms-verify] Customer fetch error (non-fatal):", fetchErr);
        }
      } else if (!squareCustomerId) {
        console.log("[sms-verify] No squareCustomerId provided — skipping customer fetch");
      }

      return NextResponse.json({ verified: true, customer });
    }

    // Wrong code — increment attempts
    data.attempts += 1;
    const ttl = await redis.ttl(redisKey);
    await redis.set(
      redisKey,
      JSON.stringify(data),
      "EX",
      ttl > 0 ? ttl : phone ? CODE_TTL : EMAIL_CODE_TTL,
    );

    console.log(
      `[sms-verify] Verify failed for ${idMask}: wrong code (${MAX_ATTEMPTS - data.attempts} attempts left)`,
    );
    return NextResponse.json({
      verified: false,
      error: "Incorrect code",
      attemptsLeft: MAX_ATTEMPTS - data.attempts,
    });
  } catch (err) {
    console.error("[sms-verify] PUT error:", err);
    return NextResponse.json({ error: "Verification failed" }, { status: 500 });
  }
}
