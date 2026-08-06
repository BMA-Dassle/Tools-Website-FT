/**
 * WHO a licence-offer request is allowed to ask about.
 *
 * There are two ways to earn that right and they must answer in the same shape,
 * because the three endpoints behind them (`licence-offer`, `/add`, `/add-all`)
 * each apply the identical rule — "this personId must be in the pack" — and
 * three copies of that rule is three chances for one of them to drift open.
 *
 *   billId  — a booking. Possession of the 17-digit id is the bar the
 *             confirmation page already applies, and the roster comes from the
 *             booking record.
 *   grants  — signed waiver grants. No booking exists (the standalone waiver is
 *             often a guest's first contact, and the group-events participant
 *             link is deliberately reservation-less), so the proof travels with
 *             the request. See licence-grant.ts.
 *
 * A pack NEVER contains someone the caller has not proven a right to. That is
 * the only thing keeping these endpoints from resolving any racer's login code
 * — which is their identity at the kiosk, the check-in desk and the BMI
 * register — for anyone who can guess a sequential BMI id.
 */
import redis from "@/lib/redis";
import { verifyLicenceGrants } from "~/features/racing/wallet/licence-grant";

/** The row shape the endpoints already work in. Heat fields are present only
 *  for a booking pack — a waiver knows nothing about anyone's heat, and the
 *  pre-race cron fills the pass in later. */
export interface PackMember {
  personId: string;
  racerName?: string | null;
  heatStart?: string | null;
  track?: string | null;
  heatName?: string | null;
}

export interface LicencePack {
  members: PackMember[];
  /** The booker, when there is one — the phone the confirmation page is open
   *  on. A waiver pack has no equivalent: whoever signed is not necessarily
   *  first in the list, and guessing wrong labels a stranger "YOU". */
  primaryPersonId: string | null;
  source: "booking" | "waiver";
  /** Opaque round-trip key for the client to hand to the next endpoint —
   *  `billId=…` or `g=…`, already query-encoded. */
  query: string;
}

/**
 * Resolve a pack from a request's query string, or null when the caller proved
 * nothing. `billId` wins when both are present, so a grant can never widen a
 * booking pack.
 */
export async function resolveLicencePack(params: URLSearchParams): Promise<LicencePack | null> {
  const billId = (params.get("billId") || "").trim();
  if (/^\d+$/.test(billId)) return bookingPack(billId);

  const grants = params.get("g");
  if (grants) {
    const verified = verifyLicenceGrants(grants);
    if (!verified.length) return null;
    return {
      members: verified.map((g) => ({ personId: g.personId, racerName: g.name })),
      primaryPersonId: null,
      source: "waiver",
      query: `g=${encodeURIComponent(grants)}`,
    };
  }

  return null;
}

async function bookingPack(billId: string): Promise<LicencePack | null> {
  let record: {
    primaryPersonId?: string;
    racers?: PackMember[];
  } | null = null;
  try {
    const raw = await redis.get(`bookingrecord:${billId}`);
    record = raw ? JSON.parse(raw) : null;
  } catch {
    record = null;
  }
  if (!record?.racers?.length) return null;

  // ONE ROW PER PERSON. A racer booked into two heats appears twice in
  // `racers[]` and must not be offered two licences — there is only one of them.
  const seen = new Set<string>();
  const members: PackMember[] = [];
  for (const r of record.racers) {
    const personId = String(r?.personId ?? "").trim();
    if (!/^\d+$/.test(personId) || seen.has(personId)) continue;
    seen.add(personId);
    members.push({ ...r, personId });
  }

  const primary = String(record.primaryPersonId ?? "").trim();
  return {
    members,
    primaryPersonId: /^\d+$/.test(primary) ? primary : null,
    source: "booking",
    query: `billId=${encodeURIComponent(billId)}`,
  };
}

/** Is this person in the pack? The check every endpoint owes before it resolves
 *  a login code. */
export function packHas(pack: LicencePack, personId: string): boolean {
  const pid = String(personId ?? "").trim();
  return !!pid && pack.members.some((m) => m.personId === pid);
}
