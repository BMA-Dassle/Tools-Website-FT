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
import { addMembership } from "@/lib/pandora-memberships";
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
  const birthdate = str(row.payload.birthdate);
  if (!personId) return dead("no personId in payload");
  if (!birthdate) return dead("no birthdate in payload — nothing to repair with");
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
      skipIfValid: true,
    });
    if (out.skipped) return done("already had a valid waiver — skipped");
    return out.waiverID ? done(`waiver ${out.waiverID}`) : again("no waiverID returned");
  } catch (err) {
    return again(err instanceof Error ? err.message.slice(0, 200) : "sign failed");
  }
}

/**
 * Grant a membership on Pandora — in practice, the LICENCE the guest bought.
 *
 * Owner 2026-08-12: "if they bought a license can we give them that instead of
 * the default membership". Worth stating plainly because the naming used to
 * imply otherwise: **there is no generic "default" membership.**
 * `LICENSE_MEMBERSHIP_KIND_ID` (the FastTrax "License Fee", Firebird kind
 * 11260957) is the only kind wired, and `addMembership` already defaults to it —
 * so a row of this kind has always meant "grant the racing licence". The payload
 * may still name a different `membershipKindId` explicitly if one is ever added,
 * and `purchaseRef` records WHICH purchase justified the grant so an entitlement
 * is always traceable to the money that bought it.
 *
 * NOT money itself: this writes a membership row, it does not move a balance.
 * The $4.99 licence CHARGE stays on the Square rail with its own obligation
 * ledger (`race_license_grants`); this records the entitlement once the person
 * is locally visible.
 */
async function addMembershipHandler(row: SyncQueueRow): Promise<HandlerResult> {
  const personId = str(row.payload.personId) ?? row.barrierRef;
  if (!personId) return dead("no personId in payload");
  const purchaseRef = str(row.payload.purchaseRef);
  try {
    const id = await addMembership({
      personId,
      locationId: row.locationId ?? undefined,
      // Omitted → LICENSE_MEMBERSHIP_KIND_ID, i.e. the racing licence.
      membershipKindId: str(row.payload.membershipKindId) ?? undefined,
      // Omitted → now + 1 year (Pandora does NOT default `expires`).
      expires: str(row.payload.expires) ?? undefined,
      activates: str(row.payload.activates) ?? undefined,
    } as Parameters<typeof addMembership>[0]);
    return done(`membership ${id}${purchaseRef ? ` for purchase ${purchaseRef}` : ""}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "addMembership failed";
    // A missing kind id is configuration, not weather — retrying cannot fix it.
    if (/membership-kind id not set/i.test(msg)) return dead(msg.slice(0, 200));
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

export const SYNC_HANDLERS: Record<SyncKind, (row: SyncQueueRow) => Promise<HandlerResult>> = {
  "repair-person-details": repairPersonDetails,
  "push-waiver-signature": pushWaiverSignature,
  "add-membership": addMembershipHandler,
  "attach-project-person": attachProjectPerson,
};
