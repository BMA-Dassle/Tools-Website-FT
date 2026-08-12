/**
 * Cross-rail visibility barriers — "can the OTHER side see this thing yet?"
 *
 * The whole cloud-first design rests on these three probes. Each answers one
 * question with one of three verdicts, and the distinction between "absent" and
 * "unreadable" is the part that has burned us:
 *
 *   open   — the other side has it; the handler may run
 *   closed — not there yet; try again later (NOT a failure, does not burn the
 *            attempt budget)
 *   error  — we could not ask (vendor down / no creds); treat as closed but
 *            surface the reason
 *
 * ── THE 404-vs-500 RULE (measured live 2026-08-12) ─────────────────────────
 * Pandora `GET /v2/bmi/person/{loc}/{id}` has THREE meanings, and only one of
 * them means "absent":
 *   404 "No person found with that ID."  → genuinely NOT on the local server
 *   500 "Response Validator Error"       → **PRESENT, birthdate is NULL** — the
 *                                          record exists, the vendor's own
 *                                          response schema rejects the payload
 *   200                                  → present and readable
 * So `person-local` opens on **anything but a 404**. A barrier that waited for
 * 200 would wait forever on a cloud-minted person who is already there — and
 * that is precisely the bug that made an earlier probe report a bogus 785s
 * "landing" (it was really our own repair PATCH flipping the 500 to a 200).
 * Verified with a bogus id (63000000009999999 → 404), a null-DOB cloud mint
 * (→ 500), and the same person after a birthdate PATCH (→ 200).
 *
 * Reads only. Nothing here writes to any rail.
 */
import { fetchOfficePerson } from "@/lib/bmi-office-actions";

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";

export type BarrierVerdict = "open" | "closed" | "error";

export interface BarrierResult {
  verdict: BarrierVerdict;
  /** Short reason for the queue row's last_error / the cron log. */
  detail: string;
}

const open = (detail: string): BarrierResult => ({ verdict: "open", detail });
const closed = (detail: string): BarrierResult => ({ verdict: "closed", detail });
const errored = (detail: string): BarrierResult => ({ verdict: "error", detail });

/**
 * Is this person on the center's LOCAL server (Pandora-visible)?
 *
 * Opens on any status that is not 404 — see the 404-vs-500 rule in the header.
 * A 500 specifically means "present but the birthdate is null", which is exactly
 * the state a `repair-person-details` followup exists to fix, so that handler
 * MUST be allowed to run on a 500.
 */
