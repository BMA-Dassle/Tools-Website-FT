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
 *   registerStandaloneLicense() — booking/sell(43473520) → registerContactPerson →
 *                               payment/confirm. Selling 43473520 makes BMI auto-add
 *                               the kind=3 membership line (see OrderSummary.tsx:361),
 *                               i.e. it attaches the "License Fee" membership. Mirrors
 *                               the proven race-pack sell flow + legacy sellLicense
 *                               (race.ts:600) + the diag route (api/test/race-pack-diag).
 *
 * BMI ID precision: person/order ids are injected as RAW STRINGS and read back with
 * regex — NEVER JSON.stringify / JSON.parse an id (17-digit precision rule).
 */
import { randomUUID } from "crypto";
import { apiBase } from "@/lib/api-base";
import { fetchPersonRaw } from "~/features/daily-events/data/bmi-office";
import { LICENSE_PRICE } from "./race-pricing";
import { markLicenseRegistered, markLicenseRegisterFailed } from "../data/race-license-grants-db";

/** BMI license product — kind=1 "License Fee" sell item. Selling it makes BMI
 *  auto-add the kind=3 membership (product 11253570) that marks the racer
 *  licensed for a year. Same id used across the race flows (race.ts, checkout.ts). */
export const LICENSE_PRODUCT_ID = "43473520";

/** FastTrax Office/BMI client key (racing accounts live in the FastTrax BMI —
 *  same key the kiosk license lookup uses). */
const FASTTRAX_CLIENT_KEY = "headpinzftmyers";

/** License-fee price in cents, re-derived server-side (displayed == charged). */
export const LICENSE_PRICE_CENTS = Math.round(LICENSE_PRICE * 100);

/** Optional BMI page the standalone license bill is created on. Empty by default
 *  (the legacy sellLicense onto an existing bill sends no page); if a live smoke
 *  shows BMI needs a page to CREATE the bill, set RACE_LICENSE_PAGE_ID. */
const LICENSE_PAGE_ID = process.env.RACE_LICENSE_PAGE_ID || "";

interface OfficeMembership {
  name?: string;
  stops?: string | null;
}
interface OfficePersonMemberships {
  memberships?: OfficeMembership[];
}

/** Extract a raw numeric field from a BMI response body by regex (precision-safe). */
function extractRawField(text: string, field: string): string | null {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`));
  return m ? m[1] : null;
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

/** Server-side POST to the BMI proxy with a RAW string body (id precision). */
async function bmiPost(endpoint: string, body: string): Promise<{ ok: boolean; text: string }> {
  const res = await fetch(`${apiBase()}/api/bmi?${new URLSearchParams({ endpoint })}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await res.text();
  return { ok: res.ok, text };
}

/**
 * Register a FastTrax license on a racer's BMI account by selling product
 * 43473520 on its own bill and confirming it (depositKind 0 = external / Square).
 * Returns the BMI bill id. Throws on any step failure — the caller owns the
 * persist-first ledger + failure recovery (the money is already captured).
 */
export async function registerStandaloneLicense(
  input: LicenseRegistrationInput,
): Promise<{ billId: string }> {
  if (!/^\d{1,20}$/.test(input.personId)) {
    throw new Error(
      `registerStandaloneLicense: invalid personId ${JSON.stringify(input.personId)}`,
    );
  }

  // 1. Sell the license → new bill (OrderId:null). Raw-string body so the
  //    17-digit PersonId survives. PageId only sent if configured.
  const sellParts = [
    `"ProductId":${LICENSE_PRODUCT_ID}`,
    ...(LICENSE_PAGE_ID ? [`"PageId":${LICENSE_PAGE_ID}`] : []),
    `"Quantity":1`,
    `"OrderId":null`,
    `"ParentOrderItemId":null`,
    `"DynamicLines":[]`,
    `"PersonId":${input.personId}`,
  ];
  const sell = await bmiPost("booking/sell", `{${sellParts.join(",")}}`);
  if (!sell.ok)
    throw new Error(`booking/sell ${LICENSE_PRODUCT_ID} failed: ${sell.text.slice(0, 160)}`);
  const billId = extractRawField(sell.text, "orderId");
  if (!billId) throw new Error(`booking/sell returned no orderId: ${sell.text.slice(0, 160)}`);

  // 2. Attach the racer as the bill's contact person.
  const email = (input.email ?? "").replace(/"/g, "");
  const phone = (input.phone ?? "").replace(/\D/g, "");
  const first = input.firstName.replace(/"/g, "").trim() || "Racer";
  const last = input.lastName.replace(/"/g, "").trim();
  const regBody =
    `{"orderId":${billId},"PersonId":${input.personId},` +
    `"firstName":"${first}","lastName":"${last}","email":"${email}","phone":"${phone}"}`;
  const reg = await bmiPost("person/registerContactPerson", regBody);
  if (!reg.ok) throw new Error(`registerContactPerson failed: ${reg.text.slice(0, 160)}`);

  // 3. Confirm the bill (depositKind 0 = external Square payment). Use BMI's own
  //    line price when present; fall back to the $4.99 license price.
  let amount = LICENSE_PRICE;
  try {
    const parsed = JSON.parse(sell.text) as { prices?: Array<{ amount?: number }> };
    const p = parsed.prices?.[0]?.amount;
    if (typeof p === "number" && p > 0) amount = p;
  } catch {
    /* keep the fallback */
  }
  const payBody =
    `{"id":"${randomUUID()}","paymentTime":"${new Date().toISOString()}",` +
    `"amount":${amount},"orderId":${billId},"depositKind":0}`;
  const pay = await bmiPost("payment/confirm", payBody);
  if (!pay.ok) throw new Error(`payment/confirm failed: ${pay.text.slice(0, 160)}`);

  console.log(`[race-license] registered license bill ${billId} for person ${input.personId}`);
  return { billId };
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
 * AFTER the money is verified. Never throws — a failed BMI sale marks the row
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
      const { billId } = await registerStandaloneLicense({
        personId: o.personId,
        firstName: firstName || o.memberName || "Racer",
        lastName: rest.join(" "),
        email: o.email ?? undefined,
        phone: o.phone ?? undefined,
      });
      await markLicenseRegistered(args.sourceKey, o.personId, billId, args.squareRef ?? null);
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
