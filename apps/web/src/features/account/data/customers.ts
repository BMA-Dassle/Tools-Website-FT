import { squareErrorDetail, squareFetch } from "./square-client";
import type { ContactType, SavedCard } from "../types";

/**
 * Match Square customer records by the VERIFIED contact only.
 *   email verified → records whose email_address exactly equals it
 *   phone verified → records whose phone_number (E.164) exactly equals it
 * The merchant has duplicate customer records, so multiple ids are expected;
 * we dedupe. Returns [] when nothing matches (a valid, non-error state).
 */
export async function searchCustomersByContact(
  value: string,
  type: ContactType,
): Promise<string[]> {
  const filter =
    type === "email" ? { email_address: { exact: value } } : { phone_number: { exact: value } };

  const { ok, status, data } = await squareFetch<{ customers?: { id?: string }[] }>(
    "/customers/search",
    {
      method: "POST",
      body: JSON.stringify({ query: { filter } }),
    },
  );
  if (!ok) {
    console.warn(
      `[account] customer search (${type}) failed: ${status} ${squareErrorDetail(data)}`,
    );
    return [];
  }

  const ids = [
    ...new Set((data.customers ?? []).map((c) => c.id).filter((id): id is string => !!id)),
  ];
  console.log(`[account] customer search (${type}) → ${ids.length} match(es)`);
  return ids;
}

export interface CustomerProfile {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

/** Fetch a single Square customer's profile (name/email/phone) for booking prefill. */
export async function getCustomerProfile(customerId: string): Promise<CustomerProfile | null> {
  const { ok, data } = await squareFetch<{
    customer?: {
      id?: string;
      given_name?: string;
      family_name?: string;
      email_address?: string;
      phone_number?: string;
    };
  }>(`/customers/${encodeURIComponent(customerId)}`);
  const c = data.customer;
  if (!ok || !c?.id) return null;
  return {
    id: c.id,
    firstName: c.given_name || "",
    lastName: c.family_name || "",
    email: c.email_address || "",
    phone: c.phone_number || "",
  };
}

interface SquareCard {
  id: string;
  customer_id?: string;
  card_brand?: string;
  last_4?: string;
  exp_month?: number;
  exp_year?: number;
  enabled?: boolean;
}

/**
 * Saved cards for a customer. Mapper ported verbatim from
 * app/api/square/customer/route.ts (filters disabled cards, computes `expired`),
 * plus the owning customerId so set-card can scope offered cards to a sub's customer.
 */
export async function fetchSavedCards(customerId: string): Promise<SavedCard[]> {
  const { ok, data } = await squareFetch<{ cards?: SquareCard[] }>(
    `/cards?customer_id=${encodeURIComponent(customerId)}`,
  );
  if (!ok || !Array.isArray(data.cards)) return [];

  const now = new Date();
  return data.cards
    .filter((c) => c.enabled !== false)
    .map((c) => {
      const expMonth = c.exp_month ?? 0;
      const expYear = c.exp_year ?? 0;
      // new Date(year, month) = first day of the month AFTER expiry (month is 0-based)
      const expDate = new Date(expYear, expMonth);
      return {
        id: c.id,
        brand: c.card_brand || "Card",
        last4: c.last_4 || "",
        expMonth,
        expYear,
        expired: expYear > 0 ? expDate < now : false,
        customerId: c.customer_id || customerId,
      };
    });
}
