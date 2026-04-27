import { NextRequest, NextResponse } from "next/server";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";

/**
 * Update the redirect URL on a Square payment link and pre-populate buyer info.
 *
 * POST body: { squareUrl, billId, confirmationBaseUrl, buyer?: { email, phone, firstName, lastName } }
 *
 * Finds the payment link by URL, extracts BMI's payment data params
 * from the existing redirect, builds a new redirect pointing to our
 * confirmation page with those same params, and updates the link.
 * Optionally pre-populates buyer info so they don't re-enter it on Square.
 */
export async function POST(req: NextRequest) {
  try {
    const { squareUrl, billId, confirmationBaseUrl, buyer, buyerOnly } = await req.json();

    if (!SQUARE_TOKEN) {
      console.error("[update-redirect] SQUARE_ACCESS_TOKEN env var not set!");
      return NextResponse.json({ error: "Square not configured" }, { status: 500 });
    }

    if (!squareUrl) {
      return NextResponse.json({ error: "squareUrl required" }, { status: 400 });
    }

    console.log("[update-redirect] Looking for link:", squareUrl);

    // Find the payment link by listing recent links and matching the URL
    const listRes = await fetch(`${SQUARE_BASE}/online-checkout/payment-links`, {
      headers: {
        "Authorization": `Bearer ${SQUARE_TOKEN}`,
        "Square-Version": "2024-12-18",
      },
    });
    const listData = await listRes.json();
    const link = listData.payment_links?.find(
      (l: { url?: string }) => l.url === squareUrl,
    );

    if (!link) {
      return NextResponse.json({ error: "Payment link not found" }, { status: 404 });
    }

    // Build update payload
    const paymentLinkUpdate: Record<string, unknown> = {
      version: link.version,
    };

    // Only rewrite redirect URL if not buyerOnly mode (bowling keeps QAMF's redirect)
    if (!buyerOnly) {
      const existingRedirect: string = link.checkout_options?.redirect_url || "";
      const existingUrl = new URL(existingRedirect);
      const providerKind = existingUrl.searchParams.get("providerKind");
      const data = existingUrl.searchParams.get("data");

      const base = confirmationBaseUrl || `${existingUrl.protocol}//${existingUrl.host}/book/race/confirmation`;
      const params = new URLSearchParams({ billId });
      if (providerKind) params.set("providerKind", providerKind);
      if (data) params.set("data", data);
      params.set("orderId", billId);
      const newRedirect = `${base}?${params.toString()}`;

      paymentLinkUpdate.checkout_options = {
        redirect_url: newRedirect,
      };
    }

    if (buyer) {
      paymentLinkUpdate.pre_populated_data = {
        buyer_email: buyer.email || undefined,
        buyer_phone_number: buyer.phone ? `+1${buyer.phone.replace(/\D/g, "").replace(/^1/, "")}` : undefined,
        buyer_address: {
          first_name: buyer.firstName || undefined,
          last_name: buyer.lastName || undefined,
        },
      };
    }

    // Update the redirect URL and buyer info
    const updateRes = await fetch(`${SQUARE_BASE}/online-checkout/payment-links/${link.id}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${SQUARE_TOKEN}`,
        "Content-Type": "application/json",
        "Square-Version": "2024-12-18",
      },
      body: JSON.stringify({ payment_link: paymentLinkUpdate }),
    });

    const updateData = await updateRes.json();

    if (!updateRes.ok || updateData.errors) {
      console.error("[Square Update Error]", JSON.stringify(updateData.errors || updateData));
      return NextResponse.json(
        { error: updateData.errors?.[0]?.detail || "Failed to update redirect" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      url: updateData.payment_link.url,
      redirectUrl: updateData.payment_link.checkout_options?.redirect_url,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Square API error" },
      { status: 500 },
    );
  }
}
