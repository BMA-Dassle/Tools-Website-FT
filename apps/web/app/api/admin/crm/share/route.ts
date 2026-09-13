import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  ShareError,
  createShare,
  findShareLead,
  listSharesFor,
  revokeShare,
} from "~/features/crm/collateral";
import { SHARE_DELIVERY_REASON } from "~/features/crm/collateral/contracts";
import { ShareListQuery, SharePostSchema } from "~/features/crm/collateral/schemas";

/**
 * /api/admin/crm/share
 *   GET   ?collateralId | ?lead → `{ok, shares}`
 *   POST  `{action:"create", collateralId, lead?, contactId?, channel?, expiresInDays?}`
 *         → `{ok, share, lead, delivery}`
 *         `{action:"revoke", shareToken}` → `{ok, shares}`
 *
 * A CREATE is three writes in Neon before the rep sees a URL (R2): the
 * `crm_share_links` row, the collateral row's share counter, and a
 * `crm_activities` row so the deal timeline shows the touch. Only the last of
 * those is allowed to fail quietly — see `service/share.ts`.
 *
 * `delivery` says, in the response, why texting and email are not options yet:
 * those rails belong to C1 and C2, and the ShareSheet renders their buttons
 * disabled with this exact reason rather than pretending or hiding them. When
 * C1 lands it sends the link through `crm/sms` and changes this field; nothing
 * else about a share moves.
 *
 * REVOKE is director-only (a rep can always make another link; pulling one
 * back reaches a guest who already has it). It is not a delete: the row keeps
 * its open history and answers 410 from then on.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DELIVERY = {
  sms: "unavailable",
  email: "unavailable",
  reason: SHARE_DELIVERY_REASON,
} as const;

export const GET = withCrmRoute(ShareListQuery, async ({ input }) => {
  if (!input.collateralId && !input.lead) throw new CrmHttpError(400, "collateralId_or_lead");
  const lead = input.lead ? await findShareLead(input.lead) : null;
  if (input.lead && !lead) return { shares: [] };
  const shares = await listSharesFor({
    collateralId: input.collateralId ?? null,
    leadId: lead?.id ?? null,
    limit: 50,
  });
  return { shares };
});

export const POST = withCrmRoute(SharePostSchema, async ({ input, user, req }) => {
  if (input.action === "revoke") {
    if (user.role !== "director") throw new CrmHttpError(403, "director_only");
    const ok = await revokeShare(input.shareToken);
    if (!ok) throw new CrmHttpError(404, "share_not_found");
    await writeAudit({
      entity: "share_link",
      entityId: input.shareToken,
      action: "revoke",
      actorEmail: user.email,
    });
    return { shares: await listSharesFor({ collateralId: null, leadId: null, limit: 50 }) };
  }

  try {
    const { share, lead } = await createShare({
      collateralId: input.collateralId,
      lead: input.lead ?? null,
      contactId: input.contactId ?? null,
      repId: user.rep?.id ?? null,
      channel: input.channel ?? "link",
      expiresInDays: input.expiresInDays,
      actorEmail: user.email,
    });
    await writeAudit({
      entity: "share_link",
      entityId: share.token,
      action: "create",
      actorEmail: user.email,
      after: {
        collateralId: share.collateralId,
        leadId: share.leadId,
        channel: share.channel,
        expiresAt: share.expiresAt,
        // The origin the rep is on, so a link copied from a preview is
        // recognisable later: the URL itself is always production-shaped.
        from: req.nextUrl.origin,
      },
    });
    return { share, lead, delivery: DELIVERY };
  } catch (err) {
    if (err instanceof ShareError) throw new CrmHttpError(404, err.code);
    throw err;
  }
});
