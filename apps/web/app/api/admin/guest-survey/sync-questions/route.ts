import { NextResponse } from "next/server";
import { syncGuestSurveyQuestions } from "@/lib/guest-survey-db";

/**
 * POST /api/admin/guest-survey/sync-questions
 *
 * Reconcile the prod guest_survey_questions table with the current
 * in-code GUEST_SURVEY_QUESTIONS_SEED constant. Idempotent:
 *   - Upserts every (tag, ordinal) tuple in the seed.
 *   - Deactivates any (tag, ordinal) currently in the DB but not in
 *     the seed (soft delete so old responses keep their FK).
 *
 * Gated by ADMIN_CAMERA_TOKEN middleware (header x-admin-token or
 * ?token=). No body — the seed constant is the source of truth.
 */
export async function POST() {
  const result = await syncGuestSurveyQuestions();
  console.log(
    `[admin-debug] sync-questions upserted=${result.upserted} deactivated=${result.deactivated}`,
  );
  return NextResponse.json({ ok: true, ...result });
}
