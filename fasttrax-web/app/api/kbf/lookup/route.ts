import { NextRequest, NextResponse } from "next/server";
import { randomInt } from "crypto";
import redis from "@/lib/redis";
import {
  findPassesByEmail,
  findPassesByPhone,
  loadPassesWithMembers,
  type KbfPassWithMembers,
} from "@/lib/kbf-prefs";

/**
 * POST /api/kbf/lookup
 *
 * Body:
 *   { contact: "user@example.com" }   // email lookup → email OTP
 *   { contact: "2391234567" }         // phone lookup → SMS OTP
 *
 * Looks up the parent's KBF account(s) in Neon, sends a 6-digit
 * verification code via the parent's preferred channel, and stashes
 * the matched pass IDs in Redis for the verify step.
 *
 * Test-account bypass: if the matched row has `is_test = true`,
 * skips OTP entirely and returns the loaded family payload directly.
 *
 * Mirrors the race-pack 2FA pattern in `app/api/sms-verify/route.ts`
 * but keys Redis under `kbfverify:*` so the two flows can't collide.
 */

// ── External services ──────────────────────────────────────────────────────

const VOX_API_KEY = process.env.VOX_API_KEY || "";
const VOX_FROM = process.env.VOX_FROM_NUMBER || "+12393022155";
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";

const CODE_TTL_SEC = 300; // 5 minutes
// (MAX_ATTEMPTS lives in the verify route since enforcement happens
// on the PUT path, not here.)

// ── Helpers ─────────────────────────────────────────────────────────────────

function isEmail(s: string): boolean {
  return s.includes("@");
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, "");
}

async function sendSmsOtp(to: string, code: string): Promise<boolean> {
  if (!VOX_API_KEY) {
    console.error("[kbf/lookup] Missing VOX_API_KEY");
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
      from: VOX_FROM,
      body: `Your HeadPinz Kids Bowl Free code is: ${code}`,
    }),
  });
  if (!res.ok) {
    console.error("[kbf/lookup] Vox error:", res.status, await res.text());
    return false;
  }
  return true;
}

async function sendEmailOtp(to: string, code: string): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    console.error("[kbf/lookup] Missing SENDGRID_API_KEY");
    return false;
  }
  // Mirror the race-pack OTP template verbatim — clean white card on
  // a light bg, dark heading, soft-grey code chip. Race-pack emails
  // deliver reliably through Gmail/Outlook spam filters; the dark
  // KBF-themed template I had earlier was getting flagged as junk.
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: "HeadPinz Kids Bowl Free" },
      subject: "Your Kids Bowl Free verification code",
      content: [
        {
          type: "text/plain",
          value: `Your Kids Bowl Free verification code is: ${code}\n\nThis code expires in 5 minutes.`,
        },
        {
          type: "text/html",
          value: `<div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:20px"><h2 style="color:#000418">Kids Bowl Free Verification</h2><p>Your verification code is:</p><div style="background:#f0f0f0;border-radius:8px;padding:20px;text-align:center;font-size:32px;letter-spacing:8px;font-weight:bold;color:#000418">${code}</div><p style="color:#666;font-size:12px;margin-top:16px">This code expires in 5 minutes.</p></div>`,
        },
      ],
    }),
  });
  if (!res.ok) {
    console.error("[kbf/lookup] SendGrid error:", res.status, await res.text());
    return false;
  }
  return true;
}

// ── Route ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const contactRaw = (body?.contact ?? "").toString().trim();
    if (!contactRaw) {
      return NextResponse.json({ error: "Email or phone required" }, { status: 400 });
    }

    const useEmail = isEmail(contactRaw);
    const normalizedEmail = useEmail ? contactRaw.toLowerCase() : "";
    const normalizedPhone = useEmail ? "" : normalizePhone(contactRaw);

    if (!useEmail && normalizedPhone.length !== 10) {
      return NextResponse.json(
        { error: "Phone must be a 10-digit US number" },
        { status: 400 },
      );
    }

    // Look up the parent's pass(es)
    const passes = useEmail
      ? await findPassesByEmail(normalizedEmail)
      : await findPassesByPhone(normalizedPhone);

    if (passes.length === 0) {
      // Don't disclose whether the contact is registered or not;
      // give a friendly hint that points at sign-up. The verify
      // route will hard-fail if no Redis key exists, so we don't
      // need to fake an OTP send here.
      return NextResponse.json(
        {
          ok: false,
          error: "We don't see a Kids Bowl Free account for that. Sign up at kidsbowlfree.com — new accounts take ~24h to show up here.",
        },
        { status: 404 },
      );
    }

    // Test-account bypass — load the family and return immediately.
    if (passes.some((p) => p.isTest)) {
      const passIds = passes.map((p) => p.id);
      const loaded = await loadPassesWithMembers(passIds);
      const out: { ok: true; bypass: true; passes: KbfPassWithMembers[] } = {
        ok: true,
        bypass: true,
        passes: loaded,
      };
      return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
    }

    // Pick the OTP channel from what the parent typed. The contact
    // input IS the explicit channel choice — typing an email means
    // they want the code via email, typing a phone means SMS. The
    // saved `preferred_2fa` field used to override this when set to
    // "sms" but that surprised users who explicitly switched to the
    // email tab and then got a text anyway. preferred_2fa now only
    // exists as a UX hint for which tab to default to on the next
    // visit, not a server-side override.
    const channel: "sms" | "email" = useEmail ? "email" : "sms";

    const code = String(randomInt(100000, 999999));
    const passIds = passes.map((p) => p.id);

    // Stash pending verification under both possible lookup keys so
    // the verify route can find it whether the parent re-types the
    // same contact or switches forms.
    const redisKey = useEmail
      ? `kbfverify:email:${normalizedEmail}`
      : `kbfverify:phone:${normalizedPhone}`;
    await redis.set(
      redisKey,
      JSON.stringify({
        code,
        attempts: 0,
        passIds,
        channel,
        createdAt: new Date().toISOString(),
      }),
      "EX",
      CODE_TTL_SEC,
    );

    // Send the OTP. Failures: clear the Redis key and surface a
    // 502 so the UI can show "couldn't send code, try again."
    let sent = false;
    if (channel === "email") {
      sent = await sendEmailOtp(passes[0].email, code);
    } else {
      const phone = useEmail ? passes[0].phone! : normalizedPhone;
      sent = await sendSmsOtp(phone, code);
    }
    if (!sent) {
      await redis.del(redisKey);
      return NextResponse.json(
        { ok: false, error: "Couldn't send verification code. Try again." },
        { status: 502 },
      );
    }

    // Echo back the channel so the UI can render "We sent a code to
    // your email" vs "...your phone ending in 4567". Don't echo the
    // actual address — it's already on the parent's screen.
    const masked =
      channel === "email"
        ? maskEmail(passes[0].email)
        : maskPhone(useEmail ? (passes[0].phone ?? "") : normalizedPhone);

    console.log(
      `[kbf/lookup] OTP sent via ${channel} to ${masked} for pass(es) ${passIds.join(",")}`,
    );

    return NextResponse.json({
      ok: true,
      bypass: false,
      channel,
      contact: useEmail ? normalizedEmail : normalizedPhone,
      maskedDestination: masked,
    });
  } catch (err) {
    console.error("[kbf/lookup] error:", err);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}

function maskPhone(digits: string): string {
  if (digits.length < 4) return "***";
  return `***-***-${digits.slice(-4)}`;
}
