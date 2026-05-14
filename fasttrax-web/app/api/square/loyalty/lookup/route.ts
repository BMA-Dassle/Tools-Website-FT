import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";

function sqHeaders() {
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

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, "");
}

/**
 * POST /api/square/loyalty/lookup
 * Body: { phone: "2397762044" }
 *
 * Returns: { exists: true, account } or { exists: false }
 *
 * PRIVACY: Customer PII (name, email) is only included when the phone
 * has been verified via /api/sms-verify (checked via Redis `verified:{phone}` key).
 * Without verification, only non-PII loyalty stats are returned.
 */
export async function POST(req: NextRequest) {
  try {
    const { phone } = await req.json();
    if (!phone) return NextResponse.json({ error: "Phone required" }, { status: 400 });

    const e164 = toE164(phone);
    const normalized = normalizePhone(phone);

    // Search loyalty accounts by phone
    const loyaltyRes = await fetch(`${SQUARE_BASE}/loyalty/accounts/search`, {
      method: "POST",
      headers: sqHeaders(),
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

    const result: Record<string, unknown> = {
      exists: true,
      account: {
        id: account.id,
        balance: account.balance || 0,
        lifetimePoints: account.lifetime_points || 0,
        customerId: account.customer_id,
        enrolledAt: account.enrolled_at || account.created_at,
      },
    };

    // Only include customer PII if phone was verified (Redis key set by sms-verify)
    const isVerified = await redis.get(`verified:${normalized}`).catch(() => null);
    if (isVerified && account.customer_id) {
      try {
        const custRes = await fetch(`${SQUARE_BASE}/customers/${account.customer_id}`, {
          headers: sqHeaders(),
        });
        if (custRes.ok) {
          const custData = await custRes.json();
          const c = custData.customer;
          if (c) {
            result.customer = {
              id: c.id,
              firstName: c.given_name || "",
              lastName: c.family_name || "",
              email: c.email_address || "",
              phone: c.phone_number || "",
              profileComplete: !!(c.given_name && c.family_name),
            };
          }
        }
      } catch {
        // Non-fatal — account data still returned
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[loyalty/lookup] Error:", err);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
}
