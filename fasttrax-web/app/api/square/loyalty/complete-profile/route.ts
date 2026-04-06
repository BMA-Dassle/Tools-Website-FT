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

/**
 * POST /api/square/loyalty/complete-profile
 * Body: { customerId, loyaltyAccountId, firstName, lastName, email? }
 * Updates customer + awards 500 bonus Pinz
 * Returns: { account, customer }
 */
export async function POST(req: NextRequest) {
  try {
    const { customerId, loyaltyAccountId, firstName, lastName, email } = await req.json();

    if (!customerId || !loyaltyAccountId || !firstName || !lastName) {
      return NextResponse.json({ error: "customerId, loyaltyAccountId, firstName, and lastName required" }, { status: 400 });
    }

    // Step 1: Update customer with name + email
    const updateBody: Record<string, string> = {
      given_name: firstName.trim(),
      family_name: lastName.trim(),
    };
    if (email) updateBody.email_address = email.trim().toLowerCase();

    const custRes = await fetch(`${SQUARE_BASE}/customers/${customerId}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(updateBody),
    });

    if (!custRes.ok) {
      const err = await custRes.text();
      console.error("[loyalty/complete-profile] Update customer error:", custRes.status, err);
      return NextResponse.json({ error: "Failed to update customer" }, { status: 500 });
    }

    const custData = await custRes.json();
    const customer = custData.customer;

    // Step 2: Get program ID for accumulate call
    const progRes = await fetch(`${SQUARE_BASE}/loyalty/programs/main`, {
      method: "GET",
      headers: headers(),
    });
    const progData = await progRes.json();
    const programId = progData.program?.id;

    // Step 3: Award 500 bonus Pinz
    const adjustRes = await fetch(`${SQUARE_BASE}/loyalty/accounts/${loyaltyAccountId}/adjust`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        idempotency_key: randomUUID(),
        adjust_points: {
          points: 500,
          reason: "Profile completion bonus — 500 Pinz",
          loyalty_program_id: programId,
        },
      }),
    });

    if (!adjustRes.ok) {
      const err = await adjustRes.text();
      console.error("[loyalty/complete-profile] Adjust points error:", adjustRes.status, err);
      // Customer was still updated, return partial success
    }

    // Step 4: Fetch updated loyalty account for new balance
    const acctRes = await fetch(`${SQUARE_BASE}/loyalty/accounts/${loyaltyAccountId}`, {
      method: "GET",
      headers: headers(),
    });
    const acctData = await acctRes.json();
    const account = acctData.loyalty_account;

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
        profileComplete: true,
      },
      bonusAwarded: 500,
    });
  } catch (err) {
    console.error("[loyalty/complete-profile] Error:", err);
    return NextResponse.json({ error: "Profile update failed" }, { status: 500 });
  }
}
