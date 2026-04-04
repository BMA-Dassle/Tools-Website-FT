import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { randomInt } from "crypto";

// ── Twilio config (from environment variables) ──────────────────────────────
const TWILIO_SID = process.env.TWILIO_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER || "";

// ── SendGrid config (for email OTP) ─────────────────────────────────────────
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";

const CODE_TTL = 300; // 5 minutes
const MAX_ATTEMPTS = 3;

/** Normalize phone to digits only */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, ""); // strip +1 or leading 1
}

/** Send SMS via Twilio REST API (no SDK needed) */
async function sendSms(to: string, body: string): Promise<boolean> {
  const toFormatted = to.length === 10 ? `+1${to}` : `+${to}`;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: toFormatted, From: TWILIO_FROM, Body: body }).toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[sms-verify] Twilio error:", res.status, err);
    return false;
  }
  return true;
}

/** Send OTP email via SendGrid */
async function sendEmailOtp(to: string, code: string): Promise<boolean> {
  if (!SENDGRID_API_KEY) { console.error("[sms-verify] No SENDGRID_API_KEY"); return false; }
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { "Authorization": `Bearer ${SENDGRID_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: "FastTrax Entertainment" },
      subject: "Your FastTrax Verification Code",
      content: [
        { type: "text/plain", value: `Your FastTrax verification code is: ${code}\n\nThis code expires in 5 minutes.` },
        { type: "text/html", value: `<div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:20px"><h2 style="color:#000418">FastTrax Verification</h2><p>Your verification code is:</p><div style="background:#f0f0f0;border-radius:8px;padding:20px;text-align:center;font-size:32px;letter-spacing:8px;font-weight:bold;color:#000418">${code}</div><p style="color:#666;font-size:12px;margin-top:16px">This code expires in 5 minutes.</p></div>` },
      ],
    }),
  });
  if (!res.ok) { console.error("[sms-verify] SendGrid error:", res.status, await res.text()); return false; }
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
    const { phone, email } = body;

    if (!phone && !email) return NextResponse.json({ error: "Phone or email required" }, { status: 400 });

    // Generate unique 6-digit code
    const code = String(randomInt(100000, 999999));

    if (phone) {
      // SMS flow
      const normalized = normalizePhone(phone);
      if (normalized.length !== 10) {
        return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
      }
      await redis.set(`smsverify:${normalized}`, JSON.stringify({ code, attempts: 0, createdAt: new Date().toISOString() }), "EX", CODE_TTL);
      const sent = await sendSms(normalized, `Your FastTrax verification code is: ${code}`);
      if (!sent) return NextResponse.json({ error: "Failed to send SMS" }, { status: 500 });
      console.log(`[sms-verify] SMS code sent to ${normalized.slice(0, 3)}***${normalized.slice(-4)}`);
    } else {
      // Email flow
      const normalized = email.trim().toLowerCase();
      await redis.set(`smsverify:email:${normalized}`, JSON.stringify({ code, attempts: 0, createdAt: new Date().toISOString() }), "EX", CODE_TTL);
      const sent = await sendEmailOtp(normalized, code);
      if (!sent) return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
      console.log(`[sms-verify] Email code sent to ${normalized.slice(0, 3)}***`);
    }

    return NextResponse.json({ sent: true });
  } catch (err) {
    console.error("[sms-verify] POST error:", err);
    return NextResponse.json({ error: "Failed to send code" }, { status: 500 });
  }
}

/**
 * PUT — Verify code
 * Body: { phone: "2397762044", code: "123456" } OR { email: "x@y.com", code: "123456" }
 * Returns: { verified: true } or { verified: false, attemptsLeft: N }
 */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { phone, email, code } = body;
    if ((!phone && !email) || !code) return NextResponse.json({ error: "Phone/email and code required" }, { status: 400 });

    const redisKey = phone
      ? `smsverify:${normalizePhone(phone)}`
      : `smsverify:email:${email.trim().toLowerCase()}`;
    const stored = await redis.get(redisKey);
    if (!stored) {
      return NextResponse.json({ verified: false, error: "Code expired. Please request a new one.", attemptsLeft: 0 });
    }

    const data = JSON.parse(stored);
    if (data.attempts >= MAX_ATTEMPTS) {
      await redis.del(redisKey);
      return NextResponse.json({ verified: false, error: "Too many attempts. Please request a new code.", attemptsLeft: 0 });
    }

    if (data.code === code.trim()) {
      await redis.del(redisKey);
      return NextResponse.json({ verified: true });
    }

    // Wrong code — increment attempts
    data.attempts += 1;
    const ttl = await redis.ttl(redisKey);
    await redis.set(redisKey, JSON.stringify(data), "EX", ttl > 0 ? ttl : CODE_TTL);

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
