import { NextRequest, NextResponse } from "next/server";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";

/**
 * Update the redirect URL on a Square payment link.
 *
 * POST body: { squareUrl, billId, confirmationBaseUrl }
 *
 * Finds the payment link by URL, extracts BMI's payment data params
 * from the existing redirect, builds a new redirect pointing to our
 * confirmation page with those same params, and updates the link.
 */
export async function POST(req: NextRequest) {
  try {
    const { squareUrl, billId, confirmationBaseUrl } = await req.json();

    if (!squareUrl || !billId) {
      return NextResponse.json({ error: "squareUrl and billId required" }, { status: 400 });
    }

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

    // Extract BMI's payment data params from the existing redirect URL
    const existingRedirect: string = link.checkout_options?.redirect_url || "";
    const existingUrl = new URL(existingRedirect);
    const providerKind = existingUrl.searchParams.get("providerKind");
    const data = existingUrl.searchParams.get("data");

    // Build our new redirect URL with billId + BMI's payment params
    const base = confirmationBaseUrl || `${existingUrl.protocol}//${existingUrl.host}/book/racing/confirmation`;
    const params = new URLSearchParams({ billId });
    if (providerKind) params.set("providerKind", providerKind);
    if (data) params.set("data", data);
    params.set("orderId", billId);
    // transactionId will be appended by Square after payment
    const newRedirect = `${base}?${params.toString()}`;

    // Update the redirect URL
    const updateRes = await fetch(`${SQUARE_BASE}/online-checkout/payment-links/${link.id}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${SQUARE_TOKEN}`,
        "Content-Type": "application/json",
        "Square-Version": "2024-12-18",
      },
      body: JSON.stringify({
        payment_link: {
          version: link.version,
          checkout_options: {
            redirect_url: newRedirect,
          },
        },
      }),
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
      paymentData: { providerKind, data },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Square API error" },
      { status: 500 },
    );
  }
}
