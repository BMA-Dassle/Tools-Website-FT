import { NextRequest, NextResponse } from "next/server";
import {
  WebSubmitSchema,
  centreForCenterKey,
  createLead,
  legacyWebResponse,
  missingFieldsMessage,
  webBodyToCreateInput,
} from "~/features/crm/leads";

/**
 * POST /api/sales-lead/submit — the public web form's intake (five
 * `SalesLeadForm.tsx` pages). v2 alongside v1 (R16): the URL, the request body
 * and the RESPONSE SHAPE are unchanged; what changed is where the work
 * happens.
 *
 *   before   validate → Pandora → Redis salescard → SMS / email / Teams fan-out
 *            (nothing in Neon; a Pandora failure lost the guest's submission)
 *   now      zod → `createLead(input, {source:"web"})` → the legacy body
 *            (`leads/service/web-submit.ts`). `createLead` persists the lead in
 *            Neon FIRST (R2), then mints through the same `submitPartyLead`,
 *            then runs the same fan-out (`leads/service/notify.ts`).
 *
 * Responses, byte-compatible with the form's reader (`SalesLeadForm.tsx:365-372`):
 *   400 { error: "Invalid JSON body" | "Missing required fields: …" | "Unknown centerKey: …" }
 *   502 { error }  — Pandora refused / timed out (the Neon row exists; a resubmit within
 *                    15 minutes re-uses it instead of creating a second lead)
 *   200 { ok:true, projectID, projectNumber, planner:{displayName,isIndividual}, results:{sms,email,teams} }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The legacy required-field names, in the legacy order, for the legacy message. */
const REQUIRED_ORDER = [
  "centerKey",
  "firstName",
  "lastName",
  "email",
  "phone",
  "preferredDate",
  "guestCount",
] as const;

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = WebSubmitSchema.safeParse(raw);
  if (!parsed.success) {
    const bad = new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")));
    const missing = REQUIRED_ORDER.filter((k) => bad.has(k));
    const message = missing.length
      ? missingFieldsMessage(missing)
      : `Invalid fields: ${[...bad].filter(Boolean).join(", ") || "body"}`;
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const body = parsed.data;
  if (!body.preferredDate) {
    return NextResponse.json({ error: missingFieldsMessage(["preferredDate"]) }, { status: 400 });
  }

  const resolved = centreForCenterKey(body.centerKey);
  if (!resolved) {
    return NextResponse.json({ error: `Unknown centerKey: ${body.centerKey}` }, { status: 400 });
  }

  const result = await createLead(webBodyToCreateInput(body, resolved.centre), { source: "web" });
  const out = legacyWebResponse(result);
  return NextResponse.json(out.body, { status: out.status });
}
