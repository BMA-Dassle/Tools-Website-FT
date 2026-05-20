/**
 * Discount-codes — public surface.
 *
 * Customer flows import from here:
 *   import { evaluateCode, getDiscountCodeByCode } from "~/features/discount-codes";
 *
 * Server-side enforcement (quote/reserve/refund) goes through `recordRedemption`
 * / `refundRedemption` so uses_count stays in sync with reality.
 */

export {
  ensureDiscountCodesSchema,
  listDiscountCodes,
  getDiscountCodeById,
  getDiscountCodeByCode,
  insertDiscountCode,
  updateDiscountCode,
  setSquareCatalog,
  setActive,
  recordRedemption,
  refundRedemption,
} from "./data";

export {
  evaluateCode,
  provisionSquareDiscount,
  etWeekday,
  domainsFromScopes,
  resolveAppliedPromo,
} from "./service";

export type {
  AppliedPromo,
  DiscountCodeRow,
  DiscountCodeInput,
  DiscountDomain,
  DiscountMechanic,
  DiscountScopes,
  SquareCatalogType,
  ValidateContext,
  ValidateResponse,
  ValidateResult,
  ValidateFailure,
  ValidateReason,
  DiscountRedemptionRow,
} from "./types";
