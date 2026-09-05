import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import redis from "@/lib/redis";
import { resolveStaffCard } from "~/features/kiosk/staff-mode/staff-card.server";
import { mintStaffToken, STAFF_TOKEN_TTL_MS } from "~/features/kiosk/staff-mode/staff-token.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/kiosk/staff-card — a scanned Intercard card → is it a STAFF card?
 * Two upstream steps (staff-card.server.ts): Office person-by-card, then
 * Pandora staff-roles for that person at `location`.
 *
 * Body { account, kioskId?, location? } → always 200:
 *   { linked: true,  employee, token, ttlMs }   staff mode may arm (Manager group required)
 *   { linked: false, reason }                    "not-linked" | "unconfigured" | "error"
 *   { linked: false, reason: "not-manager", name } staff, but no Manager group
 *
 * The token is the staff credential for /api/kiosk/staff-actions — signed,
 * carries the employee, 15-minute TTL (staff-token.server.ts). No PIN involved:
 * the card IS the identity, and the point is knowing WHO acted.
 *
 * Unauthenticated by design (the scan is the first thing that happens), so it
 * is rate-limited per IP against someone feeding it account numbers, and it
 * never distinguishes "no such card" from "card, but not staff" — both are
 * `not-linked`.
 */

const BodySchema = z.object({
  /** Intercard account — a raw digit string (bigint upstream, never a number). */
  account: z.string().regex(/^\d{1,20}$/),
  kioskId: z.string().max(40).optional(),
  location: z.enum(["fasttrax", "headpinz", "naples"]).optional(),
});

/** Sliding 5-minute per-IP counter (same pattern as refresh-qualifications). Fails OPEN. */
async function rateLimited(req: NextRequest): Promise<boolean> {
  try {
    const fwd = req.headers.get("x-forwarded-for");
    const ip = (fwd ? fwd.split(",")[0] : null)?.trim() || "unknown";
    const key = `rl:staff-card:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 300);
    return count > 30;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if (await rateLimited(req)) {
    return NextResponse.json(
      { error: "Too many card checks — try again shortly" },
      { status: 429 },
    );
  }
  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid card request" }, { status: 400 });
  }
  const { account, kioskId, location = "fasttrax" } = parsed.data;

  const resolved = await resolveStaffCard(account, location);
  if (!resolved.linked) {
    return NextResponse.json(
      resolved.reason === "not-manager"
        ? { linked: false, reason: resolved.reason, name: resolved.name }
        : { linked: false, reason: resolved.reason },
    );
  }
  const token = mintStaffToken(resolved.employee);
  if (!token) {
    // No signing secret in this environment → staff mode cannot be trusted here.
    return NextResponse.json({ linked: false, reason: "unconfigured" });
  }
  console.log(
    `[staff-card] ${resolved.employee.name} (${resolved.employee.id}) armed staff mode` +
      `${kioskId ? ` on ${kioskId}` : ""} with card ····${resolved.employee.cardTail}`,
  );
  return NextResponse.json({
    linked: true,
    employee: resolved.employee,
    token,
    ttlMs: STAFF_TOKEN_TTL_MS,
  });
}
