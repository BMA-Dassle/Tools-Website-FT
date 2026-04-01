import { NextRequest, NextResponse } from "next/server";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";

/**
 * Update the redirect URL on a Square payment link.
 *
 * POST body: { squareUrl, redirectUrl }
 *
 * Finds the payment link by URL, updates redirect_url, returns the link.
 */
export async function POST(req: NextRequest) {
  try {
    const { squareUrl, redirectUrl } = await req.json();

    if (!squareUrl || !redirectUrl) {
      return NextResponse.json({ error: "squareUrl and redirectUrl required" }, { status: 400 });
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
            redirect_url: redirectUrl,
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
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Square API error" },
      { status: 500 },
    );
  }
}
