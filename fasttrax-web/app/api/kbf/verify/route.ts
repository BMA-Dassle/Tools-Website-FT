import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { loadPassesWithMembers, optInPhoneSmsTwoFactor } from "@/lib/kbf-prefs";

/**
 * POST /api/kbf/verify
 *
 * Body:
 *   {
 *     contact: "user@example.com" | "2391234567",
 *     code: "123456",
 *     // Optional: parent opted into SMS for next time. Save phone
 *     // and flip preferred_2fa = 'sms' on every matched pass.
 *     savePhone?: { phone: "2391234567" }
 *   }
 *
 * Verifies the 6-digit code stored by /api/kbf/lookup, returns the
 * full family payload (passes + members + saved prefs), and
 * optionally upgrades the parent to SMS 2FA for future visits.
 *
 * 5-minute TTL, 3-attempt cap (mirrors the race-pack pattern).
 */

const CODE_TTL_SEC = 300;
const MAX_ATTEMPTS = 3;

function isEmail(s: string): boolean {
  return s.includes("@");
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, "");
}

interface PendingVerification {
  code: string;
  attempts: number;
  passIds: number[];
  channel: "sms" | "email";
  createdAt: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const contactRaw = (body?.contact ?? "").toString().trim();
    const code = (body?.code ?? "").toString().trim();
    const savePhone = body?.savePhone?.phone
      ? normalizePhone(String(body.savePhone.phone))
      : "";

    if (!contactRaw || !code) {
      return NextResponse.json({ error: "Contact and code required" }, { status: 400 });
    }
    if (savePhone && savePhone.length !== 10) {
      return NextResponse.json({ error: "Phone must be 10 digits" }, { status: 400 });
    }

    const useEmail = isEmail(contactRaw);
    const redisKey = useEmail
      ? `kbfverify:email:${contactRaw.toLowerCase()}`
      : `kbfverify:phone:${normalizePhone(contactRaw)}`;

    const stored = await redis.get(redisKey);
    if (!stored) {
      return NextResponse.json(
        { verified: false, error: "Code expired. Please request a new one.", attemptsLeft: 0 },
        { status: 410 },
      );
    }

    const data = JSON.parse(stored) as PendingVerification;

    if (data.attempts >= MAX_ATTEMPTS) {
      await redis.del(redisKey);
      return NextResponse.json(
        {
          verified: false,
          error: "Too many attempts. Please request a new code.",
          attemptsLeft: 0,
        },
        { status: 429 },
      );
    }

    if (data.code !== code) {
      data.attempts += 1;
      const ttl = await redis.ttl(redisKey);
      await redis.set(
        redisKey,
        JSON.stringify(data),
        "EX",
        ttl > 0 ? ttl : CODE_TTL_SEC,
      );
      return NextResponse.json({
        verified: false,
        error: "Incorrect code",
        attemptsLeft: MAX_ATTEMPTS - data.attempts,
      });
    }

    // ✓ Verified — burn the code, load the family.
    await redis.del(redisKey);
    const passes = await loadPassesWithMembers(data.passIds);

    if (passes.length === 0) {
      // Edge case: pass got deleted between lookup and verify.
      return NextResponse.json(
        { verified: false, error: "Account no longer found." },
        { status: 410 },
      );
    }

    // Save-phone opt-in. We accept this on the verify call so the
    // user can toggle it in the same step they enter their code —
    // saves a round-trip and feels natural in the UI.
    if (savePhone) {
      try {
        await optInPhoneSmsTwoFactor(data.passIds, savePhone);
        for (const p of passes) {
          p.phone = savePhone;
          p.preferred2fa = "sms";
        }
      } catch (err) {
        console.error("[kbf/verify] phone-save failed (non-fatal):", err);
      }
    }

    return NextResponse.json(
      { verified: true, passes },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[kbf/verify] error:", err);
    return NextResponse.json({ error: "Verification failed" }, { status: 500 });
  }
}
