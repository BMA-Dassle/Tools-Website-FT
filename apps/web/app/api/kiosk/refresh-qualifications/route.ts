import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import redis from "@/lib/redis";
import { gatherQualifications } from "~/features/kiosk/service/qualification-refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kiosk mid-session qualification refresh: re-fetch live memberships (tier),
 * credit balances, waiver validity, and birthdate for the party members the
 * kiosk already holds. Fired at step boundaries (people-step exit, review→pay)
 * so a license bought at the desk / a waiver signed on a phone / a credit
 * granted mid-session is picked up without re-adding the member.
 *
 * Exposure note: input is person ids the kiosk session already holds; the
 * response carries qualification data only (no name/email/phone) — a smaller
 * surface than the existing open /api/pandora?personId= GET. Rate-limited per
 * IP against enumeration anyway.
 */

const RefreshSchema = z.object({
  /** Pandora location key ("headpinz" | "fasttrax" | "naples"). */
  location: z.string().trim().max(20).optional(),
  members: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        // Raw digit strings — 17-digit Office ids exceed MAX_SAFE_INTEGER.
        bmiPersonId: z.string().regex(/^\d{1,20}$/),
        // SHORT Pandora id when the session resolved one — the waiver read
        // uses it (signatures land on this id, not the Office id).
        pandoraPersonId: z
          .string()
          .regex(/^\d{1,20}$/)
          .optional(),
      }),
    )
    .min(1)
    .max(12),
});

/** Sliding 5-minute per-IP counter (same pattern as /api/bmi-office). Fails OPEN. */
async function rateLimited(req: NextRequest): Promise<boolean> {
  try {
    const fwd = req.headers.get("x-forwarded-for");
    const ip = (fwd ? fwd.split(",")[0] : null)?.trim() || "unknown";
    const key = `rl:qual-refresh:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 300);
    return count > 60;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    if (await rateLimited(req)) {
      return NextResponse.json(
        { error: "Too many refreshes — try again shortly" },
        { status: 429 },
      );
    }
    const body = await req.json().catch(() => null);
    const parsed = RefreshSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid refresh request" }, { status: 400 });
    }
    const members = await gatherQualifications(parsed.data.members, parsed.data.location);
    return NextResponse.json({ members });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Refresh failed" },
      { status: 500 },
    );
  }
}
