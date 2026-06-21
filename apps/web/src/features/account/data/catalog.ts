import redis from "@/lib/redis";
import { squareFetch } from "./square-client";

export interface PlanInfo {
  name: string | null;
  /** Recurring amount in cents, when the plan carries a static price. */
  amount: number | null;
  cadence: string | null;
}

const CADENCE_LABELS: Record<string, string> = {
  DAILY: "Daily",
  WEEKLY: "Weekly",
  EVERY_TWO_WEEKS: "Every 2 weeks",
  THIRTY_DAYS: "Every 30 days",
  SIXTY_DAYS: "Every 60 days",
  NINETY_DAYS: "Every 90 days",
  MONTHLY: "Monthly",
  EVERY_TWO_MONTHS: "Every 2 months",
  QUARTERLY: "Quarterly",
  EVERY_FOUR_MONTHS: "Every 4 months",
  EVERY_SIX_MONTHS: "Every 6 months",
  ANNUAL: "Yearly",
  EVERY_TWO_YEARS: "Every 2 years",
};

interface CatalogObject {
  subscription_plan_variation_data?: {
    name?: string;
    phases?: {
      cadence?: string;
      pricing?: { price_money?: { amount?: number } };
    }[];
  };
}

/**
 * Resolve a plan variation id → display name / amount / cadence. Plans are few
 * and static, so cache the resolved shape in Redis for an hour. RELATIVE-priced
 * plans (e.g. Have-A-Ball) carry no static price → amount stays null and the
 * subscription's price_override_money is used instead by the caller.
 */
export async function planInfo(planVariationId: string | undefined): Promise<PlanInfo> {
  const empty: PlanInfo = { name: null, amount: null, cadence: null };
  if (!planVariationId) return empty;

  const cacheKey = `acct:plancache:${planVariationId}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as PlanInfo;
    } catch {
      /* fall through and refetch */
    }
  }

  const { ok, data } = await squareFetch<{ object?: CatalogObject }>(
    `/catalog/object/${encodeURIComponent(planVariationId)}`,
  );
  let info = empty;
  if (ok && data.object?.subscription_plan_variation_data) {
    const v = data.object.subscription_plan_variation_data;
    const phase = v.phases?.[0];
    info = {
      name: v.name ?? null,
      amount: phase?.pricing?.price_money?.amount ?? null,
      cadence: phase?.cadence ? (CADENCE_LABELS[phase.cadence] ?? phase.cadence) : null,
    };
  }
  await redis.set(cacheKey, JSON.stringify(info), "EX", 3600).catch(() => {});
  return info;
}
