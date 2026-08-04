/**
 * Prepaid deal packs — public surface.
 *
 * A deal pack is a voucher sold for money: `catalog.ts` says what a pack is
 * worth, `data/deal-purchases-db.ts` is the durable money record and the mint
 * idempotency anchor, and `service/*` holds the decisions. Routes stay thin.
 */

export {
  DEAL_CATALOG,
  DEAL_LOCATIONS,
  DEAL_LOCATION_INFO,
  dealExpiryFrom,
  dealIsSellable,
  etOffsetFor,
  dealSquareCatalogId,
  dealValue,
  dealVoucherItems,
  dealVoucherSummary,
  dealsForLocation,
  gameZoneItemDollars,
  getDeal,
  isDealLocation,
  type DealCatalogEntry,
  type DealFaq,
  type DealLimitedOffer,
  type DealLocationKey,
  type DealValue,
  type DealValueLine,
} from "./catalog";

export { capDecision, checkBuyerCap, type CapDecision } from "./service/cap";

export {
  currentDealOffer,
  dealOfferEndsAt,
  dealNeedsSoldCount,
  resolveDealOffer,
  type DealOffer,
} from "./service/offer";

export {
  PAID_STATUSES,
  claimAbandonEmail,
  countPacksForBuyer,
  countPacksSold,
  listAbandonedDealPurchases,
  releaseAbandonEmail,
  getDealPurchase,
  insertDealPurchase,
  listDealPurchases,
  listUnfinishedDealPurchases,
  markDealPurchaseCharged,
  markDealPurchaseChargeFailed,
  markDealPurchaseMinted,
  markDealPurchaseRefunded,
  markDealPurchaseSent,
  recordDealPurchaseError,
  type DealPurchaseRow,
  type DealPurchaseStatus,
  type InsertDealPurchaseArgs,
} from "./data/deal-purchases-db";
