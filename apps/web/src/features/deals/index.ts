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
  dealSquareCatalogId,
  dealValue,
  dealVoucherItems,
  dealsForLocation,
  gameZoneItemDollars,
  getDeal,
  isDealLocation,
  type DealCatalogEntry,
  type DealFaq,
  type DealLocationKey,
  type DealValue,
  type DealValueLine,
} from "./catalog";

export { capDecision, checkBuyerCap, type CapDecision } from "./service/cap";

export {
  PAID_STATUSES,
  countPacksForBuyer,
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
