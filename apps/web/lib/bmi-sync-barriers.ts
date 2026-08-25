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
import { fetchOfficePerson, fetchProjectRawIds } from "@/lib/bmi-office-actions";

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
  /**
   * Set on an `error` verdict when we never got an answer at all — the vendor
   * timed out, refused the connection, or the network failed.
   *
   * This is the difference between "BMI told us something we cannot act on"
   * and "BMI is down". Only the first says anything about the ROW; the second
   * says something about the DAY, and must not spend the row's patience.
   * See the consumer for why that distinction decides guest data.
   */
  unreachable?: boolean;
}

const open = (detail: string): BarrierResult => ({ verdict: "open", detail });
const closed = (detail: string): BarrierResult => ({ verdict: "closed", detail });
const errored = (detail: string, unreachable = false): BarrierResult => ({
  verdict: "error",
  detail,
  unreachable,
});
/** We never reached the vendor — indistinguishable from "not yet", so treated as such. */
const unreachable = (detail: string): BarrierResult => errored(detail, true);
const impossible = (detail: string): BarrierResult => ({ verdict: "impossible", detail });

/**
 * Distinct BMI LOCAL SERVERS — deliberately NOT a flat list of Pandora location ids.
 *
 * FastTrax (LAB52GY480CJF) and HeadPinz Fort Myers (TXBSQN0FEKQ11) are two
 * location ids on ONE server. Probed across 61 person ids on 2026-08-15 they
 * answered identically every single time — same name, same birthdate, same
 * waiverExpiry — including a null-birthdate 500 and a bogus control id. Naples is
 * a real second server. (`scripts/syncboard-0815-ft-vs-hpfm-twin.mts`.)
 *
 * Listing those two separately is what made `locateElsewhere` unsound: for a
 * FastTrax-aimed row it re-asked THE SAME SERVER under the Fort Myers label, so a
 * single transient 404 came back as "they are at HeadPinz Fort Myers" — an
 * `impossible` verdict, which is terminal. For that pair the check could not
 * produce a true positive, only false ones. On 2026-08-15 it parked all five
 * `add-membership` rows at attempts=0 (racing licences bought and never granted)
 * and settled waiver pushes `failed` for guests sitting right there at FastTrax.
 *
 * So the unit here is the SERVER: one probe each, and the server that just
 * answered 404 is never re-probed under another of its names.
 */
const KNOWN_SERVERS: ReadonlyArray<{
  /** The id used to probe this server — any of its `locationIds` would do. */
  probeLocationId: string;
  /** Every Pandora location id this one server answers to. */
  locationIds: readonly string[];
  /** What to call it in a message a human has to act on. */
  name: string;
}> = [
  {
    probeLocationId: "LAB52GY480CJF",
    locationIds: ["LAB52GY480CJF", "TXBSQN0FEKQ11"],
    name: "the Fort Myers server (FastTrax / HeadPinz Fort Myers)",
  },
  {
    probeLocationId: "PPTR5G2N0QXF7",
    locationIds: ["PPTR5G2N0QXF7"],
    name: "HeadPinz Naples",
  },
];

/**
 * The HTTP status this person id answers with at this location — or `null` when
 * we never got an answer at all.
 *
 * `null` is NOT "absent", and the two must not collapse into one boolean: that is
 * how a network blip turns into a claim about a guest. Callers decide what an
 * unanswered probe means for them.
 */
async function personStatusAt(
  locationId: string,
  personId: string,
  key: string,
): Promise<number | null> {
  try {
    // `picture=false` IS THE DEFAULT FLIPPED: Pandora's person GET defaults to
    // picture=TRUE (docs/pandora-api.md), so every probe here was hauling a
    // 15-80KB base64 portrait it never looked at — on every retry of every
    // queued row, which is exactly the "waiver lookup is crazy" load the vendor
    // reported during the 2026-08-14 slowdown. Same flags every other person
    // GET in this codebase already sends.
    const res = await fetch(
      `${PANDORA_BASE}/bmi/person/${encodeURIComponent(locationId)}/${encodeURIComponent(personId)}?picture=false&allRelated=false`,
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) },
    );
    return res.status;
  } catch {
    return null; // unreachable ≠ absent
  }
}

