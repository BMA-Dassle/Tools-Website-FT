/**
 * Group function service charge verification + BMI correction.
 *
 * Service charge tiers (based on event subtotal, excluding service charge and tax):
 *   $0 – $2,499      → 15%
 *   $2,500 – $7,499   → 14%
 *   $7,500 – $14,999  → 13%
 *   $15,000+           → 12%
 *
 * The BMI product is named "GF Service Charge - XX%", "GF Service Charge",
 * or just "Service Charge". There will be at most one per event.
 */

import { fetchProject, updateProjectProduct } from "@/lib/bmi-office-actions";

const SERVICE_CHARGE_PLU = "IBXWNWIZRCEY4B4RXK4JXD5G";
const SERVICE_CHARGE_PATTERN = /service\s*charge/i;

const TIERS = [
  { min: 15_000, pct: 12 },
  { min: 7_500, pct: 13 },
  { min: 2_500, pct: 14 },
  { min: 0, pct: 15 },
] as const;

export function getServiceChargePct(subtotalDollars: number): number {
  for (const tier of TIERS) {
    if (subtotalDollars >= tier.min) return tier.pct;
  }
  return 15;
}

export interface ServiceChargeResult {
  found: boolean;
  productName: string | null;
  currentAmount: number;
  correctPct: number;
  correctAmount: number;
  needsUpdate: boolean;
  subtotalDollars: number;
}

export function verifyServiceCharge(
  products: Array<{ name: string; price: number; qty: number; total: number; plu?: string }>,
): ServiceChargeResult {
  const scProduct =
    products.find((p) => p.plu === SERVICE_CHARGE_PLU) ||
    products.find((p) => SERVICE_CHARGE_PATTERN.test(p.name));

  if (!scProduct) {
    return {
      found: false,
      productName: null,
      currentAmount: 0,
      correctPct: 0,
      correctAmount: 0,
      needsUpdate: false,
      subtotalDollars: 0,
    };
  }

  const subtotal = products
    .filter((p) => p.plu !== SERVICE_CHARGE_PLU && !SERVICE_CHARGE_PATTERN.test(p.name))
    .reduce((sum, p) => sum + p.total, 0);

  const correctPct = getServiceChargePct(subtotal);
  const correctAmount = Math.round(subtotal * correctPct) / 100;
  const currentAmount = scProduct.total;
  // Tolerance: $0.05 avoids false positives from minor rounding at source
  const needsUpdate = Math.abs(currentAmount - correctAmount) > 0.05;

  return {
    found: true,
    productName: scProduct.name,
    currentAmount,
    correctPct,
    correctAmount,
    needsUpdate,
    subtotalDollars: subtotal,
  };
}

export function isServiceChargeProduct(name: string, plu?: string): boolean {
  return plu === SERVICE_CHARGE_PLU || SERVICE_CHARGE_PATTERN.test(name);
}

/**
 * Verify and correct the service charge in BMI Office.
 * Fetches the project, finds the service charge projectProduct by matching
 * the current amount from Hermes, and PUTs the corrected price.
 *
 * Returns the corrected products array (with updated service charge amount)
 * or the original if no update was needed.
 */
export async function verifyAndCorrectServiceCharge(
  centerCode: string,
  projectId: string,
  hermesProducts: Array<{ name: string; price: number; qty: number; total: number }>,
): Promise<{
  products: Array<{ name: string; price: number; qty: number; total: number }>;
  corrected: boolean;
  result: ServiceChargeResult;
}> {
  const result = verifyServiceCharge(hermesProducts);

  if (!result.found || !result.needsUpdate) {
    return { products: hermesProducts, corrected: false, result };
  }

  const project = await fetchProject(centerCode, projectId);
  if (!project) {
    console.warn(`[service-charge] could not fetch project ${projectId} to correct service charge`);
    return { products: hermesProducts, corrected: false, result };
  }

  const bmiProducts = (project.products || []) as Array<{
    id: string;
    productId: string;
    pricePerUnit: number;
    totalPrice: number;
  }>;

  // Match by current amount (± $0.02 tolerance for rounding)
  const scBmiProduct = bmiProducts.find(
    (bp) => Math.abs(bp.totalPrice - result.currentAmount) < 0.02,
  );

  if (!scBmiProduct) {
    console.warn(
      `[service-charge] could not find service charge product in BMI project ${projectId} ` +
        `(expected amount ~$${result.currentAmount.toFixed(2)})`,
    );
    return { products: hermesProducts, corrected: false, result };
  }

  try {
    await updateProjectProduct({
      centerCode,
      projectId,
      productId: scBmiProduct.productId,
      projectProductId: scBmiProduct.id,
      productName: result.productName || "Service Charge",
      pricePerUnit: result.correctAmount,
    });

    console.log(
      `[service-charge] corrected project ${projectId}: ` +
        `$${result.currentAmount.toFixed(2)} → $${result.correctAmount.toFixed(2)} ` +
        `(${result.correctPct}% of $${result.subtotalDollars.toFixed(2)} subtotal)`,
    );

    const correctedProducts = hermesProducts.map((p) =>
      SERVICE_CHARGE_PATTERN.test(p.name)
        ? { ...p, price: result.correctAmount, total: result.correctAmount }
        : p,
    );

    return { products: correctedProducts, corrected: true, result };
  } catch (err) {
    console.error(`[service-charge] failed to update BMI product for project ${projectId}:`, err);
    return { products: hermesProducts, corrected: false, result };
  }
}
