import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { randomInt } from "crypto";

// ── Twilio config (from environment variables) ──────────────────────────────
const TWILIO_SID = process.env.TWILIO_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER || "";

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

/**
 * POST — Send verification code
 * Body: { phone: "2397762044" }
 * Returns: { sent: true } or { error: "..." }
 */
export async function POST(req: NextRequest) {
  try {
    const { phone } = await req.json();
    if (!phone) return NextResponse.json({ error: "Phone required" }, { status: 400 });

    const normalized = normalizePhone(phone);
    if (normalized.length !== 10) {
      return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
    }

    // Generate unique 6-digit code
    const code = String(randomInt(100000, 999999));

    // Store in Redis
    await redis.set(
      `smsverify:${normalized}`,
      JSON.stringify({ code, attempts: 0, createdAt: new Date().toISOString() }),
      "EX",
      CODE_TTL,
    );

    // Send via Twilio
    const sent = await sendSms(normalized, `Your FastTrax verification code is: ${code}`);
    if (!sent) {
      return NextResponse.json({ error: "Failed to send SMS" }, { status: 500 });
    }

    console.log(`[sms-verify] Code sent to ${normalized.slice(0, 3)}***${normalized.slice(-4)}`);
    return NextResponse.json({ sent: true });
  } catch (err) {
    console.error("[sms-verify] POST error:", err);
    return NextResponse.json({ error: "Failed to send code" }, { status: 500 });
  }
}

/**
 * PUT — Verify code
 * Body: { phone: "2397762044", code: "123456" }
 * Returns: { verified: true } or { verified: false, attemptsLeft: N }
 */
export async function PUT(req: NextRequest) {
  try {
    const { phone, code } = await req.json();
    if (!phone || !code) return NextResponse.json({ error: "Phone and code required" }, { status: 400 });

    const normalized = normalizePhone(phone);
    const stored = await redis.get(`smsverify:${normalized}`);
    if (!stored) {
      return NextResponse.json({ verified: false, error: "Code expired. Please request a new one.", attemptsLeft: 0 });
    }

    const data = JSON.parse(stored);
    if (data.attempts >= MAX_ATTEMPTS) {
      await redis.del(`smsverify:${normalized}`);
      return NextResponse.json({ verified: false, error: "Too many attempts. Please request a new code.", attemptsLeft: 0 });
    }

    if (data.code === code.trim()) {
      // Success — clean up
      await redis.del(`smsverify:${normalized}`);
      return NextResponse.json({ verified: true });
    }

    // Wrong code — increment attempts
    data.attempts += 1;
    const ttl = await redis.ttl(`smsverify:${normalized}`);
    await redis.set(`smsverify:${normalized}`, JSON.stringify(data), "EX", ttl > 0 ? ttl : CODE_TTL);

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
