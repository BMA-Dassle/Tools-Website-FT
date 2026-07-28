/**
 * Zod schemas for booking API contracts.
 *
 * PR-B1 shipped the placeholder; real schemas land per-activity in PR-B2..B6.
 *
 * ⚠ NOT yet universal, despite what this header used to claim. The two routes
 * that actually take money — `/api/booking/v2/reserve-all` and
 * `/api/booking/v2/reserve` — hand-roll presence checks and do NOT parse through
 * `ContactInfoSchema`. That gap cost us a $346.12 orphan on 2026-07-28 (see
 * `~/lib/helpers/email`), so those routes now assert email deliverability with
 * the SAME predicate this schema uses, and `unifiedReserve` re-asserts it before
 * the charge. Do not read this file as proof that a route is validated — check
 * the route.
 */
import { z } from "zod";
import { isDeliverableEmail } from "~/lib/helpers/email";

export const ActivitySchema = z.enum(["race", "attraction", "bowling", "kbf"]);
export type ActivityInput = z.infer<typeof ActivitySchema>;

/**
 * Email uses our own predicate rather than zod's `.email()`: zod's rule and the
 * strictest vendor's rule (QAMF) must not be allowed to drift apart, and one
 * predicate shared by the schema, the UI gate and the pre-charge guard is the
 * only way to guarantee that.
 */
export const ContactInfoSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  email: z
    .string()
    .trim()
    .refine(isDeliverableEmail, { message: "Enter a valid email address." }),
  phone: z.string().trim().min(7).max(20),
});
