/**
 * Vercel Queues consumer for the PREVIEW topic (`waiver-push-preview`).
 *
 * Identical handler to the production route — only the `vercel.json` binding
 * differs. The topic split is deliberate (`waiverTopic()`): preview deployments
 * share the production Neon database, and a preview consumer receiving, pushing
 * and ACKNOWLEDGING a real guest's waiver that production never sees is exactly
 * the hazard that bit `persons-local` on 2026-08-13.
 */
import { createWaiverPushConsumer } from "~/features/kiosk/waiver/waiver-push-consumer";

/** The push itself is a couple of Pandora round trips; 60s is ample headroom. */
export const maxDuration = 60;

export const POST = createWaiverPushConsumer();
