import { NextRequest, NextResponse } from "next/server";

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
 * POST /api/square/loyalty/lookup
 * Body: { phone: "2397762044" }
 * Returns: { exists: true, account, customer } or { exists: false }
 */
export async function POST(req: NextRequest) {
  try {
    const { phone } = await req.json();
    if (!phone) return NextResponse.json({ error: "Phone required" }, { status: 400 });

    const e164 = toE164(phone);

    // Search loyalty accounts by phone
    const loyaltyRes = await fetch(`${SQUARE_BASE}/loyalty/accounts/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        query: { mappings: [{ phone_number: e164 }] },
        limit: 1,
      }),
    });

    if (!loyaltyRes.ok) {
      const err = await loyaltyRes.text();
      console.error("[loyalty/lookup] Search error:", loyaltyRes.status, err);
      return NextResponse.json({ error: "Failed to search loyalty accounts" }, { status: 500 });
    }

    const loyaltyData = await loyaltyRes.json();
    const accounts = loyaltyData.loyalty_accounts || [];

    if (accounts.length === 0) {
      return NextResponse.json({ exists: false });
    }

    const account = accounts[0];

    // Fetch customer details
    let customer = null;
    if (account.customer_id) {
      const custRes = await fetch(`${SQUARE_BASE}/customers/${account.customer_id}`, {
        method: "GET",
        headers: headers(),
      });
      if (custRes.ok) {
        const custData = await custRes.json();
        customer = custData.customer;
      }
    }

    return NextResponse.json({
      exists: true,
      account: {
        id: account.id,
        balance: account.balance || 0,
        lifetimePoints: account.lifetime_points || 0,
        customerId: account.customer_id,
        enrolledAt: account.enrolled_at || account.created_at,
      },
      customer: customer
        ? {
            id: customer.id,
            firstName: customer.given_name || "",
            lastName: customer.family_name || "",
            email: customer.email_address || "",
            phone: customer.phone_number || "",
            profileComplete: !!(customer.given_name && customer.family_name),
          }
        : null,
    });
  } catch (err) {
    console.error("[loyalty/lookup] Error:", err);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
}
