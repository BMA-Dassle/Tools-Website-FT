/**
 * Vercel Queues consumer for the PRODUCTION topic (`bmi-sync`).
 *
 * Thin shell: the handler lives in `@/lib/bmi-sync-consumer` and is shared with the
 * preview route. Vercel binds exactly one `queue/v2beta` trigger per function, so
 * one topic means one route file.
 */
import { createBmiSyncConsumer } from "@/lib/bmi-sync-consumer";

/** Handlers do a couple of Pandora round trips; 60s is ample headroom. */
export const maxDuration = 60;

export const POST = createBmiSyncConsumer();
