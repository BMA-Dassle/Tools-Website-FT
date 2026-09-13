import { z } from "zod";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { publicRoster } from "~/features/crm/reps";
import {
  RulesPostBodySchema,
  getRule,
  insertRule,
  listRules,
  reorderRules,
  setRuleEnabled,
  updateRule,
} from "~/features/crm/rules";

/**
 * /api/admin/crm/rules (wire contract: `rules/contracts.ts`)
 *   GET            → `{ok, rules, reps}` — every rule in position order plus
 *                    the people a rule may name (no directors).
 *   POST director  `{action:"upsert", rule}` | `{action:"toggle", id, enabled}`
 *                  | `{action:"reorder", ids}` → `{ok, rules}`; every action
 *                  writes `crm_audit` with the signed-in `actor_email` (R9).
 *
 * Rep references inside a rule are SLUGS; an upsert naming a slug that is not
 * on the roster is refused with 400 so a rule can never point at nobody.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(z.object({}), async () => {
  const [rules, reps] = await Promise.all([
    listRules(),
    publicRoster({ roles: ["rep", "bucket", "hold"] }),
  ]);
  return { rules, reps };
});

export const POST = withCrmRoute(
  RulesPostBodySchema,
  async ({ input, user }) => {
    if (input.action === "upsert") {
      const named = input.rule.then.hold ?? input.rule.then.route;
      if (named) {
        const reps = await publicRoster({ roles: ["rep", "bucket", "hold"] });
        if (!reps.some((r) => r.slug === named)) {
          throw new CrmHttpError(400, `unknown_rep: ${named}`);
        }
      }
      if (input.rule.id) {
        const before = await getRule(input.rule.id);
        if (!before) throw new CrmHttpError(404, "rule_not_found");
        const after = await updateRule(input.rule.id, input.rule, user.email);
        await writeAudit({
          entity: "assignment_rule",
          entityId: input.rule.id,
          action: "update",
          actorEmail: user.email,
          before,
          after,
        });
      } else {
        const after = await insertRule(input.rule, user.email);
        await writeAudit({
          entity: "assignment_rule",
          entityId: after.id,
          action: "create",
          actorEmail: user.email,
          after,
        });
      }
    } else if (input.action === "toggle") {
      const before = await getRule(input.id);
      if (!before) throw new CrmHttpError(404, "rule_not_found");
      const after = await setRuleEnabled(input.id, input.enabled, user.email);
      await writeAudit({
        entity: "assignment_rule",
        entityId: input.id,
        action: input.enabled ? "enable" : "disable",
        actorEmail: user.email,
        before,
        after,
      });
    } else {
      const before = (await listRules()).map((r) => r.id);
      await reorderRules(input.ids, user.email);
      await writeAudit({
        entity: "assignment_rule",
        entityId: "*",
        action: "reorder",
        actorEmail: user.email,
        before,
        after: input.ids,
      });
    }
    return { rules: await listRules() };
  },
  { director: true },
);
