/**
 * Handlers for the BMI sync queue — one per `SyncKind`.
 *
 * A handler runs ONLY after its row's barrier reported `open` (the cron enforces
 * that, not the handler), so a handler may assume the other side can see the
 * entity it is about to write to. Its contract is narrow:
 *
 *   { ok: true }                    → done, never runs again
 *   { ok: false, retry: true }      → try again later (transient / still not ready)
 *   { ok: false, retry: false }     → terminal; park it now rather than burn the
 *                                     budget on something that cannot succeed
 *
 * Handlers must NEVER throw — the cron treats a throw as retryable, which is the
 * safe default but loses the reason. Return the verdict instead.
 *
 * MONEY IS NOT HERE. Deposits/payments keep their own ledgers and their own
 * sweeps (`bmi-deposit-retry`, `bmi-project-payment-retry`) because their safety
 * rules — re-read the vendor ledger, post `min(collected − recorded, balance,
 * row)` — do not generalize. Those rails consume the shared BARRIERS instead
 * (see lib/bmi-sync-barriers.ts).
 */
import { patchBmiPersonBirthdate } from "@/lib/bmi-person-update";
import { fetchOfficePerson } from "@/lib/bmi-office-actions";
import { addMembership, registrationKindForLocation } from "@/lib/pandora-memberships";
import { registerProjectPersonServer } from "~/features/kiosk/waiver/bmi-attach";
import type { SyncKind, SyncQueueRow } from "@/lib/bmi-sync-queue";

export interface HandlerResult {
  ok: boolean;
  /** Only meaningful when ok === false. */
  retry?: boolean;
  detail: string;
}

const done = (detail: string): HandlerResult => ({ ok: true, detail });
const again = (detail: string): HandlerResult => ({ ok: false, retry: true, detail });
const dead = (detail: string): HandlerResult => ({ ok: false, retry: false, detail });

const str = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v);

/**
 * Write birthdate (+ email/phone when known) onto a CLOUD-MINTED person so
 * Pandora can read the record at all.
 *
 * This is the followup that makes the public-booking mint viable: those persons
 * land locally with a NULL birthdate and every Pandora read of them answers
 * **500 "Response Validator Error"** until this runs (measured 2026-08-12; one
 * PATCH flips it to a clean 200 in ~3s). It is a REPAIR, never a create —
 * `patchBmiPersonBirthdate` cannot mint, which is deliberate: the old
 * submitSetup path minted on an unresolvable id and gave one guest six records.
 *
 * Contact fields ride along because the cloud mint does not carry them all: a
 * public-booking-minted person echoes `phone` back but Pandora reads
 * `phoneNumber: null`, so phone/email need the same repair.
 * (An OFFICE-minted person already carries birthdate+email+phone and needs no
 * repair at all — this handler exists for the public-booking rail and for
 * legacy records.)
 */
async function repairPersonDetails(row: SyncQueueRow): Promise<HandlerResult> {
  const personId = str(row.payload.personId) ?? row.barrierRef;
  let birthdate = str(row.payload.birthdate);
  if (!personId) return dead("no personId in payload");

  /**
   * NO DOB IN THE PAYLOAD? ASK OFFICE BEFORE GIVING UP.
   *
   * The mint route enqueues this repair precisely BECAUSE it had no birthdate,
   * so parking on "nothing to repair with" made the row a guaranteed dead end
   * (live: Leland Frazier person …163540, parked 3h with an unactionable
   * message). Office may know a DOB we did not — staff may have typed one since,
   * or another rail supplied it — so read the record first.
   *
   * And when Office has none either, say something a HUMAN CAN ACT ON. A person
   * with no DOB is not a cosmetic gap: Pandora answers every read of them with
   * 500, so every waiver check reports "no waiver" and they cannot be scheduled.
   * That message names the fix (add a DOB in BMI Office) and the likely cause
   * (a duplicate record — the real one usually has the DOB).
   */
  if (!birthdate) {
    const office = await fetchOfficePerson(personId).catch(() => null);
    const officeDob = office && typeof office.birthDate === "string" ? office.birthDate : null;
    if (officeDob) {
      birthdate = officeDob.slice(0, 10);
    } else {
      return dead(
        `person ${personId} has NO date of birth in Office either — Pandora returns 500 for them, ` +
          `so every waiver check reads "no waiver" and they cannot be scheduled. ` +
          `FIX: add a birth date to this person in BMI Office. ` +
          `Often a DUPLICATE record — check for another with the same name/phone (that one usually has the DOB).`,
      );
    }
  }
  const res = await patchBmiPersonBirthdate(personId, birthdate, {
    locationKey: str(row.payload.locationKey) ?? undefined,
    firstName: str(row.payload.firstName) ?? undefined,
    lastName: str(row.payload.lastName) ?? undefined,
    email: str(row.payload.email) ?? undefined,
    phone: str(row.payload.phone) ?? undefined,
  });
  if (res.ok) return done(`birthdate repaired (HTTP ${res.status})`);
  // A malformed birthdate can never succeed; anything else may.
  if (res.error === "birthdate must be YYYY-MM-DD") return dead(res.error);
  return again(`${res.status ?? "err"}: ${res.error ?? "unknown"}`);
}

