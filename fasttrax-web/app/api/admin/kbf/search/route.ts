import { NextRequest, NextResponse } from "next/server";
import {
  findPassesByEmail,
  findPassesByPhone,
  loadPassesWithMembers,
} from "@/lib/kbf-prefs";
import { getKbfRedeemedMembers } from "@/lib/bowling-db";

/**
 * POST /api/admin/kbf/search
 *
 * Search KBF accounts by phone or email, return passes with members
 * and today's redemptions.
 *
 * Body: { query: string }
 * If query is all digits (after stripping non-digits), search by phone.
 * Otherwise search by email.
 */
export async function POST(req: NextRequest) {
  const { query } = await req.json();
  if (!query || typeof query !== "string") {
    return NextResponse.json({ error: "query required" }, { status: 400 });
  }

  const stripped = query.replace(/\D/g, "");
  const isPhone = stripped.length >= 7 && /^\d+$/.test(stripped);

  const passes = isPhone
    ? await findPassesByPhone(stripped)
    : await findPassesByEmail(query.trim());

  if (passes.length === 0) {
    return NextResponse.json({ passes: [], redeemedToday: [] });
  }

  const passIds = passes.map((p) => p.id);
  const full = await loadPassesWithMembers(passIds);

  // Check today's redemptions — date in ET
  const todayET = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const allPairs = full.flatMap((p) =>
    p.members.map((m) => ({ passId: p.id, slot: m.slot })),
  );
  const redeemed =
    allPairs.length > 0
      ? await getKbfRedeemedMembers(todayET, allPairs)
      : [];

  return NextResponse.json({ passes: full, redeemedToday: redeemed });
}
