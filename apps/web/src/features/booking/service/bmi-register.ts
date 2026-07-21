/**
 * BMI person registration — attach the booking's customer (contact person) and
 * verified racers (project persons) to a BMI bill.
 *
 * Extracted from checkout.ts so BOTH the checkout orchestrator AND early
 * heat-booking (race.ts) can attach the customer the moment a bill is created —
 * without a circular import (checkout ↔ race). Registering at bill creation
 * means a reservation never exists without a customer, even if the session is
 * later abandoned.
 *
 * v1 parity: mirrors registerContactPerson / registerProjectPerson in
 * app/book/race/components/OrderSummary.tsx — same raw-id JSON injection (BMI
 * personId / orderId exceed Number.MAX_SAFE_INTEGER, so they are NEVER passed
 * through JSON.stringify; they're spliced in as raw text).
 */
import type { ContactInfo } from "../types";
import type { SessionItem } from "../state/types";

/**
 * PartyMember ids actually booked into a BMI-billed activity: race heats carry
 * a per-racer `assignedTo`; attractions carry the kiosk `participants` toggle
 * (undefined = the whole party — the KioskPeopleStep default when nobody was
 * toggled off) plus the universal `assignedTo` roster when populated.
 * Bowling/KBF are Conqueror-vendored — never on the BMI bill.
 *
 * The kiosk people roster is SESSION-scoped, so someone can be signed in
 * (account + waiver) without being put on any race or attraction — they must
 * NOT land on the reservation as a projectPerson (owner rule 2026-07-19: only
 * people booked into an activity go on the BMI reservation).
 */
export function bmiBookedMemberIds(items: SessionItem[], partyIds: string[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind === "race") {
      for (const h of item.heats) {
        if (h.heatId && h.assignedTo) ids.add(h.assignedTo);
      }
    } else if (item.kind === "attraction") {
      for (const id of item.participants ?? partyIds) ids.add(id);
      for (const id of item.assignedTo) ids.add(id);
    }
  }
  return ids;
}

/**
 * Register the billing contact (customer) on a bill. Always attaches
 * name/email/phone; adds personId only for a returning billing customer (so
 * credit linkages set during booking/book aren't wiped). For a new customer the
 * name attaches without a personId — this is what surfaces as the reservation's
 * customer for new racers (who have no project-person record). Non-fatal.
 */
export async function registerContact(
  billId: string,
  contact: Partial<ContactInfo>,
  party: { bmiPersonId?: string; isBillingCustomer?: boolean }[],
  clientKey?: string,
): Promise<void> {
  if (!contact.firstName || !contact.email || !contact.phone) return;
  try {
    const regBody: Record<string, unknown> = {
      firstName: contact.firstName,
      lastName: contact.lastName ?? "",
      email: contact.email,
      phone: (contact.phone ?? "").replace(/\D/g, ""),
    };
    const billingMember = party.find((m) => m.isBillingCustomer && m.bmiPersonId);
    let json = `{"orderId":${billId},` + JSON.stringify(regBody).slice(1);
    if (billingMember?.bmiPersonId) {
      json = json.slice(0, -1) + `,"personId":${billingMember.bmiPersonId}}`;
    }
    const qs = new URLSearchParams({
      endpoint: "person/registerContactPerson",
      ...(clientKey ? { clientKey } : {}),
    });
    await fetch(`/api/bmi?${qs}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json,
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Register each VERIFIED racer (returning / linked family — has a bmiPersonId)
 * as a project person on the bill. New racers have no personId and are skipped —
 * matching v1 (OrderSummary's registerProjectPerson gates on personId); their
 * name surfaces via the contact registration above. Non-fatal.
 *
 * Only party members actually booked into a BMI activity (`items` — see
 * bmiBookedMemberIds) are registered: a kiosk sign-in who was never put on a
 * race or attraction stays off the reservation roster.
 */
export async function registerProjectPersons(
  billId: string,
  party: { id: string; bmiPersonId?: string; firstName: string; lastName?: string }[],
  items: SessionItem[],
  clientKey?: string,
): Promise<void> {
  const booked = bmiBookedMemberIds(
    items,
    party.map((m) => m.id),
  );
  const qs = new URLSearchParams({
    endpoint: "person/registerProjectPerson",
    ...(clientKey ? { clientKey } : {}),
  });
  for (const member of party) {
    if (!booked.has(member.id)) continue;
    if (!member.bmiPersonId) continue;
    try {
      const regBody = JSON.stringify({
        firstName: member.firstName,
        lastName: member.lastName ?? "",
      });
      const raw = `{"personId":${member.bmiPersonId},"orderId":${billId},` + regBody.slice(1);
      await fetch(`/api/bmi?${qs}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
    } catch {
      /* non-fatal */
    }
  }
}
