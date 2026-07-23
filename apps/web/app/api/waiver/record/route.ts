import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logWaiverAcceptance } from "@/lib/waiver-acceptance";

export const dynamic = "force-dynamic";

/**
 * POST /api/waiver/record — the E-SIGN attribution row for a waiver signed
 * through the unified /waiver flow (and, in time, the kiosk). The signature
 * image itself is recorded on the Pandora person by WaiverSigning; THIS is our
 * own Neon record of the acceptance (who / when / from where / which terms /
 * who signed for a minor) — the persist-to-our-DB half of the house rule that
 * the interactive sign path historically lacked.
 *
 * Best-effort: logWaiverAcceptance swallows its own errors and we always return
 * ok:true — a failed audit write must never surface to the guest.
 */

const bodySchema = z.object({
  /** The waiver's SUBJECT — the person it covers (a minor for a guardian sign). */
  personId: z.string().regex(/^\d+$/),
  firstName: z.string().trim().max(120).optional(),
  center: z.string().trim().max(40).optional(),
  /** BMI waiverID returned by Pandora on success. */
  waiverId: z.string().trim().max(120).optional(),
  /** Terms identifier — the Pandora template contentID for this waiver. */
  termsVersion: z.string().trim().max(120).optional(),
  /** Guardian's SHORT Pandora id when they signed a minor's waiver. */
  signedByPersonId: z.string().regex(/^\d+$/).optional(),
});

export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    undefined;
  const userAgent = req.headers.get("user-agent") || undefined;

  await logWaiverAcceptance({
    ts: new Date().toISOString(),
    ipAddress,
    userAgent,
    termsVersion: parsed.termsVersion ?? "pandora-signature",
    firstName: parsed.firstName,
    personId: parsed.personId,
    waiverId: parsed.waiverId,
    method: "signature",
    center: parsed.center,
    signedByPersonId: parsed.signedByPersonId,
  });

  return NextResponse.json({ ok: true });
}
