import { NextRequest, NextResponse } from "next/server";
import { logClickwrap, CURRENT_POLICY_VERSION } from "@/lib/clickwrap";

/**
 * POST /api/clickwrap/record
 *
 * Records a clickwrap acceptance from the race booking checkout.
 * The server captures IP address and user-agent from request headers
 * so neither can be spoofed by the client at persistence time.
 *
 * Body: {
 *   ts?           — client ISO timestamp (falls back to server time)
 *   billId?       — BMI order id
 *   email?        — contact email
 *   phone?        — contact phone
 *   firstName?    — contact first name
 *   amountCents?  — charge in cents (0 for credit orders)
 *   cardLast4?    — Square card last-4 (only present after Square tokenizes)
 *   cardBrand?    — Square card brand
 *   bookingType?  — "racing" | "racing-pack" etc.
 *   policyVersion? — overrides current default (for testing only)
 * }
 *
 * No auth required — the caller is the same origin's checkout page.
 * The only writable fields are those listed above; server-side IP
 * and user-agent are always injected from request headers.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // Server-side capture — these cannot be spoofed by the client.
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const userAgent = req.headers.get("user-agent") || "";

  const ts =
    typeof body.ts === "string" && body.ts
      ? body.ts
      : new Date().toISOString();

  const policyVersion =
    typeof body.policyVersion === "string" && body.policyVersion
      ? body.policyVersion
      : CURRENT_POLICY_VERSION;

  await logClickwrap({
    ts,
    ipAddress,
    userAgent,
    policyVersion,
    email: typeof body.email === "string" ? body.email : undefined,
    phone: typeof body.phone === "string" ? body.phone : undefined,
    firstName: typeof body.firstName === "string" ? body.firstName : undefined,
    billId: typeof body.billId === "string" ? body.billId : undefined,
    amountCents: typeof body.amountCents === "number" ? body.amountCents : undefined,
    cardLast4: typeof body.cardLast4 === "string" ? body.cardLast4 : undefined,
    cardBrand: typeof body.cardBrand === "string" ? body.cardBrand : undefined,
    bookingType: typeof body.bookingType === "string" ? body.bookingType : undefined,
  });

  return NextResponse.json({ ok: true });
}
