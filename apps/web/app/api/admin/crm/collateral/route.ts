import { writeAudit } from "~/features/crm/core/data/audit-db";
import { todayEasternYmd } from "~/features/crm/core/dates";
import { withCrmRoute } from "~/features/crm/core/http";
import {
  blobConfigured,
  collateralTypeFromUrl,
  createCollateral,
  listCollateral,
  listCollateralTags,
  normaliseTags,
} from "~/features/crm/collateral";
import { CollateralCreateSchema, CollateralListQuery } from "~/features/crm/collateral/schemas";

/**
 * /api/admin/crm/collateral (wire contract: `collateral/contracts.ts`)
 *   GET   ?centre&tag&q&archived&expired&cursor&limit
 *         → `{ok, items, nextCursor, tags, blobConfigured}`
 *   POST  DIRECTOR — the metadata row for a file that is ALREADY at a public
 *         URL, one a director pasted. → `{ok, item}`
 *
 * WHY THE POST IS DIRECTOR-GATED. Reps share; directors curate — the same rule
 * `collateral/[id]` and `collateral/upload` enforce. An ungated create would
 * let any `sales` session put an arbitrary https URL into the shared library
 * that every other rep then sends to guests, while editing and archiving that
 * same row were refused: the screen hides the button, and this is what makes
 * the hiding true.
 *
 * Keyset pagination, `limit ≤ 200` (R10): `nextCursor` is an opaque
 * `created_at|id` and there is no OFFSET anywhere.
 *
 * `expired=1` includes rows whose `valid_until` has passed; the default hides
 * them against the ET calendar day (`todayEasternYmd`, R10 — never a local
 * `Date`), so last autumn's flyer stops appearing in the picker on its own.
 *
 * `blobConfigured` rides on the list response rather than a separate call: the
 * screen has to decide between "Upload" and "Add by URL" before it can paint
 * its header, and one fewer round trip is one fewer way to render the wrong
 * one.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(CollateralListQuery, async ({ input }) => {
  const [page, tags] = await Promise.all([
    listCollateral({
      centre: input.centre ?? null,
      tag: input.tag ?? null,
      q: input.q ?? null,
      includeArchived: input.archived === "1",
      hideExpiredBefore: input.expired === "1" ? null : todayEasternYmd(),
      cursor: input.cursor ?? null,
      limit: input.limit ?? null,
    }),
    listCollateralTags(),
  ]);
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    tags,
    blobConfigured: blobConfigured(),
  };
});

export const POST = withCrmRoute(
  CollateralCreateSchema,
  async ({ input, user }) => {
    const item = await createCollateral({
      title: input.title,
      centre: input.centre ?? null,
      type: input.type ?? collateralTypeFromUrl(input.blobUrl),
      blobUrl: input.blobUrl,
      blobPathname: input.blobPathname ?? null,
      contentType: input.contentType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      tags: normaliseTags(input.tags ?? []),
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      uploadedBy: user.email,
    });
    await writeAudit({
      entity: "collateral",
      entityId: item.id,
      action: "create",
      actorEmail: user.email,
      after: item,
    });
    return { item };
  },
  { director: true },
);
