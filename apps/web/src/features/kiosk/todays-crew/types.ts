/**
 * Today's Crew — the people who booked WITH a guest earlier today at this
 * centre (owner 2026-09-06: six friends sign up at 8pm; one comes back later
 * and the kiosk should offer the other five instead of five more sign-ins).
 *
 * Every id here is a 17-digit BMI person id and stays a STRING end to end.
 */

/** One participant row as the Neon self-join returns it — raw, un-deduped. */
export interface CoBookedRow {
  bmiPersonId: string;
  /** Name as the booking recorded it: a first name for a karting heat, a
   *  full name for an attraction / sim participant. */
  name: string;
  /** The heat's adult/junior class when the row is a karting heat; null for
   *  attractions and sims (their rosters carry no class). */
  category: "adult" | "junior" | null;
  /** 'race' for a karting heat, the attraction slug, or the sim slug. */
  kind: string;
  /** ISO-ish start of the shared heat / slot ("2026-09-06T20:00:00…"). */
  slot: string;
  bmiBillId: string | null;
  /** Booking-time waiver flag where the roster carried one (attractions, sims). */
  waiverValid: boolean | null;
}

/** What the people screens hold for one co-booker — the family picker's shape
 *  plus where the two of them were booked together. */
export interface CrewSuggestion {
  id: string;
  firstName: string;
  lastName: string;
  /** Always null today: none of our booking rows carries a birthday. The
   *  heat's `category` stands in for the adult/junior split. */
  age: number | null;
  category: "adult" | "junior" | null;
  /** true = OUR record vouches (a captured, unexpired signature, or the
   *  booking marked them valid today); null = unknown — the kiosk runs the
   *  ordinary one-person waiver read only if this person is actually added. */
  waiverValid: boolean | null;
  /** Earliest shared slot start, for the "Booked with you · 8:00 PM" line. */
  bookedAt: string;
  kind: string;
}

/** The API envelope. */
export interface TodaysCrewResponse {
  crew: CrewSuggestion[];
}

/** Per signed-in member: has the lookup been asked, is it in flight, and did
 *  it find anyone. "none" and "error" both render nothing — an error must never
 *  hold a spinner on a guest's card. */
export type CrewStatus = "idle" | "loading" | "ready" | "none" | "error";
