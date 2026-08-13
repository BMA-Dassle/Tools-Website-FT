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

/**
 * `impossible` is the verdict that says WAITING CANNOT HELP — the thing this
 * barrier waits for will never arrive, so the row must park now instead of
 * burning its give-up window. Distinct from `error` (transient, retry) and from
 * `closed` (not yet, wait patiently).
 *
 * Live case that forced it (2026-08-12): a `push-waiver-signature` row for
 * Nadine Poeter, person 63000000008163542, was aimed at Naples
 * (PPTR5G2N0QXF7) — but that person was minted at FORT MYERS and reads 200
 * there / 404 at Naples. A person id is only valid at its OWN center, so the
 * barrier would have sat closed until its 02:43 give-up, reporting "not on the
 * local server yet" as if sync were merely slow.
 */
export type BarrierVerdict = "open" | "closed" | "error" | "impossible";

export interface BarrierResult {
  verdict: BarrierVerdict;
  /** Short reason for the queue row's last_error / the cron log. */
  detail: string;
}

const open = (detail: string): BarrierResult => ({ verdict: "open", detail });
const closed = (detail: string): BarrierResult => ({ verdict: "closed", detail });
const errored = (detail: string): BarrierResult => ({ verdict: "error", detail });
const impossible = (detail: string): BarrierResult => ({ verdict: "impossible", detail });

/** Pandora locationIDs we can look a person up at, with names for the message. */
const KNOWN_LOCATIONS: Array<[string, string]> = [
  ["LAB52GY480CJF", "FastTrax"],
  ["TXBSQN0FEKQ11", "HeadPinz Fort Myers"],
  ["PPTR5G2N0QXF7", "HeadPinz Naples"],
];

/** Raw person probe: is this id readable at this location? (404 ⇒ absent.) */
async function personVisibleAt(locationId: string, personId: string, key: string) {
  try {
    const res = await fetch(
      `${PANDORA_BASE}/bmi/person/${encodeURIComponent(locationId)}/${encodeURIComponent(personId)}`,
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) },
    );
    // 500 counts as present — the record exists, its birthdate is just null.
    return res.status !== 404;
  } catch {
    return false; // unreachable ≠ "lives here"
  }
}

/**
 * Does this person live at a DIFFERENT center than the one we are waiting on?
 *
 * Only called once a person has 404'd at the target location. Finding them
 * elsewhere converts an open-ended wait into a diagnosis, because BMI person ids
 * do not cross centers: no amount of sync will make a Fort Myers person appear
 * at Naples.
 */
async function locateElsewhere(
  personId: string,
  excludeLocationId: string,
  key: string,
): Promise<string | null> {
  for (const [locationId, name] of KNOWN_LOCATIONS) {
    if (locationId === excludeLocationId) continue;
    if (await personVisibleAt(locationId, personId, key)) return name;
  }
  return null;
}

/**
 * Is this person on the center's LOCAL server (Pandora-visible)?
 *
 * Opens on any status that is not 404 — see the 404-vs-500 rule in the header.
 * A 500 specifically means "present but the birthdate is null", which is exactly
 * the state a `repair-person-details` followup exists to fix, so that handler
 * MUST be allowed to run on a 500.
 *
 * `diagnoseElsewhere` controls the cross-center search that turns a 404 into an
 * `impossible` verdict. It costs up to TWO extra Pandora GETs (15s timeout each),
 * so pay for it where its answer CHANGES a decision — a queue row deciding
 * whether to park, or a poll deciding whether to hand off — and nowhere else.
 * Every tick of a poll loop is nowhere else: at 2s intervals it tripled each
 * tick's true cost and was the bulk of the ~30s the kiosk sign path spent
 * staring at a spinner (2026-08-12). A poll should pass `false` on every probe
 * on the guest's critical path and diagnose ONCE, at the point it gives up
 * waiting — see the pre-sign wait in `app/api/pandora/waiver/route.ts`.
 */
export async function personLocalBarrier(
  locationId: string,
  personId: string,
  opts: { diagnoseElsewhere?: boolean } = {},
): Promise<BarrierResult> {
  const { diagnoseElsewhere = true } = opts;
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  if (!key) return errored("SWAGGER_ADMIN_KEY missing");
  try {
    const res = await fetch(
      `${PANDORA_BASE}/bmi/person/${encodeURIComponent(locationId)}/${encodeURIComponent(personId)}`,
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (res.status === 404) {
      // Absent HERE. Before settling in to wait, check whether this person is
      // simply at ANOTHER center — in which case waiting is futile, because a
      // person id never crosses centers.
      const elsewhere = diagnoseElsewhere ? await locateElsewhere(personId, locationId, key) : null;
      if (elsewhere) {
        return impossible(
          `person ${personId} does not exist at this center — they are at ${elsewhere}. ` +
            `BMI person ids do not cross centers, so this will never sync. ` +
            `FIX: re-run this followup against ${elsewhere}, or use this center's own ` +
            `record for the guest.`,
        );
      }
      return closed("404 — not on the local server yet");
    }
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
 * Are ALL of these people on the center's LOCAL server?
 *
 * Exists for the guardian-signed waiver. Pandora's waiver write names TWO
 * people — `personID` (whose waiver it is) and `sigPersonID` (who signed) — and
 * it needs BOTH resolvable locally. Barriering on the minor alone was a
 * half-check: a family arriving together has parent and child cloud-minted
 * seconds apart, so the minor can land locally while the guardian has not, and
 * the write then names a signer the local server cannot resolve.
 *
 * Deliberately NOT `party-ready`, which also demands a valid waiver per member.
 * That is the right gate for "is this party checked in" and the wrong one here:
 * this barrier guards the write that CREATES the waiver, so requiring one first
 * would never open.
 *
 * Verdict folding, strictest first — `impossible` beats `closed` beats `error`,
 * because a single person who can never appear makes the whole row futile no
 * matter how the others read.
 */
export async function personsLocalBarrier(
  locationId: string,
  personIds: string[],
  opts: { diagnoseElsewhere?: boolean } = {},
): Promise<BarrierResult> {
  const ids = [...new Set(personIds.filter(Boolean).map(String))];
  // An empty list is a caller bug. Closed, not open: waving a waiver write
  // through because nobody said who it was for is the failure this prevents.
  if (ids.length === 0) return closed("no personIds supplied");

  const results = await Promise.all(
    ids.map(async (id) => ({ id, r: await personLocalBarrier(locationId, id, opts) })),
  );

  const imp = results.find((x) => x.r.verdict === "impossible");
  if (imp) return impossible(`person ${imp.id}: ${imp.r.detail}`);

  const shut = results.filter((x) => x.r.verdict === "closed");
  if (shut.length > 0) {
    return closed(
      `${shut.length}/${ids.length} not local yet — ${shut.map((x) => x.id).join(", ")}`,
    );
  }

  const err = results.find((x) => x.r.verdict === "error");
  if (err) return errored(`person ${err.id}: ${err.r.detail}`);

  return open(`all ${ids.length} present locally`);
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
