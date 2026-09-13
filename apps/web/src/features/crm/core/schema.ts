/**
 * `ensureCrmSchema()` — every sub's `ensureSchema`, awaited once (brief §3.8),
 * then the lazy seed when `crm_reps` is empty.
 *
 * Used by the jobs runner, the cron and the seed wrapper only; normal reads
 * call their own sub's `ensureSchema`. Each sub's function is memoised, so
 * calling this twice — or a sub's own ensure before it — issues every CREATE
 * exactly once per process (`schema.test.ts` counts them).
 *
 * Order follows the foreign keys: reps → statuses → accounts/contacts → leads →
 * assignments → activities; everything else hangs off reps or leads or stands
 * alone. A sub that references another awaits that sub's ensure itself, so
 * the order here is belt and braces, not the only guarantee.
 *
 * THIRTY TABLES (the number the charter asks the seed wrapper to count):
 *   reps: crm_reps, crm_rep_logins · core: crm_settings, crm_audit ·
 *   statuses: crm_statuses, crm_status_bmi_map · leads: crm_accounts,
 *   crm_contacts, crm_leads, crm_assignments · activities: crm_activities ·
 *   rules: crm_assignment_rules, crm_shifts · bmi: crm_bmi_projects,
 *   crm_bmi_sync_runs, crm_quote_lines, crm_quote_templates · sms:
 *   crm_sms_threads, crm_sms_messages · email: crm_email_links,
 *   crm_graph_subscriptions · calls: crm_calls · kpi: crm_targets, crm_goals ·
 *   collateral: crm_collateral, crm_templates, crm_share_links · cold:
 *   crm_cold_lists, crm_cold_rows · jobs: crm_jobs.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";
import { ensureStatusMapSchema, ensureStatusesSchema } from "~/features/crm/statuses";
import {
  ensureAccountsSchema,
  ensureAssignmentsSchema,
  ensureContactsSchema,
  ensureLeadsSchema,
} from "~/features/crm/leads";
import { ensureActivitiesSchema } from "~/features/crm/activities";
import { ensureRulesSchema, ensureShiftsSchema } from "~/features/crm/rules";
import {
  ensureBmiProjectsSchema,
  ensureQuoteLinesSchema,
  ensureQuoteTemplatesSchema,
} from "~/features/crm/bmi";
import { ensureSmsMessagesSchema, ensureSmsThreadsSchema } from "~/features/crm/sms";
import { ensureEmailSchema } from "~/features/crm/email";
import { ensureCallsSchema } from "~/features/crm/calls";
import { ensureGoalsSchema, ensureTargetsSchema } from "~/features/crm/kpi";
import {
  ensureCollateralSchema,
  ensureShareLinksSchema,
  ensureTemplatesSchema,
} from "~/features/crm/collateral";
import { ensureColdListsSchema, ensureColdRowsSchema } from "~/features/crm/cold";
import { ensureJobsSchema } from "~/features/crm/jobs";
import { ensureAuditSchema } from "./data/audit-db";
import { ensureSettingsSchema } from "./data/settings-db";
import { runSeed } from "./seed";

/** Every `crm_*` table PR1 creates, for the aggregator test and the seed wrapper. */
export const CRM_TABLES = [
  "crm_reps",
  "crm_rep_logins",
  "crm_settings",
  "crm_audit",
  "crm_statuses",
  "crm_status_bmi_map",
  "crm_accounts",
  "crm_contacts",
  "crm_leads",
  "crm_assignments",
  "crm_activities",
  "crm_assignment_rules",
  "crm_shifts",
  "crm_bmi_projects",
  "crm_bmi_sync_runs",
  "crm_quote_lines",
  "crm_quote_templates",
  "crm_sms_threads",
  "crm_sms_messages",
  "crm_email_links",
  "crm_graph_subscriptions",
  "crm_calls",
  "crm_targets",
  "crm_goals",
  "crm_collateral",
  "crm_templates",
  "crm_share_links",
  "crm_cold_lists",
  "crm_cold_rows",
  "crm_jobs",
] as const;

let ready: Promise<void> | null = null;

async function seedIfEmpty(): Promise<void> {
  const q = sql();
  const rows = (await q`SELECT count(*)::int AS n FROM crm_reps`) as { n: number }[];
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0) await runSeed();
}

export function ensureCrmSchema(): Promise<void> {
  if (!isDbConfigured()) return Promise.resolve();
  ready ??= (async () => {
    await ensureRepsSchema();
    await ensureSettingsSchema();
    await ensureAuditSchema();
    await ensureStatusesSchema();
    await ensureStatusMapSchema();
    await ensureAccountsSchema();
    await ensureContactsSchema();
    await ensureLeadsSchema();
    await ensureAssignmentsSchema();
    await ensureActivitiesSchema();
    await ensureRulesSchema();
    await ensureShiftsSchema();
    await ensureBmiProjectsSchema();
    await ensureQuoteLinesSchema();
    await ensureQuoteTemplatesSchema();
    await ensureSmsThreadsSchema();
    await ensureSmsMessagesSchema();
    await ensureEmailSchema();
    await ensureCallsSchema();
    await ensureTargetsSchema();
    await ensureGoalsSchema();
    await ensureCollateralSchema();
    await ensureTemplatesSchema();
    await ensureShareLinksSchema();
    await ensureColdListsSchema();
    await ensureColdRowsSchema();
    await ensureJobsSchema();
    await seedIfEmpty();
  })();
  return ready;
}
