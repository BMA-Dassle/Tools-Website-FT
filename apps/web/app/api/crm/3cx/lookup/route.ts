/**
 * GET /api/crm/3cx/lookup?number=…  ·  **PUBLIC BY NECESSITY**
 *
 * WHY THIS ROUTE IS PUBLIC. It is one of exactly three documented public
 * `/api/crm/**` routes (brief R3; the others are `3cx/journal` and
 * `share/[token]`). The caller is the 3CX server-side CRM-Integration template
 * running ON THE PBX: it has no browser, no SSO cookie and no admin token, and
 * it calls this URL to pop the caller's details on the agent's screen. There is
 * no way to put it behind the admin gate.
 *
 * HOW IT IS AUTHENTICATED. A shared secret, `CRM_3CX_SECRET`, sent either as
 * the header `x-crm-3cx-secret` or as `?k=` (both accepted because the PBX's
 * template capabilities could not be read — `GET /xapi/v1/CrmTemplates` is a
 * 404 for our API user; see `docs/crm/3cx.md`). It **FAILS CLOSED**: with the
 * env var unset every request is 401. That is the deliberate opposite of
 * `VOX_MO_TOKEN`, which fails OPEN when unset (`app/api/sms-webhook/vox/
 * inbound/route.ts`) and therefore publishes its endpoint by accident.
 * `secret.test.ts` pins the unset case.
 *
 * WHAT IT DISCLOSES. One contact — name, number, email, company — and a link to
 * their deal. Never a list, never notes, never money. An unknown number gets
 * `{contact: null}`, not a guess.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  ThreecxLookupSchema,
  lookupByNumber,
  threecxSecretOk,
  threecxUnauthorized,
} from "~/features/crm/calls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  if (!threecxSecretOk(req)) return threecxUnauthorized();

  const parsed = ThreecxLookupSchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const contact = await lookupByNumber(parsed.data.number);
  return NextResponse.json({ contact }, { headers: { "cache-control": "no-store" } });
}