export async function personLocalBarrier(
  locationId: string,
  personId: string,
): Promise<BarrierResult> {
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  if (!key) return errored("SWAGGER_ADMIN_KEY missing");
  try {
    const res = await fetch(
      `${PANDORA_BASE}/bmi/person/${encodeURIComponent(locationId)}/${encodeURIComponent(personId)}`,
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (res.status === 404) return closed("404 — not on the local server yet");
    if (res.status === 500) {
      // Present, unreadable. Distinguished in the detail so the log shows WHY a
      // repair row fired against an apparently-broken record.
      return open("500 Response Validator Error — present, birthdate null");
    }
    if (res.ok) return open("200 — present and readable");
    return errored(`HTTP ${res.status}`);
  } catch (err) {
    return errored(err instanceof Error ? err.message.slice(0, 120) : "network error");
  }
}

/**
 * Is this person visible on the vendor CLOUD (Office)?
 *
 * The mirror-image wait, for followups that write CLOUD-side against a person
 * that was born LOCAL — the local→cloud leg is the one that can jam for hours,
 * so this barrier is the reason we no longer fire a blind attach and record a
 * terminal failure (the 8/11 pattern).
 *
 * `fetchOfficePerson` swallows its own errors and returns null, so a vendor
 * outage is indistinguishable from "not synced" here. Both mean wait, and the
 * give-up deadline is what bounds it.
 */
export async function personCloudBarrier(
  personId: string,
  clientKey?: string,
): Promise<BarrierResult> {
  const person = await fetchOfficePerson(personId, clientKey);
  return person ? open("Office person resolves") : closed("Office person not visible yet");
}

/**
 * Is the WHOLE PARTY ready — every member visible on the center's local server
 * AND carrying a valid waiver?
 *
 * Owner 2026-08-12: the Confirmation → "Confirmation Kiosk"/"Confirmation -
 * Express" flip "should happen only when the rest of the party has sync'ed and
 * we have verified all have the waivers". Staff read that state as "this party
 * is here and checked in", so stamping it while a member was still invisible
 * locally or unwaivered made it a claim we could not back (lessons § "a status
 * field IS a claim"). Gating it here means the state arriving IS the signal that
 * the on-site work finished — the owner's words: "would show sync is done".
 *
 * ONE READ PER MEMBER answers both halves: Pandora's person record carries
 * `waiverExpiry`, so presence and waiver validity come from the same GET. Note
 * the asymmetry with `personLocalBarrier`: there a 500 counts as OPEN (present
 * but unreadable is exactly what the repair handler fixes), but here a 500 is
 * NOT good enough — an unreadable record cannot prove a waiver, and this gate
 * exists to prove one. So this barrier needs a real 200 for every member.
 *
 * Fails CLOSED on anything unclear (unreadable member, unparseable expiry, no
 * members supplied) — never stamp a state on a maybe.
 */
export async function partyReadyBarrier(
  locationId: string,
  personIds: string[],
): Promise<BarrierResult> {
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  if (!key) return errored("SWAGGER_ADMIN_KEY missing");
  const ids = [...new Set(personIds.filter(Boolean).map(String))];
  // No party to verify = nothing to claim. Closed, not open: an empty list is a
  // caller bug, and stamping on it would be the exact false claim this prevents.
  if (ids.length === 0) return closed("no party members to verify");

  const notLocal: string[] = [];
  const unreadable: string[] = [];
  const noWaiver: string[] = [];
  const now = Date.now();

  for (const id of ids) {
    try {
      const res = await fetch(
        `${PANDORA_BASE}/bmi/person/${encodeURIComponent(locationId)}/${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (res.status === 404) {
        notLocal.push(id);
        continue;
      }
      if (!res.ok) {
        // Includes the null-birthdate 500: present, but its waiver cannot be read.
        unreadable.push(id);
        continue;
      }
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        data?: { waiverExpiry?: string | null };
      } | null;
      if (body?.success !== true) {
        unreadable.push(id);
        continue;
      }
      const expiry = body.data?.waiverExpiry ? Date.parse(body.data.waiverExpiry) : NaN;
      if (!Number.isFinite(expiry) || expiry <= now) noWaiver.push(id);
    } catch {
      unreadable.push(id);
    }
  }

  if (notLocal.length === 0 && unreadable.length === 0 && noWaiver.length === 0) {
    return open(`all ${ids.length} member(s) local with a valid waiver`);
  }
  const bits: string[] = [];
  if (notLocal.length) bits.push(`${notLocal.length} not synced local`);
  if (unreadable.length) bits.push(`${unreadable.length} unreadable`);
  if (noWaiver.length) bits.push(`${noWaiver.length} without a valid waiver`);
  return closed(`${bits.join(", ")} of ${ids.length}`);
}

/**
 * Has the reservation/project synced DOWN to the center's local server?
 *
 * `GET /bmi/reservation/{locationID}/{reservationId}` is a GET with PATH params
 * (a POST with the ids in the body 404s on EVERY id, which reads exactly like
 * "nothing is onsite" and is worthless — see the BMI write-rails map).
 * reservationId here is the Office PROJECT id.
 *
 * Unlike the person probe, this one wants a real 200 + `success`: the local
 * roster/schedule work gated behind it needs the project actually readable, and
 * this endpoint has no known present-but-unreadable state.
 */
export async function projectLocalBarrier(
  locationId: string,
  reservationId: string,
): Promise<BarrierResult> {
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  if (!key) return errored("SWAGGER_ADMIN_KEY missing");
  try {
    const res = await fetch(
      `${PANDORA_BASE}/bmi/reservation/${encodeURIComponent(locationId)}/${encodeURIComponent(reservationId)}`,
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (res.status === 404) return closed("404 — project not synced down yet");
    if (!res.ok) return errored(`HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { success?: boolean } | null;
    return body?.success === true
      ? open("200 success — project is onsite")
      : closed("200 but success!=true");
  } catch (err) {
    return errored(err instanceof Error ? err.message.slice(0, 120) : "network error");
  }
}
