import { BuilderCatalogQuerySchema, findLeadForBuilder, readCatalog } from "~/features/crm/bmi";
import { CENTRES } from "~/features/crm/core/centres";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * `GET /api/admin/crm/builder/catalog?centre=&date=[&q=][&productId=][&quantity=][&lead=]`
 *
 * READ ONLY — the product picker.
 *
 * Without `productId` it is the names-only list, ranked for `q` out of the
 * tenant's cached metadata blob. With `productId` it is one product and its
 * LIVE price for `date`, straight from `projectProduct/price`.
 *
 * The split is not a micro-optimisation. Pricing is one Office round trip per
 * product and a tenant's catalogue runs to hundreds; more importantly, the
 * price depends on the DATE (weekday and weekend are different numbers), so a
 * list priced once would be wrong for every other event on the page. The
 * number the rep sees and the number the quote charges are the same read, made
 * for the same day.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(BuilderCatalogQuerySchema, async ({ input }) => {
  const clientKey = CENTRES[input.centre].clientKey;

  // `projectProduct/price` takes the project when there is one, so a project
  // with its own negotiated pricing answers with ITS number rather than the
  // catalogue's. A lead with no project yet prices off the bare catalogue,
  // which is the right answer for a quote nobody has committed to.
  const projectId = input.lead
    ? ((await findLeadForBuilder(input.lead))?.bmiProjectId ?? undefined)
    : undefined;

  const read = await readCatalog(clientKey, input.date, {
    q: input.q,
    productId: input.productId,
    quantity: input.quantity,
    projectId,
  });

  return {
    centre: input.centre,
    date: input.date,
    products: read.products,
    source: read.source,
    ...(read.error ? { error: read.error } : {}),
  };
});
