import { z } from "zod";

/**
 * Zod schemas for the kiosk mobile-join routes. Person ids are validated as
 * digit STRINGS (BMI ids are 17-digit and exceed Number.MAX_SAFE_INTEGER —
 * they must never pass through Number()). Everything a phone submits is
 * length-capped: the payload was produced by our own client flows, but the
 * endpoint is public and token possession is the only gate.
 */

const digitString = z.string().regex(/^\d+$/).max(24);

export const createJoinSessionSchema = z.object({
  // Optional `~nonce` suffix = per-device scope for the supersede rule (two
  // devices sharing a kioskNumber must never retire each other's live QR).
  kioskId: z.string().regex(/^(fort-myers|naples):\d{1,4}(~[a-z0-9]{4,16})?$/),
  center: z.enum(["fort-myers", "naples"]),
  brand: z.enum(["fasttrax", "headpinz"]),
  stepKind: z.enum(["race", "attraction"]),
});
export type CreateJoinSessionInput = z.infer<typeof createJoinSessionSchema>;

/** Kiosk-sent close reasons only — `superseded`/`expired` are server-set. */
export const closeJoinSessionSchema = z.object({
  reason: z.enum(["continued", "start-over", "idle", "done"]),
});

export const clientStageSchema = z.enum(["landing", "signing-in", "waiver", "done"]);

export const joinGuestSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().max(60).optional(),
  bmiPersonId: digitString.optional(),
  pandoraPersonId: digitString.optional(),
  isNewRacer: z.boolean(),
  category: z.literal("adult"),
  memberships: z.array(z.string().max(80)).max(20).optional(),
  waiverValid: z.boolean().optional(),
  creditBalances: z
    .array(
      z.object({
        kind: z.string().max(40),
        balance: z.number().int().min(0).max(999),
      }),
    )
    .max(20)
    .optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().max(120).optional(),
  /** Phone proven by the join flow's SMS OTP (returning sign-in only). */
  phoneVerified: z.boolean().optional(),
  dobIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const submitGuestSchema = z.object({
  clientId: z.string().min(8).max(64),
  guest: joinGuestSchema,
});
