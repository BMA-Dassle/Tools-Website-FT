import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@ft/db";

/**
 * POST /api/admin/guest-survey/wipe-test-data
 *
 * Destructive cleanup of test-only survey rows. Restricted to rows
 * whose `origin_ref` starts with `admin-test-` (the prefix the
 * send-test endpoint uses) so we never touch production-triggered
 * surveys.
 *
 * Auth: middleware enforces ADMIN_CAMERA_TOKEN via header x-admin-token
 * or ?token=.
 *
 * Body (all optional):
 *   {
 *     completedOnly?: boolean;  // default true — only wipe rows whose responses_json IS NOT NULL.
 *     dryRun?:        boolean;  // default false. true = report only, no writes.
 *   }
 *
 * Wipes (in order so FK constraints don't trip):
 *   1. marketing_touches where campaign='guest_survey' AND ref_id IN (matched tokens)
 *   2. guest_survey_promo_codes where survey_id IN (matched ids)
 *   3. guest_surveys where origin_ref LIKE 'admin-test-%' [AND completed_at IS NOT NULL]
 */
export async function POST(req: NextRequest) {
  let body: { completedOnly?: boolean; dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — use defaults.
  }
  const completedOnly = body.completedOnly !== false; // default true
  const dryRun = body.dryRun === true;

  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 500 });
  }
  const q = sql();

  // 1. Identify victim rows (id + token + completed_at) so we can also
  //    scope marketing_touches by ref_id (which we set to the token).
  const targets = completedOnly
    ? await q`
        SELECT id, token, completed_at
        FROM guest_surveys
        WHERE origin_ref LIKE 'admin-test-%'
          AND completed_at IS NOT NULL
      `
    : await q`
        SELECT id, token, completed_at
        FROM guest_surveys
        WHERE origin_ref LIKE 'admin-test-%'
      `;

  const ids = (targets as Array<{ id: string }>).map((r) => r.id);
  const tokens = (targets as Array<{ token: string }>).map((r) => r.token);

  if (ids.length === 0) {
    return NextResponse.json({
      ok: true,
      dryRun,
      completedOnly,
      counts: { surveys: 0, promoCodes: 0, touches: 0 },
    });
  }

  // Counts before wipe so the response is informative even in dryRun.
  const promoCountRows = await q`
    SELECT COUNT(*)::int AS c FROM guest_survey_promo_codes WHERE survey_id = ANY(${ids}::uuid[])
  `;
  const promoCodeCount = (promoCountRows[0] as { c: number }).c;

  const touchCountRows = await q`
    SELECT COUNT(*)::int AS c FROM marketing_touches
    WHERE campaign = 'guest_survey' AND ref_id = ANY(${tokens}::text[])
  `;
  const touchCount = (touchCountRows[0] as { c: number }).c;

  if (!dryRun) {
    // FK chain: marketing_touches has no FK to guest_surveys (just ref_id text),
    // but guest_survey_promo_codes(survey_id) → guest_surveys(id). Wipe promos first.
    await q`DELETE FROM marketing_touches
            WHERE campaign = 'guest_survey' AND ref_id = ANY(${tokens}::text[])`;
    await q`DELETE FROM guest_survey_promo_codes WHERE survey_id = ANY(${ids}::uuid[])`;
    await q`DELETE FROM guest_surveys WHERE id = ANY(${ids}::uuid[])`;
  }

  console.log(
    `[admin-debug] wipe-test-data completedOnly=${completedOnly} dryRun=${dryRun}` +
      ` wiped surveys=${ids.length} promoCodes=${promoCodeCount} touches=${touchCount}`,
  );

  return NextResponse.json({
    ok: true,
    dryRun,
    completedOnly,
    counts: {
      surveys: ids.length,
      promoCodes: promoCodeCount,
      touches: touchCount,
    },
  });
}
