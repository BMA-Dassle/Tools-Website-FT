/**
 * Zod schemas for booking API contracts.
 *
 * Every `/api/booking/v2/*` route parses its request body through one of
 * these before delegating to a service module. Errors are surfaced as 400.
 *
 * PR-B1 ships the placeholder. Real schemas land per-activity in PR-B2..B6.
 */
import { z } from "zod";

export const ActivitySchema = z.enum(["race", "attraction", "bowling", "kbf"]);
export type ActivityInput = z.infer<typeof ActivitySchema>;

export const ContactInfoSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  email: z.string().trim().email(),
  phone: z.string().trim().min(7).max(20),
});
