import { NextResponse } from "next/server";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";

function headers() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Square-Version": "2024-12-18",
    "Content-Type": "application/json",
  };
}

/**
 * GET /api/square/loyalty/program
 * Returns reward tiers, accrual rules, and terminology
 */
export async function GET() {
  try {
    const res = await fetch(`${SQUARE_BASE}/loyalty/programs/main`, {
      method: "GET",
      headers: headers(),
      next: { revalidate: 3600 }, // cache for 1 hour
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[loyalty/program] Error:", res.status, err);
      return NextResponse.json({ error: "Failed to get program" }, { status: 500 });
    }

    const data = await res.json();
    const program = data.program;

    if (!program) {
      return NextResponse.json({ error: "No loyalty program found" }, { status: 404 });
    }

    return NextResponse.json({
      id: program.id,
      terminology: program.terminology || { one: "Pinz", other: "Pinz" },
      rewardTiers: (program.reward_tiers || []).map(
        (t: { id: string; points: number; name: string; created_at: string }) => ({
          id: t.id,
          points: t.points,
          name: t.name,
          createdAt: t.created_at,
        })
      ),
      accrualRules: (program.accrual_rules || []).map(
        (r: { accrual_type: string; points: number; spend_data?: { amount_money?: { amount: number } } }) => ({
          type: r.accrual_type,
          points: r.points,
          spendAmountCents: r.spend_data?.amount_money?.amount,
        })
      ),
    });
  } catch (err) {
    console.error("[loyalty/program] Error:", err);
    return NextResponse.json({ error: "Failed to get program" }, { status: 500 });
  }
}
