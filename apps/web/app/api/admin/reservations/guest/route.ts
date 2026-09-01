import { NextRequest, NextResponse } from "next/server";
import { guestPatchSchema } from "~/features/reservations-admin/schemas";
import { updateGuestContactService } from "~/features/reservations-admin/service";
import { isAdminApiRequest } from "@/lib/admin-request-auth";

/**
 * PATCH /api/admin/reservations/guest?token=…
 * Body: { neonId: number, guestName?, guestEmail?, guestPhone? }  (≥1 field)
 *
 * PARTIAL guest-contact edit — omitted fields are untouched (per-field
 * COALESCE in Neon; never the full-overwrite updateWalkinGuestData). Future
 * confirmations/resends read Neon so they pick the fix up immediately. The
 * Square customer is never renamed (loyalty identity); QAMF converges on the
 * next reschedule. Allowed on cancelled rows (fix contact before resending a
 * store-credit card). Audited with a per-field from/to diff.
 *
 * Auth: ADMIN_CAMERA_TOKEN query param (portal convention).
 */
export async function PATCH(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!(await isAdminApiRequest(req, { token: token }))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = guestPatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "bad body" },
      { status: 400 },
    );
  }

  const { neonId, ...fields } = parsed.data;
  try {
    const result = await updateGuestContactService(neonId, fields);
    if (!result) {
      return NextResponse.json({ error: "reservation not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[admin/reservations/guest] neonId=${neonId}:`, msg);
    return NextResponse.json({ error: "guest_failed", detail: msg }, { status: 500 });
  }
}