/**
 * Create the waiver RECORD on Pandora for an acceptance we already hold in Neon.
 *
 * Ordering note: our Neon row is written BEFORE any vendor call (house rule), so
 * this handler never carries the only copy — it is catching the vendor up, and
 * `waiverValid` is answered from Neon during the gap.
 *
 * `signWaiverDigital` wants `{personId, name}` (+ optional locationKey / dateEt /
 * pngBuffer of the drawn signature) and THROWS on `success:false` or a missing
 * waiverID — the 2026-06-18 silent-loss fix — so a throw here is a real
 * non-write and correctly retryable. `skipIfValid` is deliberately ON: by the
 * time this runs the guest may already have been given a waiver another way,
 * and re-pushing would shorten a longer existing expiry.
 *
 * The PNG rides as base64 in the payload (the queue is JSONB) and is rehydrated
 * to a Buffer here. Dynamic import keeps this module's template cache out of the
 * cron's cold path when no waiver rows are due.
 *
 * `waiverContentId` / `invalidationDate` ride along too, and MUST be forwarded.
 * `signWaiverDigital` was built for the event digital-accept path, so its own
 * defaults are an age-35 (ADULT) template lookup and a 5-day expiry — right for
 * an event, wrong for a kiosk guest. Before those fields were carried (added
 * 2026-08-12 with the 5s sign wait), a queued MINOR's waiver was filed against
 * the adult contentID nobody had read, expiring in 5 days instead of the
 * template's year. A row enqueued before that change has neither field; the
 * fallback stays for those, which is why this forwards rather than requires.
 */
async function pushWaiverSignature(row: SyncQueueRow): Promise<HandlerResult> {
  const personId = str(row.payload.personId) ?? row.barrierRef;
  const name = str(row.payload.name);
  if (!personId) return dead("no personId in payload");
  if (!name) return dead("no name in payload — signWaiverDigital requires it");
  const pngB64 = str(row.payload.signaturePngB64);
  try {
    const { signWaiverDigital } = await import("@/lib/waiver-digital");
    const out = await signWaiverDigital({
      personId,
      name,
      locationKey: str(row.payload.locationKey),
      dateEt: str(row.payload.dateEt) ?? undefined,
      pngBuffer: pngB64 ? Buffer.from(pngB64, "base64") : undefined,
      waiverContentID: str(row.payload.waiverContentId) ?? undefined,
      invalidationDate: str(row.payload.invalidationDate) ?? undefined,
      skipIfValid: true,
    });
    if (out.skipped) return done("already had a valid waiver — skipped");
    return out.waiverID ? done(`waiver ${out.waiverID}`) : again("no waiverID returned");
  } catch (err) {
    return again(err instanceof Error ? err.message.slice(0, 200) : "sign failed");
  }
}

