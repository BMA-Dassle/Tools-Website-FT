import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";

function headers() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Square-Version": "2024-12-18",
    "Content-Type": "application/json",
  };
}

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^1/, "");
  return `+1${digits}`;
}

/**
 * POST /api/square/loyalty/enroll
 * Body: { phone: "2397762044" }
 * Creates a Square Customer → then a Loyalty Account
 * Returns: { account, customer }
 */
export async function POST(req: NextRequest) {
  try {
    const { phone } = await req.json();
    if (!phone) return NextResponse.json({ error: "Phone required" }, { status: 400 });

    const e164 = toE164(phone);

    // Step 1: Create customer (phone only)
    const custRes = await fetch(`${SQUARE_BASE}/customers`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        idempotency_key: randomUUID(),
        phone_number: e164,
      }),
    });

    if (!custRes.ok) {
      const err = await custRes.text();
      console.error("[loyalty/enroll] Create customer error:", custRes.status, err);
      return NextResponse.json({ error: "Failed to create customer" }, { status: 500 });
    }

    const custData = await custRes.json();
    const customer = custData.customer;

    // Step 2: Get loyalty program ID
    const progRes = await fetch(`${SQUARE_BASE}/loyalty/programs/main`, {
      method: "GET",
      headers: headers(),
    });

    if (!progRes.ok) {
      const err = await progRes.text();
      console.error("[loyalty/enroll] Get program error:", progRes.status, err);
      return NextResponse.json({ error: "Failed to get loyalty program" }, { status: 500 });
    }

    const progData = await progRes.json();
    const programId = progData.program?.id;

    if (!programId) {
      return NextResponse.json({ error: "No loyalty program found" }, { status: 404 });
    }

    // Step 3: Create loyalty account
    const loyaltyRes = await fetch(`${SQUARE_BASE}/loyalty/accounts`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        idempotency_key: randomUUID(),
        loyalty_account: {
          program_id: programId,
          mapping: { phone_number: e164 },
        },
      }),
    });

    if (!loyaltyRes.ok) {
      const err = await loyaltyRes.text();
      console.error("[loyalty/enroll] Create loyalty error:", loyaltyRes.status, err);
      return NextResponse.json({ error: "Failed to create loyalty account" }, { status: 500 });
    }

    const loyaltyData = await loyaltyRes.json();
    const account = loyaltyData.loyalty_account;

    return NextResponse.json({
      account: {
        id: account.id,
        balance: account.balance || 0,
        lifetimePoints: account.lifetime_points || 0,
        customerId: account.customer_id,
        enrolledAt: account.enrolled_at || account.created_at,
      },
      customer: {
        id: customer.id,
        firstName: customer.given_name || "",
        lastName: customer.family_name || "",
        email: customer.email_address || "",
        phone: customer.phone_number || "",
        profileComplete: false,
      },
    });
  } catch (err) {
    console.error("[loyalty/enroll] Error:", err);
    return NextResponse.json({ error: "Enrollment failed" }, { status: 500 });
  }
}
