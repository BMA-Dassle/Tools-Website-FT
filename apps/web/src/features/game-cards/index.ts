/**
 * Public surface of the game-cards feature. Import from `~/features/game-cards`
 * (not individual subpaths) so the API stays curated.
 *
 * Universal by design: `reload` is the first `kind`; a future `new_card`
 * purchase reuses this feature's service engine, ledger, and Intercard client.
 */

export { TOKEN_PACKAGES, SQUARE_TOKEN_CATALOG_ID, getPackage } from "./constants";
export type { TokenPackage } from "./constants";

export { gameCardKeys } from "./queries";
export { useCardBalance, usePurchase } from "./hooks";
export { apiPost, GameCardApiError } from "./api";

export { PurchaseSchema, VerifyCardSchema } from "./schemas";
export type { PurchaseInput, VerifyCardInput } from "./schemas";

export type {
  CardBalance,
  VerifyResult,
  PurchaseResult,
  PublicPackage,
  TxnKind,
  LoadState,
  TxnState,
} from "./types";

// Server-only entrypoints (services) intentionally NOT re-exported here to keep
// client bundles free of server code; import them directly from ./service/*.
