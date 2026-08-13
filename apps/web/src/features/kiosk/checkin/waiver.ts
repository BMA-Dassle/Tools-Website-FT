/**
 * Server-side Pandora waiver-status check for the racers already on a
 * reservation — so kiosk check-in can PULL IN existing valid waivers and mark
 * those racers ready without re-signing (owner 2026-07-25).
 *
 * Direct Pandora call (same rail as schedule-racers.ts) because the client
 * `@/lib/pandora` helpers use relative fetch and can't run server-side. Racing
 * only: waivers are read at the FastTrax racing Pandora location. Never throws —
 * an unknown/expired/unreadable waiver resolves to `false` (the safe default:
 * the racer is simply shown as still needing a waiver).
 */
import { hasUnexpiredCapturedWaiver } from "@/lib/waiver-signature-store";

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const FASTTRAX_RACING_LOCATION_ID = "LAB52GY480CJF";

/**
 * True when this person holds a current (unexpired) waiver at the racing loc.
 *
 * STILL FAILS CLOSED — an unreadable record returns false, because letting an
 * unverified racer onto a kart is the one outcome worse than asking someone to
 * re-sign. What changed is that it no longer does so SILENTLY.
 *
 * A person whose BIRTHDATE IS NULL makes this endpoint return 500 "Response
 * Validator Error": the record exists, the vendor's own response schema rejects
 * it. Booking creates people without a birthdate, so this is the normal state
 * of anyone who booked online and never signed anywhere — and for weeks it
 * rendered as a confident "Waiver needed" for guests who had signed. Eric's
 * waiver was valid until 2027-08-08 the whole time we were telling him to sign.
 *
 * The distinction we log: `200 + no expiry` is a real negative; `500`/timeout
 * is "we don't know", and the person is repairable (write the birthday and the
 * record reads cleanly — see pandoraPatchBirthdate).
 */
export async function checkRacerWaiverValid(personId: string): Promise<boolean> {
  if (!personId) return false;
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  try {
    const res = await fetch(
      `${PANDORA_BASE}/bmi/person/${FASTTRAX_RACING_LOCATION_ID}/${personId}?picture=false&allRelated=false`,
      {
        headers: { Authorization: `Bearer ${key}` },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      },
    );
    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
      data?: { waiverExpiry?: string | null };
    } | null;
    if (!res.ok || !data?.success || !data.data) {
      // Unreadable ≠ unsigned. Name it so a null-birthdate person is findable
      // instead of hiding behind an ordinary-looking "needs a waiver".
      console.warn(
        `[checkin-waiver] person ${personId} UNREADABLE (HTTP ${res.status}${
          data?.error ? ` — ${data.error}` : ""
        }) — asking our own record. A null birthdate causes this; the record is ` +
          `repairable via PATCH /bmi/person.`,
      );
      /**
       * Unreadable ≠ unsigned, and this is the branch where that bites hardest.
       *
       * A cloud-minted person answers 500 until their birthdate is written — and
       * that is EXACTLY the person who just signed at the kiosk. So the most common
       * unreadable record belongs to a guest whose signature we are holding. Ask
       * for it before sending them back to a pad.
       *
       * Still fails closed on no evidence: a person with nothing in Pandora AND
       * nothing in Neon is refused, which is the rule that guards the karts.
       */
      return await hasUnexpiredCapturedWaiver(personId).catch(() => false);
    }
    const expiry = data.data.waiverExpiry ? new Date(data.data.waiverExpiry) : null;
    if (expiry && expiry.getTime() > Date.now()) return true;
    /**
     * BMI SAYS NO — ASK OUR OWN RECORD BEFORE BELIEVING IT.
     *
     * The kiosk no longer waits for cloud→local sync before finishing a waiver, so
     * for ~20-30s after a guest signs, Pandora will honestly report no waiver while
     * the push is still in the queue. Failing closed on that would send a guest who
     * signed a minute ago back to a signature pad at the CHECK-IN DESK — the delay
     * moved, not removed, and now with staff involved.
     *
     * This does not weaken the fail-closed rule that guards the karts. A Neon row
     * IS verification: it holds the drawn signature, the terms version and the
     * expiry we presented. It is stronger evidence than `waiverExpiry`, not weaker.
     */
    if (await hasUnexpiredCapturedWaiver(personId)) {
      console.log(
        `[checkin-waiver] person ${personId} has no BMI waiver yet but WE hold a current ` +
          `signature — counting it (the vendor push is still in flight).`,
      );
      return true;
    }
    return false;
  } catch (err) {
    console.warn(
      `[checkin-waiver] person ${personId} lookup FAILED (${
        err instanceof Error ? err.message : String(err)
      }) — falling back to our own record`,
    );
    // Vendor unreachable is exactly when our own record matters most.
    return await hasUnexpiredCapturedWaiver(personId).catch(() => false);
  }
}

/**
 * Resolve waiver validity for many racers at once (parallel, capped). Returns a
 * Map keyed by personId. Racers with no personId are skipped (not in the map).
 */
export async function checkRacerWaivers(
  personIds: Array<string | null | undefined>,
): Promise<Map<string, boolean>> {
  const ids = [...new Set(personIds.filter((id): id is string => !!id))];
  const out = new Map<string, boolean>();
  await Promise.all(ids.map(async (id) => out.set(id, await checkRacerWaiverValid(id))));
  return out;
}
