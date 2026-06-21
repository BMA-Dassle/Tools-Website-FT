import { squareErrorDetail, squareFetch } from "./square-client";

export interface RawSubscription {
  id: string;
  status?: string;
  customer_id?: string;
  location_id?: string;
  plan_variation_id?: string;
  card_id?: string;
  version?: number;
  /** Date the subscription is paid through (proxy for next billing). */
  charged_through_date?: string;
  price_override_money?: { amount?: number; currency?: string };
}

/**
 * Subscriptions for the bound customers, across ALL locations. We bind strictly
 * by customer (the security boundary), so filtering by location would only hide
 * legitimate subscriptions without adding any safety. Location is used purely to
 * label/group in the UI.
 */
export async function searchSubscriptions(customerIds: string[]): Promise<RawSubscription[]> {
  if (customerIds.length === 0) return [];
  const { ok, status, data } = await squareFetch<{ subscriptions?: RawSubscription[] }>(
    "/subscriptions/search",
    {
      method: "POST",
      body: JSON.stringify({
        query: { filter: { customer_ids: customerIds } },
        include: ["actions"],
      }),
    },
  );
  if (!ok) {
    console.warn(`[account] subscription search failed: ${status} ${squareErrorDetail(data)}`);
    return [];
  }
  const subs = Array.isArray(data.subscriptions) ? data.subscriptions : [];
  console.log(
    `[account] subscription search: ${customerIds.length} customer(s) → ${subs.length} subscription(s)`,
  );
  return subs;
}

export async function retrieveSubscription(id: string): Promise<RawSubscription | null> {
  const { ok, data } = await squareFetch<{ subscription?: RawSubscription }>(
    `/subscriptions/${encodeURIComponent(id)}`,
  );
  if (!ok || !data.subscription) return null;
  return data.subscription;
}

export interface UpdateCardResult {
  ok: boolean;
  status: number;
  subscription?: RawSubscription;
  error?: string;
}

/** Change the card on a subscription. `version` is Square's concurrency control. */
export async function updateSubscriptionCard(
  id: string,
  cardId: string,
  version: number,
): Promise<UpdateCardResult> {
  const { ok, status, data } = await squareFetch<{ subscription?: RawSubscription }>(
    `/subscriptions/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify({ subscription: { card_id: cardId, version } }),
    },
  );
  if (ok && data.subscription) return { ok: true, status, subscription: data.subscription };
  return { ok: false, status, error: squareErrorDetail(data) };
}
