/**
 * FastTrax-license rail for race-pack purchases (server only).
 *
 * WHY: the standalone race-pack flows (kiosk attract screen + web /book/race-packs)
 * only grant CREDITS (Pandora addDeposit). They book no heat and touch no BMI bill,
 * so a NEW racer never gets the FastTrax **License** that racing actually requires —
 * they buy a pack, show up, and get sent back to the counter. This module adds the
 * license to the same purchase and REGISTERS it on the racer's BMI account.
 *
 * Two pieces:
 *   personNeedsLicense()      — the authoritative "who owes $4.99" gate. Reads the
 *                               BMI Office person and returns false when an ACTIVE
 *                               "License Fee" membership is already on file (never
 *                               double-charge a licensed racer). Falls back to the
 *                               client's new-racer hint only when the record can't
 *                               be read (a brand-new person whose Office record still
 *                               lags the Pandora create).
 *   registerStandaloneLicense() — writes the "License Fee" membership straight into
 *                               Firebird via Pandora `addMembership` (POST
 *                               /v2/bmi/membership). NO BMI bill: the BMI booking/sell
 *                               → payment/confirm path was proven to leave an unpaid
 *                               bill and attach NO membership, and GET /membership is
 *                               empty for FastTrax. This mirrors how race-pack CREDITS
 *                               load (Pandora addDeposit) — the clean, bill-free rail.
 */
import { fetchPersonRaw } from "~/features/daily-events/data/bmi-office";
import { LICENSE_PRICE } from "./race-pricing";
import { addMembership } from "@/lib/pandora-memberships";
import { markLicenseRegistered, markLicenseRegisterFailed } from "../data/race-license-grants-db";

/** BMI license product — kind=1 "License Fee" fee line (the $4.99 charge in the
 *  race flow). Kept for traceability; the standalone grant uses Pandora, not this. */
export const LICENSE_PRODUCT_ID = "43473520";

/** FastTrax Office/BMI client key (racing accounts live in the FastTrax BMI —
 *  same key the kiosk license lookup uses). */
const FASTTRAX_CLIENT_KEY = "headpinzftmyers";

/** License-fee price in cents, re-derived server-side (displayed == charged). */
export const LICENSE_PRICE_CENTS = Math.round(LICENSE_PRICE * 100);

interface OfficeMembership {
  name?: string;
  stops?: string | null;
}
interface OfficePersonMemberships {
  memberships?: OfficeMembership[];
}

/**
 * Does this BMI person hold an ACTIVE license membership?
 *   true  — an un-expired membership whose name contains "license" is on file.
 *   false — the record was read and no such active membership exists.
 *   null  — the record couldn't be read (not found yet / Office error).
 */
export async function personHasActiveLicense(personId: string): Promise<boolean | null> {
  if (!/^\d{1,20}$/.test(personId)) return null;
  try {
    const person = await fetchPersonRaw<OfficePersonMemberships>(FASTTRAX_CLIENT_KEY, personId);
    const now = Date.now();
    return (person.memberships ?? []).some(
      (m) =>
        typeof m.name === "string" &&
        m.name.toLowerCase().includes("license") &&
        (!m.stops || new Date(m.stops).getTime() > now),
    );
  } catch {
    return null;
  }
}

/**
 * The money-safe "does this racer owe a $4.99 license" gate.
 *  - Verified licensed → false (never charge a racer who already has one).
 *  - Verified NOT licensed → true (includes a returning racer whose license lapsed).
 *  - Couldn't verify (brand-new person, Office lag, transient error) → trust the
 *    client's new-racer hint. A freshly-created racer is `clientSaysNew === true`,
 *    so they still get licensed; an unverifiable returning racer defaults to their
 *    hint (false) rather than a surprise charge.
 */
export async function personNeedsLicense(
  personId: string,
  clientSaysNew: boolean,
): Promise<boolean> {
  const has = await personHasActiveLicense(personId);
  if (has === true) return false;
  if (has === false) return true;
  return clientSaysNew;
}

export interface LicenseRegistrationInput {
  /** Raw BMI person id string — NEVER Number() it. */
  personId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}

/**
 * Grant a FastTrax license by writing the "License Fee" membership into Firebird
 * via Pandora (`addMembership`) — NO BMI bill. Returns the Pandora membership id.
 * Throws on failure — the caller owns the persist-first ledger + reconcile (the
 * money is already captured). Contact fields are accepted for API symmetry but the
 * Pandora write only needs the personId (+ the license kind id + 1-year expiry,
 * both handled inside addMembership).
 */
export async function registerStandaloneLicense(
  input: LicenseRegistrationInput,
): Promise<{ membershipId: string }> {
  if (!/^\d{1,20}$/.test(input.personId)) {
    throw new Error(
      `registerStandaloneLicense: invalid personId ${JSON.stringify(input.personId)}`,
    );
  }
  const membershipId = await addMembership({ personId: input.personId });
  console.log(
    `[race-license] granted license membership ${membershipId} for person ${input.personId}`,
  );
  return { membershipId };
}

export interface LicenseGrantOutcome {
  /** Raw BMI person id string. */
  personId: string;
  memberName: string;
  /** false → registration failed AFTER the charge; the ledger row is the
   *  reconcile target and staff completes the license at the desk. The guest
   *  is NEVER charged twice (the ledger prevents re-charge). */
  registered: boolean;
}

/**
 * Register every persisted license obligation for a purchase. Runs strictly
 * AFTER the money is verified. Never throws — a failed Pandora grant marks the row
 * 'register-failed' (+ logs) so the guest's purchase is never thrown away.
 */
export async function grantLicenses(args: {
  sourceKey: string;
  obligations: Array<{
    personId: string;
    memberName: string;
    email?: string | null;
    phone?: string | null;
  }>;
  squareRef?: string | null;
}): Promise<LicenseGrantOutcome[]> {
  const out: LicenseGrantOutcome[] = [];
  for (const o of args.obligations) {
    const [firstName, ...rest] = o.memberName.trim().split(/\s+/);
    try {
      const { membershipId } = await registerStandaloneLicense({
        personId: o.personId,
        firstName: firstName || o.memberName || "Racer",
        lastName: rest.join(" "),
        email: o.email ?? undefined,
        phone: o.phone ?? undefined,
      });
      await markLicenseRegistered(args.sourceKey, o.personId, membershipId, args.squareRef ?? null);
      out.push({ personId: o.personId, memberName: o.memberName, registered: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "license registration failed";
      console.error(
        `[race-license] registration FAILED after charge: source=${args.sourceKey} person=${o.personId}: ${msg}`,
      );
      await markLicenseRegisterFailed(
        args.sourceKey,
        o.personId,
        msg,
        args.squareRef ?? null,
      ).catch(() => {});
      out.push({ personId: o.personId, memberName: o.memberName, registered: false });
    }
  }
  return out;
}
