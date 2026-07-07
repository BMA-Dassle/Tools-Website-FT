import { NextRequest, NextResponse } from "next/server";
import { notesPatchSchema } from "~/features/reservations-admin/schemas";
import { updateReservationNotes } from "~/features/reservations-admin/service";

/**
 * PATCH /api/admin/reservations/notes?token=…
 * Body: { neonId: number, notes: string }   ("" clears the note)
 *
 * Saves the note to Neon, then re-syncs the QAMF memo for bowling/KBF rows
 * (the memo embeds notes — the desk reads it in Conqueror). Response carries
 * memoSynced so the UI can show whether the desk copy updated. Audited to
 * admin_action_events with a from/to diff.
 *
 * Auth: ADMIN_CAMERA_TOKEN query param (portal convention).
 */
export async function PATCH(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = notesPatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "bad body" },
      { status: 400 },
    );
  }

  try {
    const result = await updateReservationNotes(parsed.data.neonId, parsed.data.notes);
    if (!result) {
      return NextResponse.json({ error: "reservation not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[admin/reservations/notes] neonId=${parsed.data.neonId}:`, msg);
    return NextResponse.json({ error: "notes_failed", detail: msg }, { status: 500 });
  }
}
