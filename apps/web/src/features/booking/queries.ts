/**
 * React Query key factory for booking.
 *
 * Centralized so cross-feature invalidation (e.g. cancelling a Square Order
 * invalidates the confirmation read) stays in one file. Every booking query
 * key starts with `["booking", ...]` to keep them grouped in devtools.
 *
 * Convention: tuples, not strings. React Query treats arrays as structured
 * keys for partial-match invalidation.
 *
 *   queryClient.invalidateQueries({ queryKey: bookingKeys.square.order(id) });
 *   queryClient.invalidateQueries({ queryKey: bookingKeys.all });          // nukes everything booking
 *
 * Add new query families here as activities ship.
 */
export const bookingKeys = {
  /** Match every booking key — broad invalidation. */
  all: ["booking"] as const,

  /** Square Order reads (cart + metadata). */
  square: {
    all: ["booking", "square"] as const,
    order: (orderId: string) => ["booking", "square", "order", orderId] as const,
  },

  /** BMI reads (per-activity availability, person lookup, bill overview). */
  bmi: {
    all: ["booking", "bmi"] as const,
    availability: (params: { center: string; date: string; productId: string }) =>
      ["booking", "bmi", "availability", params] as const,
    overview: (billId: string) => ["booking", "bmi", "overview", billId] as const,
  },

  /** Conq (QAMF) reads (lane availability, reservation status). */
  conq: {
    all: ["booking", "conq"] as const,
    slots: (params: { centerId: string; date: string }) =>
      ["booking", "conq", "slots", params] as const,
    reservation: (id: string) => ["booking", "conq", "reservation", id] as const,
  },

  /** KBF reads (lookup, family roster). */
  kbf: {
    all: ["booking", "kbf"] as const,
    lookup: (emailOrPhone: string) => ["booking", "kbf", "lookup", emailOrPhone] as const,
    pass: (passId: number) => ["booking", "kbf", "pass", passId] as const,
  },

  /** Pandora reads (returning racer, credits, party-lead status). */
  pandora: {
    all: ["booking", "pandora"] as const,
    person: (personId: string) => ["booking", "pandora", "person", personId] as const,
    credits: (personId: string) => ["booking", "pandora", "credits", personId] as const,
  },
} as const;
