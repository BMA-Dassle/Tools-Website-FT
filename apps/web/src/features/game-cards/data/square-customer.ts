/**
 * Square customer profile + HeadPinz Rewards (Square Loyalty) reads for the
 * account picker. Reuses the account module's shared Square client. Read-only.
 */
import { squareFetch } from "~/features/account/data/square-client";

export interface CustomerProfile {
  customerId: string;
  name: string | null;
  email: string | null;
}

/** GET /customers/{id} → display name + email (best-effort; null on miss). */
export async function getCustomerProfile(customerId: string): Promise<CustomerProfile> {
  try {
    const { ok, data } = await squareFetch<{
      customer?: { given_name?: string; family_name?: string; email_address?: string };
    }>(`/customers/${encodeURIComponent(customerId)}`, { method: "GET" });
    if (!ok || !data.customer) return { customerId, name: null, email: null };
    const c = data.customer;
    const name = [c.given_name, c.family_name].filter(Boolean).join(" ").trim() || null;
    return { customerId, name, email: c.email_address || null };
  } catch {
    return { customerId, name: null, email: null };
  }
}

export async function getCustomerProfiles(customerIds: string[]): Promise<CustomerProfile[]> {
  return Promise.all(customerIds.map(getCustomerProfile));
}

/**
 * HeadPinz Rewards points for a phone via Square Loyalty
 * (POST /loyalty/accounts/search, phone mapping). Loyalty is phone-keyed, so
 * this is a session-level balance, not per Square customer. null when none.
 */
export async function getLoyaltyPointsByPhone(phone: string): Promise<number | null> {
  try {
    const { ok, data } = await squareFetch<{
      loyalty_accounts?: { balance?: number }[];
    }>("/loyalty/accounts/search", {
      method: "POST",
      body: JSON.stringify({ query: { mappings: [{ phone_number: phone }] }, limit: 1 }),
    });
    if (!ok || !data.loyalty_accounts?.length) return null;
    return data.loyalty_accounts[0].balance ?? 0;
  } catch {
    return null;
  }
}
