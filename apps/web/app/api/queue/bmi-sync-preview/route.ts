/**
 * Vercel Queues consumer for the PREVIEW topic (`bmi-sync-preview`).
 *
 * Identical handler to the production route — only the `vercel.json` binding
 * differs. The topic split is deliberate (`syncTopic()`): preview deployments share
 * the production Neon database, and a preview consumer claiming and ACKNOWLEDGING a
 * real guest's row that production never sees is the `persons-local` hazard with a
 * Pandora write attached.
 */
import { createBmiSyncConsumer } from "@/lib/bmi-sync-consumer";

/** Handlers do a couple of Pandora round trips; 60s is ample headroom. */
export const maxDuration = 60;

export const POST = createBmiSyncConsumer();
