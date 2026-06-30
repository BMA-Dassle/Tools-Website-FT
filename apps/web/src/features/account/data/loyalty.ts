import { squareErrorDetail, squareFetch } from "./square-client";

/**
 * HeadPinz Rewards (Square Loyalty) lookup for the account dashboard and the
 * logged-in booking-context endpoint. Calls Square DIRECTLY via the shared
 * squareFetch (same token/version as the rest of the account module) rather
 * than HTTP-hopping through /api/square/loyalty/lookup.
 *
 * Phone MUST already be a verified E.164 from the session — the caller never
 * passes a client-supplied number. Returns null when the phone has no loyalty
 * account (a valid, non-error "not enrolled" state) so the UI can show an
 * enroll CTA; returns undefined on an upstream error so the section can render
 * an "unavailable / retry" state distinct from "not enrolled".
 */
export interface LoyaltyAccount {
  id: string;
  balance: number;
  lifetimePoints: number;
  customerId: string | null;
  enrolledAt: string | null;
}

interface SquareLoyaltyAccount {
  id?: string;
  balance?: number;
  lifetime_points?: number;
  customer_id?: string;
  enrolled_at?: string;
  created_at?: string;
}

export async function lookupLoyaltyByPhone(
  e164: string,
): Promise<LoyaltyAccount | null | undefined> {
  const { ok, status, data } = await squareFetch<{ loyalty_accounts?: SquareLoyaltyAccount[] }>(
    "/loyalty/accounts/search",
    {
      method: "POST",
      body: JSON.stringify({ query: { mappings: [{ phone_number: e164 }] }, limit: 1 }),
    },
  );
  if (!ok) {
    console.warn(`[account] loyalty search failed: ${status} ${squareErrorDetail(data)}`);
    return undefined; // upstream error → "unavailable"
  }
  const account = (data.loyalty_accounts ?? [])[0];
  if (!account?.id) return null; // not enrolled
  return {
    id: account.id,
    balance: account.balance ?? 0,
    lifetimePoints: account.lifetime_points ?? 0,
    customerId: account.customer_id ?? null,
    enrolledAt: account.enrolled_at ?? account.created_at ?? null,
  };
}
