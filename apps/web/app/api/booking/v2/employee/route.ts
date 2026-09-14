import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/admin-auth";
import {
  recognizeEmployee,
  startEmployeeVerification,
  verifyEmployeeCode,
} from "~/features/discount-codes/programs/employee.server";
import type { MatchablePerson } from "~/features/discount-codes/programs/employee";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/booking/v2/employee — EMPLOYEE PERKS, the one entry point for web
 * AND kiosk (owner 2026-09-13: "cleanest way to verify that's universal").
 *
 *   { action: "start",     punchId? | phone?, kiosk?: { deviceKey, center, brand } }
 *     → { ok: true, challenge, maskedPhone } | { ok: false, reason }
 *   { action: "verify",    challenge, code, party: MatchablePerson[], kiosk? }
 *     → { ok: true, employee, linked } | { ok: false, reason, attemptsLeft? }
 *   { action: "recognize", member: MatchablePerson, kiosk? }
 *     → { ok: true, employee } | { ok: false, reason }
 *
 * ALWAYS 200 for a refusal — the body answers "who is this", the HTTP status
 * answers "did the lookup run" (the staff/verify precedent). Failure reasons
 * are deliberately coarse: unknown ID, unknown mobile and wrong code all read
 * as "unverified"/"incorrect" so nobody can probe the roster from a kiosk.
 *
 * `party` is the CLIENT's roster — names, phones and BMI person ids as the
 * booking has them. It only decides WHICH member the perks attach to; it never
 * grants anything (the code did). The reserve re-derives the stamp from the
 * token, so a fabricated party entry buys nothing at charge time.
 */

type KioskCtx = { deviceKey?: string; center?: string; brand?: string };

function partyFrom(v: unknown): MatchablePerson[] {
  if (!Array.isArray(v)) return [];
  const out: MatchablePerson[] = [];
  for (const p of v.slice(0, 40)) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.firstName !== "string") continue;
    out.push({
      id: o.id,
      firstName: o.firstName,
      lastName: typeof o.lastName === "string" ? o.lastName : null,
      phone: typeof o.phone === "string" ? o.phone : null,
      // BMI ids stay RAW strings — never Number() them.
      bmiPersonId: typeof o.bmiPersonId === "string" ? o.bmiPersonId : null,
    });
  }
  return out;
}

function brandOf(k: KioskCtx | undefined): "fasttrax" | "headpinz" | undefined {
  return k?.brand === "headpinz" || k?.brand === "fasttrax" ? k.brand : undefined;
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, reason: "unverified" }, { status: 400 });
  }
  const action = body.action;
  const kiosk = (body.kiosk && typeof body.kiosk === "object" ? body.kiosk : undefined) as
    | KioskCtx
    | undefined;
  const location = typeof kiosk?.center === "string" ? kiosk.center : undefined;

  if (action === "start") {
    // Rate-limit per kiosk device when identified — a venue's kiosks share one
    // NAT'd IP — else per IP (the promo route's rule).
    const ip = getClientIp(req) ?? "unknown";
    const limiterKey = kiosk?.deviceKey ? `kiosk:${kiosk.deviceKey}` : ip;
    const res = await startEmployeeVerification({
      punchId: typeof body.punchId === "string" ? body.punchId : null,
      phone: typeof body.phone === "string" ? body.phone : null,
      limiterKey,
      brand: brandOf(kiosk),
    });
    return NextResponse.json(res);
  }

  if (action === "verify") {
    const res = await verifyEmployeeCode({
      challenge: typeof body.challenge === "string" ? body.challenge : "",
      code: typeof body.code === "string" ? body.code : String(body.code ?? ""),
      party: partyFrom(body.party),
      location,
      source: kiosk ? "kiosk" : "web",
    });
    return NextResponse.json(res);
  }

  if (action === "recognize") {
    const [member] = partyFrom([body.member]);
    if (!member) return NextResponse.json({ ok: false, reason: "not-linked" });
    const res = await recognizeEmployee({ member, source: kiosk ? "kiosk" : "web" });
    return NextResponse.json(res);
  }

  return NextResponse.json({ ok: false, reason: "unverified" }, { status: 400 });
}
