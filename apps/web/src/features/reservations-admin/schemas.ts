/**
 * Zod schemas for the manage-reservation admin API surface.
 * BMI ids stay STRINGS end to end — never coerce them to Number.
 */
import { z } from "zod";

/** GET /api/admin/reservations/detail — ?id= (neon id) or ?billId= (BMI, string). */
export const detailQuerySchema = z
  .object({
    id: z.coerce.number().int().positive().optional(),
    billId: z.string().min(1).max(40).optional(),
  })
  .refine((q) => q.id !== undefined || q.billId !== undefined, {
    message: "id or billId required",
  });

/** GET /api/admin/reservations/detail/payments — ?id= only (resolve billId via detail first). */
export const paymentsQuerySchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** PATCH /api/admin/reservations/notes — empty string clears the note. */
export const notesPatchSchema = z.object({
  neonId: z.number().int().positive(),
  notes: z.string().max(2000),
});

/** PATCH /api/admin/reservations/guest — partial; at least one field. */
export const guestPatchSchema = z
  .object({
    neonId: z.number().int().positive(),
    guestName: z.string().trim().min(1).max(120).optional(),
    guestEmail: z.string().trim().email().max(200).optional(),
    guestPhone: z.string().trim().min(7).max(25).optional(),
  })
  .refine(
    (b) => b.guestName !== undefined || b.guestEmail !== undefined || b.guestPhone !== undefined,
    {
      message: "at least one of guestName, guestEmail, guestPhone required",
    },
  );
