/**
 * HeadPinz Rewards — server-side reward-tier verification.
 *
 * WHY THIS EXISTS
 * ---------------
 * The kiosk's direct-Terminal rail computes the reader charge on the PREPARE
 * pass and re-derives it on FINALIZE; the two must agree to the cent or the
 * finalize sum check refuses the captured payment. A Square loyalty reward
 * cannot be created on the prepare pass (points would leave the account before
 * any money moved, and a walk-away would strand them), so the prepare pass
 * prices the reward as a flat `rewardDiscountCents` instead — which makes that
 * number a CHARGE INPUT. A charge input is never taken from the browser: both
 * passes look the tier up here and price from Square's definition.
 *
 * Only ORDER-scope FIXED_AMOUNT tiers are priceable this way (the kiosk offers
 * only those). Anything else returns `fixedDiscountCents: null` and the caller
 * refuses the reward.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN ?? ""}`,
    "Square-Version": SQUARE_VERSION,
    "Content-Type": "application/json",
  };
}

export interface RewardTierDefinition {
  id: string;
  name: string;
  /** Points the tier costs to redeem. */
  points: number;
  /** Flat $-off in cents for an ORDER-scope FIXED_AMOUNT tier; null otherwise. */
  fixedDiscountCents: number | null;
}

/**
 * Look one reward tier up on the main loyalty program. Returns null when the
 * program can't be read or the tier isn't on it — callers fail the reward
 * closed in both cases.
 */
export async function fetchRewardTier(tierId: string): Promise<RewardTierDefinition | null> {
  if (!tierId) return null;
  try {
    const res = await fetch(`${SQUARE_BASE}/loyalty/programs/main`, {
      method: "GET",
      headers: sqHeaders(),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`[loyalty/reward-tier] program read failed: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      program?: {
        reward_tiers?: Array<{
          id?: string;
          name?: string;
          points?: number;
          definition?: {
            scope?: string;
            discount_type?: string;
            fixed_discount_money?: { amount?: number };
          };
        }>;
      };
    };
    const tier = data.program?.reward_tiers?.find((t) => t.id === tierId);
    if (!tier?.id) return null;
    const def = tier.definition;
    const flat =
      def?.scope === "ORDER" &&
      def.discount_type === "FIXED_AMOUNT" &&
      typeof def.fixed_discount_money?.amount === "number" &&
      def.fixed_discount_money.amount > 0
        ? def.fixed_discount_money.amount
        : null;
    return {
      id: tier.id,
      name: tier.name ?? "",
      points: tier.points ?? 0,
      fixedDiscountCents: flat,
    };
  } catch (err) {
    console.error("[loyalty/reward-tier] program read error:", err);
    return null;
  }
}

/**
 * Current point balance of a loyalty account, or null when it can't be read.
 * Used on the kiosk PREPARE pass so an unaffordable tier is refused BEFORE the
 * reader is armed, not after the guest has tapped.
 */
export async function fetchLoyaltyBalance(accountId: string): Promise<number | null> {
  if (!accountId) return null;
  try {
    const res = await fetch(`${SQUARE_BASE}/loyalty/accounts/${accountId}`, {
      method: "GET",
      headers: sqHeaders(),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`[loyalty/reward-tier] account read failed: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { loyalty_account?: { balance?: number } };
    const balance = data.loyalty_account?.balance;
    return typeof balance === "number" ? balance : null;
  } catch (err) {
    console.error("[loyalty/reward-tier] account read error:", err);
    return null;
  }
}
