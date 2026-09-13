import { z } from "zod";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  GsPostBodySchema,
  liveGsDeps,
  loadGsPayload,
  setGsDepartments,
  setGsLogin,
} from "~/features/crm/rules";

/**
 * /api/admin/crm/rules/gs (wire contract: `rules/contracts.ts`)
 *   GET            → `{ok, setting, configured, gsRep, members, membersError}`
 *                    — the 7shifts department(s) that make the Guest Services
 *                    bucket "on shift", and who is in them.
 *   POST director  `{action:"departments", ids, name?}` → store the list
 *                  `{action:"login", email, works}`     → map / unmap ONE
 *                    address to the bucket.
 *
 * Owner decision 2026-09-13 (§5.7b): Guest Services is 7shifts department
 * `635186` ("Call Center", HeadPinz Fort Myers). Department membership decides
 * SHIFT COVERAGE only. It must never create sign-in rows on its own — eric@ and
 * jacob@ are members, and a blind upsert would sign both directors in as the
 * bucket and lose their own rows. Each toggle is therefore one deliberate
 * director action, guarded again on this side by `gsLoginRefusal`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(z.object({}), async () => loadGsPayload(liveGsDeps()));

export const POST = withCrmRoute(
  GsPostBodySchema,
  async ({ input, user }) => {
    const deps = liveGsDeps();
    if (input.action === "departments") {
      const { before, after } = await setGsDepartments({
        ids: input.ids,
        name: input.name,
        actorEmail: user.email,
      });
      await writeAudit({
        entity: "setting",
        entityId: "sevenshifts",
        action: "set",
        actorEmail: user.email,
        before: before ?? null,
        after,
      });
      return loadGsPayload(deps);
    }

    const outcome = await setGsLogin(deps, {
      email: input.email,
      works: input.works,
      actorEmail: user.email,
    });
    if (outcome.refused) throw new CrmHttpError(409, outcome.refused);
    await writeAudit({
      entity: "rep_login",
      entityId: input.email,
      action: input.works ? "works-as-gs" : "not-gs",
      actorEmail: user.email,
      before: { worksAsGs: !input.works },
      after: { worksAsGs: input.works, changed: outcome.changed },
    });
    return outcome.payload;
  },
  { director: true },
);
