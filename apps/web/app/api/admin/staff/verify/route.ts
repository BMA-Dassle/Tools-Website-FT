import { NextRequest, NextResponse } from "next/server";
import { verifyPunchId } from "~/features/staff/service";

/**
 * POST /api/admin/staff/verify — resolve a typed punch ID to a first name.
 *
 * Body: { punchId: string }
 * 200:  { ok: true, firstName, userId, stale }
 * 200:  { ok: false, reason: "unknown" | "ambiguous" | "unavailable" }
 *
 * ALWAYS 200, EVEN FOR A REFUSAL. The caller is a keypad on a wall tablet whose
 * only job is to shake or proceed; a 401/403 here would be indistinguishable
 * from the admin gate rejecting the whole page, which is a different problem
 * with a different fix. The HTTP status answers "did the lookup run", the body
 * answers "who is this".
 *
 * `unavailable` IS NOT A REFUSAL and callers must not treat it as one — it
 * means 7shifts was unreachable on a cold cache, and a control that cannot be
 * operated is worse than one that merely asks twice (the posture the briefing
 * prompt already takes for a session with no heat number).
 *
 * Auth: middleware gates /api/admin/* — see lib/admin-request-auth.
 *
 * No `export const dynamic` — a POST handler is dynamic already, and stating it
 * again is config that looks load-bearing and is not.
 */
export async function POST(req: NextRequest) {
  let punchId = "";
  try {
    const body = (await req.json()) as { punchId?: unknown };
    if (typeof body.punchId === "string") punchId = body.punchId;
    // A keypad sends digits; a number here is a caller being helpful, not hostile.
    else if (typeof body.punchId === "number") punchId = String(body.punchId);
  } catch {
    return NextResponse.json({ ok: false, reason: "unknown" });
  }

  if (!punchId.trim()) return NextResponse.json({ ok: false, reason: "unknown" });

  const result = await verifyPunchId(punchId);
  if (!result.ok) return NextResponse.json({ ok: false, reason: result.reason });

  // FIRST NAME ONLY over the wire (owner). The surname is in the index and is
  // deliberately not sent — nothing downstream displays it, and a wall tablet
  // is the last place to widen what is on screen.
  return NextResponse.json({
    ok: true,
    userId: result.staff.userId,
    firstName: result.staff.firstName,
    stale: result.stale,
  });
}
