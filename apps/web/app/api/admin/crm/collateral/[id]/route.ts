import { z } from "zod";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  getCollateral,
  listSharesFor,
  normaliseTags,
  setCollateralArchived,
  updateCollateral,
} from "~/features/crm/collateral";
import { CollateralItemPostSchema } from "~/features/crm/collateral/schemas";

/**
 * /api/admin/crm/collateral/[id]
 *   GET            → `{ok, item, shares}` — the item plus every link ever made
 *                    from it, so the sheet can show "41 shares · 12 opened".
 *   POST director  `{action:"update", patch}` | `{action:"archive"}` | `{action:"restore"}`
 *                  → `{ok, item, shares}`; every action writes `crm_audit`.
 *
 * DIRECTOR-ONLY on the write side, and on purpose: a rep shares, a director
 * curates. Archiving is what takes a file out of every rep's picker at once —
 * last season's pricing must stop being sharable the moment it is wrong — and
 * `setCollateralArchived` also makes every OUTSTANDING share link answer 410
 * (`isShareExpired` treats an archived file as gone), which is the point of
 * archiving rather than deleting.
 *
 * `id` comes from the path, not the body: `withCrmRoute` hands the handler the
 * resolved `params`, and the schema never sees it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^\d{1,18}$/;

function idFrom(params: Record<string, string | string[]>): string {
  const raw = params.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id || !ID_RE.test(id)) throw new CrmHttpError(404, "collateral_not_found");
  return id;
}

async function payload(id: string) {
  const item = await getCollateral(id);
  if (!item) throw new CrmHttpError(404, "collateral_not_found");
  const shares = await listSharesFor({ collateralId: id, limit: 50 });
  return { item, shares };
}

export const GET = withCrmRoute(z.object({ token: z.string().optional() }), async ({ params }) =>
  payload(idFrom(params)),
);

export const POST = withCrmRoute(
  CollateralItemPostSchema,
  async ({ input, user, params }) => {
    const id = idFrom(params);
    const before = await getCollateral(id);
    if (!before) throw new CrmHttpError(404, "collateral_not_found");

    if (input.action === "update") {
      const patch = input.patch;
      const updated = await updateCollateral(
        id,
        {
          ...patch,
          centre: patch.centre === undefined ? undefined : (patch.centre ?? null),
          tags: patch.tags ? normaliseTags(patch.tags) : undefined,
          validFrom: patch.validFrom === undefined ? undefined : (patch.validFrom ?? null),
          validUntil: patch.validUntil === undefined ? undefined : (patch.validUntil ?? null),
        },
        user.email,
      );
      if (!updated) throw new CrmHttpError(404, "collateral_not_found");
      await writeAudit({
        entity: "collateral",
        entityId: id,
        action: "update",
        actorEmail: user.email,
        before,
        after: updated,
      });
    } else {
      const archived = input.action === "archive";
      const updated = await setCollateralArchived(id, archived, user.email);
      if (!updated) throw new CrmHttpError(404, "collateral_not_found");
      await writeAudit({
        entity: "collateral",
        entityId: id,
        action: archived ? "archive" : "restore",
        actorEmail: user.email,
        before,
        after: updated,
      });
    }
    return payload(id);
  },
  { director: true },
);
