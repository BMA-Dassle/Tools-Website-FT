import { NextRequest, NextResponse } from "next/server";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    "Authorization": `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^1/, "");
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

/**
 * POST — Find or create a Square customer by phone number.
 * Returns customerId + saved cards.
 *
 * Body: { phone, firstName, lastName, email? }
 */
export async function POST(req: NextRequest) {
  try {
    const { phone, firstName, lastName, email } = await req.json();
    if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 });

    const formattedPhone = normalizePhone(phone);

    // Search for existing customer by phone
    const searchRes = await fetch(`${SQUARE_BASE}/customers/search`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        query: {
          filter: {
            phone_number: { exact: formattedPhone },
          },
        },
      }),
    });
    const searchData = await searchRes.json();

    let customerId: string | null = null;
    let customer = null;

    if (searchData.customers && searchData.customers.length > 0) {
      // Found existing customer
      customer = searchData.customers[0];
      customerId = customer.id;

      // Update name/email if missing
      const needsUpdate =
        (!customer.given_name && firstName) ||
        (!customer.family_name && lastName) ||
        (!customer.email_address && email);

      if (needsUpdate) {
        await fetch(`${SQUARE_BASE}/customers/${customerId}`, {
          method: "PUT",
          headers: sqHeaders(),
          body: JSON.stringify({
            given_name: customer.given_name || firstName || undefined,
            family_name: customer.family_name || lastName || undefined,
            email_address: customer.email_address || email || undefined,
          }),
        }).catch(() => {});
      }
    } else {
      // Create new customer
      const createRes = await fetch(`${SQUARE_BASE}/customers`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          idempotency_key: `cust-${formattedPhone}-${Date.now()}`,
          given_name: firstName || undefined,
          family_name: lastName || undefined,
          email_address: email || undefined,
          phone_number: formattedPhone,
        }),
      });
      const createData = await createRes.json();
      if (createData.customer) {
        customer = createData.customer;
        customerId = customer.id;
      } else {
        console.error("[square/customer] create failed:", createData);
        return NextResponse.json({ error: "Failed to create customer" }, { status: 500 });
      }
    }

    // Fetch saved cards for this customer
    const cards = await fetchSavedCards(customerId!);

    return NextResponse.json({
      customerId,
      name: `${customer?.given_name || ""} ${customer?.family_name || ""}`.trim(),
      cards,
    });
  } catch (err) {
    console.error("[square/customer] error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Customer API error" }, { status: 500 });
  }
}

/**
 * GET — List saved cards for a Square customer.
 * Query: ?customerId=SQ_CUST_ID
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const customerId = searchParams.get("customerId");
  if (!customerId) return NextResponse.json({ error: "customerId required" }, { status: 400 });

  try {
    const cards = await fetchSavedCards(customerId);
    return NextResponse.json({ cards });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Cards API error" }, { status: 500 });
  }
}

async function fetchSavedCards(customerId: string) {
  const res = await fetch(`${SQUARE_BASE}/cards?customer_id=${customerId}`, {
    headers: sqHeaders(),
  });
  const data = await res.json();

  if (!data.cards || data.cards.length === 0) return [];

  return data.cards
    .filter((c: { enabled: boolean }) => c.enabled)
    .map((c: { id: string; card_brand: string; last_4: string; exp_month: number; exp_year: number }) => {
      const now = new Date();
      const expDate = new Date(c.exp_year, c.exp_month); // Month after expiry
      return {
        id: c.id,
        brand: c.card_brand,
        last4: c.last_4,
        expMonth: c.exp_month,
        expYear: c.exp_year,
        expired: expDate < now,
      };
    });
}
