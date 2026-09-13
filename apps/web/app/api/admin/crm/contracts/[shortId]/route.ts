import {
  ContractDetailQuerySchema,
  ShortIdSchema,
  contractDetail,
  contractHistory,
  contractPayments,
  contractPublicNotes,
} from "~/features/crm/contracts";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";

/**
 * GET /api/admin/crm/contracts/[shortId]
 *   → `{ok, contract}` — the row, line items, versions with their diffs, the
 *     audit ledger, the notification ledger and the reminder rules.
 *   ?payments=1 → `{ok, timeline, error}` — LIVE Square, its own request so the
 *     Contract tab opens whether or not Square answers.
 *   ?history=1  → `{ok, entries}` — the audit + versions + milestones rail the
 *     reservations-admin board already builds; reused, not rebuilt.
 *   ?notes=1    → `{ok, live, stored, drifted, error}` — the LIVE BMI public
 *     notes behind "what the guest sees", plus the stored copy the guest page
 *     is actually rendering, so the preview can say when the two have drifted.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isOn = (v: string | undefined) => v === "1" || v === "true";

export const GET = withCrmRoute(ContractDetailQuerySchema, async ({ input, params }) => {
  const parsed = ShortIdSchema.safeParse(params.shortId);
  if (!parsed.success) throw new CrmHttpError(400, "invalid_short_id");
  const shortId = parsed.data;

  if (isOn(input.payments)) {
    const result = await contractPayments(shortId);
    if (!result) throw new CrmHttpError(404, "contract_not_found");
    return { timeline: result.timeline, error: result.error };
  }

  if (isOn(input.history)) {
    const entries = await contractHistory(shortId);
    if (!entries) throw new CrmHttpError(404, "contract_not_found");
    return { entries };
  }

  if (isOn(input.notes)) {
    const notes = await contractPublicNotes(shortId);
    if (!notes) throw new CrmHttpError(404, "contract_not_found");
    return { live: notes.live, stored: notes.stored, drifted: notes.drifted, error: notes.error };
  }

  const contract = await contractDetail(shortId);
  if (!contract) throw new CrmHttpError(404, "contract_not_found");
  return { contract };
});