/**
 * Grant the DEFAULT REGISTRATION membership on Pandora — "Customer Registration"
 * (479317), never the licence.
 *
 * Owner correction 2026-08-12: "We need to use default registration for everyone,
 * not license. License is taken care of with the BMI product." That distinction
 * is the whole point of this handler:
 *   - The LICENCE (`License Fee`, 11260957) is bought as a BMI product. Granting
 *     it here would hand a paid entitlement to someone who may not have paid, and
 *     `race-pack-license.server.ts` already owns that money path with its own
 *     obligation ledger.
 *   - `Qualified Intermediate`/`Pro`/`Junior *` are EARNED on track by lap time
 *     (the timing system writes them) — never granted by us either.
 *   - What every guest legitimately needs is the registration record, which is
 *     what this writes.
 * A caller may still name an explicit `membershipKindId`, but the DEFAULT here is
 * deliberately the registration kind, so forgetting to pass one cannot silently
 * hand out licences.
 *
 * NOT money: this writes a membership row, it does not move a balance.
 */
async function addMembershipHandler(row: SyncQueueRow): Promise<HandlerResult> {
  const personId = str(row.payload.personId) ?? row.barrierRef;
  if (!personId) return dead("no personId in payload");
  const purchaseRef = str(row.payload.purchaseRef);

  // Membership kinds are CLIENT-KEY SCOPED — resolve the id for THIS center.
  // An unknown location yields null rather than Fort Myers' id, because sending
  // one center's kind id to another is a guaranteed refusal, not weather.
  const kindId = str(row.payload.membershipKindId) ?? registrationKindForLocation(row.locationId);
  if (!kindId) {
    return dead(
      `no registration membership kind configured for location ${row.locationId ?? "(none)"} — ` +
        `membership kinds are per-BMI-client-key. FIX: read the center's "Customer Registration" ` +
        `id from Office /api/{clientKey}/metadata and add it to ` +
        `REGISTRATION_MEMBERSHIP_KIND_BY_LOCATION (or set the env override).`,
    );
  }

  try {
    const id = await addMembership({
      personId,
      locationId: row.locationId ?? undefined,
      // Explicit: the REGISTRATION kind for this center. Never fall through to
      // addMembership's own default, which is the licence.
      membershipKindId: kindId,
      // Omitted → now + 1 year (Pandora does NOT default `expires`).
      expires: str(row.payload.expires) ?? undefined,
      activates: str(row.payload.activates) ?? undefined,
    } as Parameters<typeof addMembership>[0]);
    return done(`membership ${id}${purchaseRef ? ` for purchase ${purchaseRef}` : ""}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "addMembership failed";
    // A missing kind id is configuration, not weather — retrying cannot fix it.
    if (/membership-kind id not set/i.test(msg)) return dead(msg.slice(0, 200));
    // Pandora rejecting the KIND is also configuration: the id does not exist in
    // this center's catalogue, so every retry refuses identically. Park it with
    // the id we actually sent so the fix is one lookup, not an investigation.
    if (/no membership found with that id/i.test(msg)) {
      return dead(
        `Pandora refused membership kind ${kindId} at location ${row.locationId ?? "(none)"} — ` +
          `that kind does not exist in this center's catalogue (kinds are per-client-key). ` +
          `FIX: correct REGISTRATION_MEMBERSHIP_KIND_BY_LOCATION for this center.`,
      );
    }
    return again(msg.slice(0, 200));
  }
}

/**
 * Attach a person to an order as a projectPerson (public-booking, CLOUD).
 *
 * Gated on `person-cloud` by its enqueuer: a person born LOCAL reaches the cloud
 * only over the local→cloud leg that can jam for hours, and firing a blind
 * attach then recording a terminal failure is exactly the 8/11 pattern that had
 * staff hand-seating racers.
 *
 * TRAPS honored by `registerProjectPersonServer` itself: HTTP 200 with
 * `{"success":false}` is a REFUSAL, and `orderId` is a BILL id (never an Office
 * projectId).
 */
