import { z } from "zod";
import { OFFICE_CLIENT_KEYS } from "~/features/crm/core/centres";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { getCrmSettings, putCrmSetting } from "~/features/crm/core/data/settings-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import type { CrmSettingKey } from "~/features/crm/core/types";

/**
 * /api/admin/crm/settings (wire contract)
 *   GET            → `{ok, settings: CrmSettings}` — defaults filled in; zero rows is fine.
 *   POST director  `{key, value}` → validates PER KEY, upserts, audits, returns the whole object.
 *
 * `bmi_writes` is a KILL SWITCH (R4): storing `enabled:false` (or a clientKey
 * in `offCentres`) is the only way to pause; a missing row is ON. The screen
 * labels it "Pause BMI writes".
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ClientKey = z
  .string()
  .refine(
    (v) => (OFFICE_CLIENT_KEYS as readonly string[]).includes(v),
    "expected an Office clientKey",
  );

const BmiWritesValue = z.object({
  enabled: z.boolean(),
  offCentres: z.array(ClientKey).max(2).default([]),
});

// The sweep is a safety net, so its only knob is how long a lead that arrived
// unassigned waits before the net retries it. `afterHours` was removed with the
// hold-until-9-AM rail (owner, 2026-09-13); an old client that still sends it
// is accepted and the key is dropped rather than 400ing a director's save.
const SweepValue = z.object({
  delayMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60),
});

const ResponseTargetValue = z
  .number()
  .int()
  .min(1)
  .max(24 * 60);

const VALUE_SCHEMAS: Record<CrmSettingKey, z.ZodType> = {
  bmi_writes: BmiWritesValue,
  sweep: SweepValue,
  response_target_minutes: ResponseTargetValue,
};

const PostBody = z.object({
  key: z.enum(["bmi_writes", "sweep", "response_target_minutes"]),
  value: z.unknown(),
});

export const GET = withCrmRoute(z.object({}), async () => ({ settings: await getCrmSettings() }));

export const POST = withCrmRoute(
  PostBody,
  async ({ input, user }) => {
    const parsed = VALUE_SCHEMAS[input.key].safeParse(input.value);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new CrmHttpError(
        400,
        `invalid_value: ${first ? `${first.path.map(String).join(".") || "value"}: ${first.message}` : "bad value"}`,
      );
    }
    const { before } = await putCrmSetting(input.key, parsed.data, user.email);
    await writeAudit({
      entity: "setting",
      entityId: input.key,
      action: "set",
      actorEmail: user.email,
      before: before ?? null,
      after: parsed.data,
    });
    return { settings: await getCrmSettings() };
  },
  { director: true },
);
