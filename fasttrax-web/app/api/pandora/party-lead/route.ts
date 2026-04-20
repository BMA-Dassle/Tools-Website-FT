import { NextRequest, NextResponse } from "next/server";
import { submitPartyLead, type PartyLeadInput } from "@/lib/pandora-party-lead";

/**
 * POST /api/pandora/party-lead
 *
 * Thin public proxy over `submitPartyLead` in `lib/pandora-party-lead.ts`.
 * Kept separate so non-fasttrax callers can POST directly (and so the
 * normalization logic has an HTTP-level seam for debugging).
 *
 * The `/api/sales-lead/submit` orchestrator no longer calls THIS route —
 * it imports `submitPartyLead` directly to avoid an internal HTTP hop
 * that required NEXT_PUBLIC_SITE_URL to be configured everywhere.
 *
 * Returns on success: `{ projectID, projectNumber, personID, assignedAgent }`
 * Returns on failure: `{ error }` with the matching HTTP status.
 */
export async function POST(req: NextRequest) {
  let body: PartyLeadInput;
  try {
    body = (await req.json()) as PartyLeadInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = await submitPartyLead(body);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, detail: result.detail },
      { status: result.status },
    );
  }
  return NextResponse.json({
    projectID: result.projectID,
    projectNumber: result.projectNumber,
    personID: result.personID,
    assignedAgent: result.assignedAgent,
  });
}