async function attachProjectPerson(row: SyncQueueRow): Promise<HandlerResult> {
  const personId = str(row.payload.personId) ?? row.barrierRef;
  const orderId = str(row.payload.orderId);
  const clientKey = str(row.payload.clientKey);
  if (!personId) return dead("no personId in payload");
  if (!orderId) return dead("no orderId (bill id) in payload");
  if (!clientKey) return dead("no clientKey in payload");
  try {
    const res = await registerProjectPersonServer({
      clientKey,
      orderId,
      personId,
      firstName: str(row.payload.firstName) ?? "Guest",
      lastName: str(row.payload.lastName) ?? "",
    });
    if (res.ok) return done(`attached (HTTP ${res.status})`);
    // A declared refusal on a person the cloud CAN see is not sync lag — but the
    // reservation itself may still be settling, so keep it retryable and let the
    // give-up deadline end it rather than guessing which refusal is permanent.
    return again(`refused ${res.status}: ${res.body.slice(0, 160)}`);
  } catch (err) {
    return again(err instanceof Error ? err.message.slice(0, 200) : "attach failed");
  }
}

/**
 * Stamp the BMI project's kiosk / express confirmation state — reached ONLY
 * after the `party-ready` barrier proved every member is local AND waivered
 * (owner 2026-08-12).
 *
 * That gate is the whole point: staff read "Confirmation Kiosk" as "this party
 * is here and checked in", and it used to be stamped unconditionally at
 * check-in, which made it a claim about work that had not finished. Now the
 * state's ARRIVAL is the signal that the on-site sync completed — the owner's
 * words, "would show sync is done".
 *
 * VIP wins over kiosk wherever they collide (owner 2026-08-02), so a combo
 * reservation routes through `stampVipStateIfCombo`, which does its own
 * read-then-compare against the claimable states before writing.
 *
 * `ensureAttempts` matters here: by the time this runs, other writers (the
 * reserve flow's inline `-3`, race-confirm-reconcile) may still be propagating
 * through Pandora and can clobber a custom state that landed first — the
 * documented 2026-07-22 race. The re-assert window is the guard.
 */
async function stampConfirmationState(row: SyncQueueRow): Promise<HandlerResult> {
  const projectId = str(row.payload.officeProjectId) ?? row.barrierRef;
  const centerCode = str(row.payload.centerCode) ?? "fasttrax";
  const stateId = str(row.payload.stateId);
  const label = str(row.payload.label) ?? "Confirmation Kiosk (sync-gated)";
  const comboSpecialId = str(row.payload.comboSpecialId);
  if (!projectId) return dead("no officeProjectId in payload");
  try {
    if (comboSpecialId) {
      const { stampVipStateIfCombo } = await import("~/features/combos/vip-state.server");
      const result = await stampVipStateIfCombo({
        comboSpecialId,
        centerCode,
        officeProjectId: projectId,
        tag: "sync-queue",
        label: "Confirmation - VIP (sync-gated)",
        ensureAttempts: 3,
      });
      if (result.outcome === "stamped" || result.outcome === "already") {
        return done(`VIP state ${result.outcome}`);
      }
      // `left-alone` means the project holds a state we must not claim over —
      // terminal, because retrying cannot change another writer's decision.
      if (result.outcome === "left-alone") return dead("project holds a non-claimable state");
      return again(`VIP stamp ${result.outcome}`);
    }
    if (!stateId) return dead("no stateId in payload (and not a VIP combo)");
    const { setProjectState } = await import("@/lib/bmi-office-actions");
    await setProjectState({
      centerCode,
      projectId,
      stateId,
      label,
      // Out-wait a late cross-rail `-3` that would revert the custom state.
      ensureAttempts: 3,
    });
    return done(`state ${stateId} stamped`);
  } catch (err) {
    return again(err instanceof Error ? err.message.slice(0, 200) : "state stamp failed");
  }
}

export const SYNC_HANDLERS: Record<SyncKind, (row: SyncQueueRow) => Promise<HandlerResult>> = {
  "repair-person-details": repairPersonDetails,
  "push-waiver-signature": pushWaiverSignature,
  "add-membership": addMembershipHandler,
  "attach-project-person": attachProjectPerson,
  "stamp-confirmation-state": stampConfirmationState,
};
