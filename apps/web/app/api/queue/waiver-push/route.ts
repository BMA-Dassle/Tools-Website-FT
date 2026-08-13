/**
 * Vercel Queues consumer for the PRODUCTION topic (`waiver-push`).
 *
 * Thin shell on purpose: the handler lives in
 * `~/features/kiosk/waiver/waiver-push-consumer` and is shared with the preview
 * route. Vercel binds exactly one `queue/v2beta` trigger per function, so one
 * topic means one route file — see the factory's header for the build error that
 * two triggers on one route produces.
 */
import { createWaiverPushConsumer } from "~/features/kiosk/waiver/waiver-push-consumer";

/** The push itself is a couple of Pandora round trips; 60s is ample headroom. */
export const maxDuration = 60;

export const POST = createWaiverPushConsumer();
