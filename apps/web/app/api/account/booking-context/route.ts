import { requireSession } from "~/features/account/service/session";
import { getCustomerProfile, fetchSavedCards } from "~/features/account/data/customers";
import { lookupLoyaltyByPhone } from "~/features/account/data/loyalty";
import { jsonOk, toErrorResponse } from "~/features/account/errors";
import type { SavedCard } from "~/features/account/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/account/booking-context — everything the booking flow needs to make
 * a logged-in checkout frictionless, all DERIVED FROM THE SESSION (the client
 * supplies nothing):
 *   - contact: prefill name/email/phone so the guest never retypes it
 *   - squareCustomerId + savedCards: offer cards on file at payment
 *   - loyalty: auto-applied HeadPinz Rewards (verified, because the phone session
 *     already proved the number) — null when not enrolled, so the UI shows the
 *     enroll CTA instead of re-asking for a phone.
 *
 * The CHARGE-TIME guard lives in /api/square/pay (a saved card may only be
 * charged against a customer in the session). This endpoint is read-only.
 */
export async function GET() {
  try {
    const session = await requireSession();
    const customerIds = session.squareCustomerIds;

    // Primary profile (first matched customer) for name/email/phone prefill.
    const primaryId = customerIds[0] ?? null;
    const profile = primaryId ? await getCustomerProfile(primaryId) : null;

    // Saved cards across every customer record bound to this session, deduped.
    const cardLists = await Promise.all(customerIds.map((id) => fetchSavedCards(id)));
    const seen = new Set<string>();
    const savedCards: SavedCard[] = [];
    for (const card of cardLists.flat()) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      savedCards.push(card);
    }

    // Loyalty is phone-keyed — only a phone session has a verified number.
    const loyaltyAcct =
      session.contactType === "phone" ? await lookupLoyaltyByPhone(session.contact) : null;
    const loyalty =
      loyaltyAcct && loyaltyAcct.customerId
        ? {
            accountId: loyaltyAcct.id,
            customerId: loyaltyAcct.customerId,
            balance: loyaltyAcct.balance,
            verified: true as const,
          }
        : null;

    return jsonOk({
      contact: {
        firstName: profile?.firstName ?? "",
        lastName: profile?.lastName ?? "",
        email: session.contactType === "email" ? session.contact : (profile?.email ?? ""),
        phone: session.contactType === "phone" ? session.contact : (profile?.phone ?? ""),
      },
      squareCustomerId: primaryId,
      savedCards,
      loyalty,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