/** Is this id readable at this location? (404 ⇒ absent; unreachable ⇒ no claim.) */
async function personVisibleAt(locationId: string, personId: string, key: string) {
  const status = await personStatusAt(locationId, personId, key);
  // 500 counts as present — the record exists, its birthdate is just null.
  return status !== null && status !== 404;
}

/**
 * Does this person live on a DIFFERENT SERVER than the one we are waiting on?
 *
 * Only called once a person has 404'd at the target location. Finding them
 * elsewhere converts an open-ended wait into a diagnosis, because BMI person ids
 * do not cross servers: no amount of sync will make a Fort Myers person appear
 * at Naples.
 */
async function locateElsewhere(
  personId: string,
  excludeLocationId: string,
  key: string,
): Promise<string | null> {
  for (const server of KNOWN_SERVERS) {
    // Never re-probe the server that just 404'd, whatever else it answers to.
    // The absence of this guard is the whole bug described above.
    if (server.locationIds.includes(excludeLocationId)) continue;
    if (await personVisibleAt(server.probeLocationId, personId, key)) return server.name;
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
    // `picture=false&allRelated=false` — see personVisibleAt. This is the read
    // the waiver-push queue retries; it needs a status code and nothing else.
    const res = await fetch(
      `${PANDORA_BASE}/bmi/person/${encodeURIComponent(locationId)}/${encodeURIComponent(personId)}?picture=false&allRelated=false`,
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (res.status === 404) {
      // Absent HERE. Before settling in to wait, check whether this person is
      // simply at ANOTHER center — in which case waiting is futile, because a
      // person id never crosses centers.
      const elsewhere = diagnoseElsewhere ? await locateElsewhere(personId, locationId, key) : null;
      if (elsewhere) {
        // RE-CONFIRM BEFORE A TERMINAL VERDICT. `impossible` parks a row for a
        // human and settles a waiver `failed`, so it must never rest on a single
        // GET. Pandora hands out transient 404s — out-waiting them is the entire
        // reason this queue exists — and the probes above have just bought the
        // sync several more seconds, so this re-read is nearly free.
        const recheck = await personStatusAt(locationId, personId, key);
        if (recheck === null) {
          // We asked again and got nothing. That is a statement about the vendor,
          // not about this guest, so it must not spend the row's patience.
          return unreachable("no answer on the re-read before parking");
        }
        if (recheck !== 404) {
          return open(`present on re-read (HTTP ${recheck}) — the first 404 was transient`);
        }
        return impossible(
          `person ${personId} does not exist at this center — their record is at ${elsewhere}. ` +
            `BMI person ids do not cross servers, so this will never sync. ` +
            `FIX: the guest needs a record at THIS center. Filing against ${elsewhere} ` +
            `would land the work where the guest is not.`,
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
    // A status we cannot interpret IS an answer about this person, so it counts
    // against the row. 502/503/504 are the vendor being unwell rather than an
    // answer, and are treated like a timeout.
    if (res.status >= 502 && res.status <= 504) {
      return unreachable(`HTTP ${res.status} — vendor unavailable`);
    }
    return errored(`HTTP ${res.status}`);
  } catch (err) {
    // Timeout, connection refused, DNS, TLS — we never got an answer, so we
    // learned nothing about this person. Must not spend the row's patience.
    return unreachable(err instanceof Error ? err.message.slice(0, 120) : "network error");
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
  // Carry `unreachable` through the aggregate. Flattening it here would put the
  // party barrier — the one guarding guardian-signed waivers — straight back to
  // spending a row's patience on a vendor outage.
  if (err) return errored(`person ${err.id}: ${err.r.detail}`, err.r.unreachable === true);

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
      // `picture=false&allRelated=false` — see personVisibleAt. This caller reads
      // waiverExpiry out of the body, so dropping the portrait shrinks the very
      // payload it has to wait for.
      const res = await fetch(
        `${PANDORA_BASE}/bmi/person/${encodeURIComponent(locationId)}/${encodeURIComponent(id)}?picture=false&allRelated=false`,
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

/**
 * WHO IS STILL ON THE RESERVATION, ACCORDING TO THE CLOUD?
 *
 * Not an arrival probe — the only one here that asks whether something has GONE.
 * Every other barrier in this file waits for a thing to appear and treats
 * absence as "not yet"; this one exists because a roster row that DISAPPEARS is
 * the thing that jams the upload rail.
 *
 * WHY IT MUST BE THE CLOUD (2026-08-16, T_PARTICIPANT 58922217). Pandora's
 * `/bmi/schedule` ALREADY guards this — its own source calls
 * `getProjectPersonId(centerIP, prjId, racer.personId)` and, when that misses,
 * skips the racer with `person_not_on_project` rather than inserting. But
 * `centerIP` says which copy it asks: the CENTER'S LOCAL project-person table.
 * When a project-person is deleted cloud-side there is a window before that
 * delete syncs down in which the local row is stale-PRESENT — so Pandora's
 * lookup SUCCEEDS, it stamps that id into a brand-new T_PARTICIPANT, and the
 * delete lands moments later. The participant is orphaned, its queued
 * W_PARTICIPANT upload violates FK_PAR_PRJP_ID, and Fast WSync's upload batch
 * wedges for the whole center until someone edits Firebird by hand.
 *
 * So this is not a second copy of Pandora's check — it is the same check against
 * the copy that is not stale. The cloud is where the delete lands first, which
 * is the owner's "cloud is first, Pandora second" rule applied to a read we had
 * delegated to Pandora entirely.
 *
 * KNOWN FALSE-POSITIVE, accepted deliberately: a person added to the project at
 * the DESK exists locally before the cloud has them, and if the upload rail is
 * itself wedged that can persist. Such a racer reads as "off roster" here and is
 * held back. That is survivable only because held racers are classified WAITING
 * (retryable, re-driven by the sweep, never dropped) — see the caller. A guard
 * that FAILED them would be worse than the jam it prevents.
 *
 * COLLECT IDS LIBERALLY. A roster row may carry the person under a 17-digit
 * Office id, a short local id, or both, and callers match on whichever id they
 * hold. A superset only ever makes the guard more permissive, and permissive is
 * the safe direction: a false "still on the roster" costs us the pre-existing
 * behaviour, while a false "removed" would strand a real racer.
 *
 * An EMPTY roster is returned as `open` with an empty set, not as an error —
 * projectPersons: 0 on a reservation that still shows persons: N is precisely
 * the emptied-roster state W61030 was in, and callers must be able to see it.
 */
export interface RosterBarrierResult extends BarrierResult {
  /**
   * Every id form the cloud roster carries. Trustworthy ONLY on `open` — on any
   * other verdict this is empty because we could not read, which must never be
   * mistaken for "nobody is on the reservation".
   */
  personIds: ReadonlySet<string>;
}

export async function projectRosterCloudBarrier(
  clientKey: string,
  projectId: string,
): Promise<RosterBarrierResult> {
  const none: ReadonlySet<string> = new Set<string>();
  let project: Record<string, unknown> | null;
  try {
    project = await fetchProjectRawIds(clientKey, projectId);
  } catch (err) {
    return {
      ...unreachable(err instanceof Error ? err.message.slice(0, 120) : "office unreachable"),
      personIds: none,
    };
  }
  // null = the Office GET was >=400. Not "the roster is empty" — we never read it.
  if (!project) return { ...closed("project not readable in the cloud"), personIds: none };

  const rows = Array.isArray(project.projectPersons)
    ? (project.projectPersons as Array<Record<string, unknown>>)
    : null;
  // The GET is expected to carry projectPersons (removeProjectPersonRow reads it
  // from the same body). Its ABSENCE is a shape change, not an empty roster.
  if (!rows) return { ...errored("project carries no projectPersons array"), personIds: none };

  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const [k, v] of Object.entries(row)) {
      if (!/^(person.*id|externalid)$/i.test(k)) continue;
      if (typeof v !== "string" && typeof v !== "number") continue;
      const s = String(v).trim();
      if (s && s !== "0" && s !== "null") ids.add(s);
    }
  }
  return {
    ...open(`${ids.size} id(s) across ${rows.length} roster row(s)`),
    personIds: ids,
  };
}

/**
 * IS THE PARTY ACTUALLY ON THE GRID? — party-ready, plus every seat proven.
 *
 * The "Confirmation Kiosk / Confirmation - Express" stamp is read by staff as
 * "this party is here and checked in". `party-ready` alone only proves each
 * member is local and waivered, which is true well before anyone is seated, so
 * the stamp could still arrive claiming work that had not finished. This adds
 * the seats.
 *
 * WE ASK THE GRID, NOT OURSELVES. `kiosk_checkin_people.schedule_status` is the
 * obvious source and the wrong one: server.ts already warns it "goes stale the
 * moment staff" hand-seat a racer at the desk, so a party seated by hand would
 * sit at 'waiting-sync' forever and the flip would never arrive — turning a
 * gate into a permanent block. Pandora's session participants show a hand-seated
 * racer exactly like an API-seated one.
 *
 * `race/next` was evaluated for this and REJECTED — probed live 2026-08-16, it
 * 404s "No upcoming race found" for a racer demonstrably seated earlier the same
 * day (it only looks forward) while returning a 2023 session as "upcoming" for
 * another. It answers a different question than the one this barrier asks.
 *
 * Seats are matched on (local wall-clock start, personId). Pandora's
 * `scheduledStart` is real UTC and our heat ids are naive center-local, so the
 * comparison is normalized to a New York wall-clock key — never on raw strings
 * (the trap documented in scripts/bmi-cloud-vs-local-sync-diff.mts).
 */
export interface SeatRef {
  personId: string;
  /** Naive center-local heat start, as stored in bound_heats ("2026-08-16T12:02:00"). */
  heatStart: string;
}

/** A UTC instant as the naive center-local key the seat side speaks
 *  (`YYYY-MM-DDTHH:MM`). Exported so the probe can convert a row's
 *  `created_at` — which is UTC — into the same vocabulary. */
export const nyWallClockKey = (utcIso: string): string =>
  new Date(utcIso)
    .toLocaleString("sv-SE", { timeZone: "America/New_York" })
    .replace(" ", "T")
    .slice(0, 16);

/**
 * Sessions that are not a KART HEAT. A racer sitting in Nexus Laser Tag is not
 * seated for their race, and both attractions live on the same BMI server (and
 * therefore the same day list) as the FastTrax track — so once this gate stopped
 * demanding an exact heat time, an arena booking could otherwise have satisfied
 * a race seat. Matched on the session's `type`, the same field
 * /api/pandora/sessions discriminates on.
 */
const NON_RACE_SESSION = /laser|gel blaster|arena/i;

export async function partySeatedBarrier(
  locationId: string,
  personIds: string[],
  seats: SeatRef[],
  /**
   * When the party checked in, as a naive-ET `YYYY-MM-DDTHH:MM` key. Seats are
   * accepted on any race session from this moment on — see the note in the body.
   * Absent (an older row) keeps the original exact-heat behaviour.
   */
  checkedInAtNyKey?: string | null,
): Promise<BarrierResult> {
  // The waiver/local half is unchanged — a party that isn't ready can't be
  // seated-and-done either, and this keeps one gate rather than two.
  const ready = await partyReadyBarrier(locationId, personIds);
  if (ready.verdict !== "open") return ready;

  const wanted = seats.filter((s) => s.personId && s.heatStart);
  // No racing seats in this check-in (bowling-only, or a party whose members are
  // deliberately not racing) — party-ready IS the whole gate.
  if (wanted.length === 0) return open(`${ready.detail}; no racing seats to verify`);

  const key = process.env.SWAGGER_ADMIN_KEY || "";
  if (!key) return errored("SWAGGER_ADMIN_KEY missing");

  // One sessions read per distinct DAY the seats fall on (a check-in's heats are
  // same-day in practice, so this is one call).
  const days = [...new Set(wanted.map((s) => s.heatStart.slice(0, 10)))];
  const sessionsByStart = new Map<string, string[]>();
  for (const day of days) {
    try {
      const res = await fetch(
        `${PANDORA_BASE}/bmi/sessions/${encodeURIComponent(locationId)}?startDate=${day}T00:00:00&endDate=${day}T23:59:59`,
        { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) },
      );
      if (!res.ok) return unreachable(`sessions ${day} → HTTP ${res.status}`);
      const body = (await res.json().catch(() => null)) as {
        data?: Array<{ sessionId?: unknown; scheduledStart?: unknown; type?: unknown }>;
      } | null;
      for (const s of body?.data ?? []) {
        if (!s?.sessionId || typeof s.scheduledStart !== "string") continue;
        // Laser tag / gel blaster share this location's day list; being in one is
        // not being on the grid. Only matters now the gate looks day-wide.
        if (typeof s.type === "string" && NON_RACE_SESSION.test(s.type)) continue;
        // Two tracks can run a heat on the same minute, so a start key maps to a
        // LIST of sessions and a racer counts if they are on any of them.
        const k = nyWallClockKey(s.scheduledStart);
        sessionsByStart.set(k, [...(sessionsByStart.get(k) ?? []), String(s.sessionId)]);
      }
    } catch (err) {
      return unreachable(err instanceof Error ? err.message.slice(0, 120) : "sessions unreachable");
    }
  }

  const rosterCache = new Map<string, Set<string>>();
  const participantsOf = async (sessionId: string): Promise<Set<string> | null> => {
    const hit = rosterCache.get(sessionId);
    if (hit) return hit;
    try {
      const res = await fetch(
        `${PANDORA_BASE}/bmi/session/${encodeURIComponent(locationId)}/${encodeURIComponent(sessionId)}/participants?excludeRemoved=true`,
        { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) },
      );
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as {
        data?: Array<Record<string, unknown>>;
      } | null;
      const ids = new Set<string>();
      for (const p of body?.data ?? []) {
        for (const k of ["personId", "personID", "participantId"]) {
          const v = p?.[k];
          if (typeof v === "string" || typeof v === "number") ids.add(String(v));
        }
      }
      rosterCache.set(sessionId, ids);
      return ids;
    } catch {
      return null;
    }
  };

  /**
   * ON THE GRID, NOT ON THIS EXACT HEAT (2026-08-24).
   *
   * This gate used to demand each racer appear on the precise heat the kiosk
   * bound them to. Staff move parties between heats constantly — a group runs
   * late, a track goes down, someone asks for the next one — and the moment a
   * racer is reseated, a check-in that went perfectly can never satisfy the
   * gate. It waits out its 8 hours and parks as a work order for a human.
   *
   * Measured since the gate shipped on 2026-08-16: 16 of 57 stamp rows parked
   * this way — more than one check-in in four. Of the 48
   * seats they called "not on the grid", 38 raced a DIFFERENT heat that day and
   * the other 10 raced under a different person record. Not one was a party that
   * failed to show. A gate that is wrong a third of the time teaches staff to
   * ignore the board, which costs more than the gate ever bought.
   *
   * So the question becomes the one staff actually mean: is this racer on the
   * grid today, at or after the moment they checked in? The exact-heat key is
   * still tried FIRST — it is the common case and it is one roster read — and
   * the day is only scanned when that misses. Everything needed for the scan was
   * already fetched: the sessions call has always been day-wide.
   *
   * Earlier heats are excluded because a racer who ran at noon and checked in at
   * 6pm for an evening booking is not seated for the evening one.
   */
  const cutoff = checkedInAtNyKey ?? null;
  const laterKeys = [...sessionsByStart.keys()]
    .filter((k) => !cutoff || k >= cutoff)
    .sort((a, b) => a.localeCompare(b));

  const missing: string[] = [];
  for (const seat of wanted) {
    const exactKey = seat.heatStart.slice(0, 16);
    const exact = sessionsByStart.get(exactKey) ?? [];
    // Fast path first: the heat we booked them on, if it is down here at all.
    const candidates = [
      ...exact,
      ...laterKeys.flatMap((k) => (k === exactKey ? [] : (sessionsByStart.get(k) ?? []))),
    ];

    if (candidates.length === 0) {
      // Not one race session on this whole day has reached the local server —
      // the same "not yet" every other barrier means by closed.
      missing.push(`${seat.personId}@${seat.heatStart.slice(11, 16)} (no local session)`);
      continue;
    }
    let seated = false;
    for (const sid of candidates) {
      const ids = await participantsOf(sid);
      if (ids === null) return unreachable(`participants ${sid} unreadable`);
      if (ids.has(seat.personId)) {
        seated = true;
        break;
      }
    }
    if (!seated) missing.push(`${seat.personId}@${seat.heatStart.slice(11, 16)}`);
  }

  return missing.length === 0
    ? open(`${ready.detail}; all ${wanted.length} racer-heat(s) on the grid`)
    : closed(
        `${missing.length}/${wanted.length} racer(s) not on the grid: ${missing.slice(0, 4).join(", ")}`,
      );
}
