/**
 * POST /api/crm/3cx/journal  ·  **PUBLIC BY NECESSITY**
 *
 * WHY THIS ROUTE IS PUBLIC. The 3CX server-side CRM-Integration template POSTs
 * here from the PBX as each call ends, so the CRM can journal it against the
 * lead. The PBX holds no SSO cookie and no admin token; this is one of exactly
 * three documented public `/api/crm/**` routes (brief R3).
 *
 * HOW IT IS AUTHENTICATED. `CRM_3CX_SECRET`, as the header
 * `x-crm-3cx-secret` or as `?k=` — see `service/secret.ts` and
 * `docs/crm/3cx.md`. It **FAILS CLOSED**: unset means every request is 401,
 * unlike `VOX_MO_TOKEN`, which fails open. The secret is not set today, so this
 * route answers 401 and the Calls screen says "3CX journaling is not connected
 * yet"; reconcile still fills the board from the call log in the meantime.
 *
 * IDEMPOTENT. `callId` is 3CX's `CallHistoryId` and is the unique key on
 * `crm_calls`, so a replayed POST — and the reconcile job that will see the
 * same call minutes later — merge into ONE row rather than duplicating.
 *
 * It answers 200 as soon as the row is written; nothing slow happens after the
 * response, because Vercel kills the function when it returns.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  ThreecxJournalSchema,
  recordJournalCall,
  threecxSecretOk,
  threecxUnauthorized,
} from "~/features/crm/calls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" } as const;

export async function POST(req: NextRequest): Promise<Response> {
  if (!threecxSecretOk(req)) return threecxUnauthorized();

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  // A template may send its fields in the query string instead of a body; take
  // whichever carries them, body first.
  const merged = {
    ...Object.fromEntries(req.nextUrl.searchParams.entries()),
    ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
  };

  const parsed = ThreecxJournalSchema.safeParse(merged);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request" },
      { status: 400, headers: noStore },
    );
  }

  try {
    const call = await recordJournalCall({
      callId: parsed.data.callId,
      direction: parsed.data.direction,
      number: parsed.data.number,
      extension: parsed.data.extension ?? null,
      name: parsed.data.name ?? null,
      startedAt: parsed.data.startedAt ?? null,
      endedAt: parsed.data.endedAt ?? null,
      duration: parsed.data.duration ?? null,
      status: parsed.data.status ?? null,
    });
    return NextResponse.json({ ok: true, id: call?.id ?? null }, { headers: noStore });
  } catch (err) {
    // A FIXED code, never the message: this endpoint is reachable by anything
    // holding the secret, and Neon errors carry hostnames and SQL fragments.
    console.error("[crm] 3cx journal failed", {
      callId: parsed.data.callId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "journal_failed" },
      { status: 500, headers: noStore },
    );
  }
}
