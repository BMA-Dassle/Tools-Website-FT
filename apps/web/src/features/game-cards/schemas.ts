/**
 * Zod request schemas for the game-cards API. Account numbers are kept as
 * STRINGS end-to-end (Intercard account numbers are bigint — never Number()).
 */

import { z } from "zod";

/** Card/account number: digits only, kept as a string (bigint-safe). */
const accountNumber = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, "Enter a valid card number");

const contact = z.object({
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  email: z.string().trim().email().max(160).optional(),
  phone: z.string().trim().max(40).optional(),
});

export const VerifyCardSchema = z.object({
  accountNumber,
  locationCode: z.number().int().optional(),
});
export type VerifyCardInput = z.infer<typeof VerifyCardSchema>;

/**
 * Resolve a raw scanned QR/barcode value to an account number. `raw` is the
 * decoded payload (a bare number, a `?id=` URL, or an Intercard shortlink the
 * server follows). Capped well under any real QR payload length.
 */
export const ResolveScanSchema = z.object({
  raw: z.string().trim().min(1).max(2048),
});
export type ResolveScanInput = z.infer<typeof ResolveScanSchema>;

/**
 * One line in the cart: the package to load, plus (for a reload) the existing
 * card it loads onto. New-card lines have NO accountNumber at purchase time —
 * the account is read off each blank as it's dispensed and attached at load.
 */
export const PurchaseItemSchema = z.object({
  accountNumber: accountNumber.optional(),
  packageId: z.string().min(1).max(64),
});
export type PurchaseItemInput = z.infer<typeof PurchaseItemSchema>;

const squareCustomerId = z.string().min(1).max(128);

/** Link a game card to the signed-in, selected Square customer. */
export const LinkCardSchema = z.object({
  customerId: squareCustomerId,
  accountNumber,
  locationCode: z.number().int().optional(),
});
export type LinkCardInput = z.infer<typeof LinkCardSchema>;

export const UnlinkCardSchema = z.object({
  customerId: squareCustomerId,
  accountNumber,
});
export type UnlinkCardInput = z.infer<typeof UnlinkCardSchema>;

/** Nickname a saved game card ("" clears it). */
export const RenameCardSchema = z.object({
  customerId: squareCustomerId,
  accountNumber,
  nickname: z.string().trim().max(40),
});
export type RenameCardInput = z.infer<typeof RenameCardSchema>;

/** Remove (disable) a saved payment card from the selected customer. */
export const DisableSavedCardSchema = z.object({
  customerId: squareCustomerId,
  cardId: z.string().min(1).max(128),
});
export type DisableSavedCardInput = z.infer<typeof DisableSavedCardSchema>;

export const PurchaseSchema = z
  .object({
    // "reload" loads existing cards; "new_card" charges for blanks that are
    // dispensed + loaded one at a time afterward (see /load-card).
    kind: z.enum(["reload", "new_card"]),
    // One location per transaction (one Square order books to one location).
    locationCode: z.number().int(),
    // Cart of 1-10 cards, each with its own package (single card = cart of 1).
    items: z.array(PurchaseItemSchema).min(1).max(10),
    cardNonce: z.string().min(1).max(4096).optional(),
    giftCardNonce: z.string().min(1).max(4096).optional(),
    saveCard: z.boolean().optional(),
    squareCustomerId: z.string().max(128).optional(),
    contact: contact.optional(),
  })
  .refine((v) => !!v.cardNonce || !!v.giftCardNonce, {
    message: "A card or gift card is required",
    path: ["cardNonce"],
  })
  .refine((v) => v.kind !== "reload" || v.items.every((it) => !!it.accountNumber), {
    message: "Each reload card needs an account number",
    path: ["items"],
  });
export type PurchaseInput = z.infer<typeof PurchaseSchema>;

/**
 * KIOSK direct-Terminal (Square reader) — two-phase, persist-first:
 *  1. PREPARE: verify (reload) + persist a ledger row per card + create the
 *     Square order the reader will charge. No money moves yet.
 *  2. FINALIZE: the reader already captured the card against that order — verify
 *     the payment server-side, mark the rows charged, then load (reload) or hand
 *     the rows back to dispense (new_card). NEVER re-charges.
 * Mirrors the bowling/racing terminal rail; keeps the embed path untouched.
 */
export const TerminalPrepareSchema = z.object({
  kind: z.enum(["reload", "new_card"]),
  locationCode: z.number().int(),
  items: z.array(PurchaseItemSchema).min(1).max(10),
  contact: contact.optional(),
});
export type TerminalPrepareInput = z.infer<typeof TerminalPrepareSchema>;

export const TerminalFinalizeSchema = z.object({
  kind: z.enum(["reload", "new_card"]),
  locationCode: z.number().int(),
  groupId: z.string().uuid(),
  /** The ledger rows created by PREPARE (server re-reads each for its amount). */
  txnIds: z.array(z.string().uuid()).min(1).max(10),
  externalPayment: z.object({
    paymentId: z.string().min(1).max(128),
    orderId: z.string().min(1).max(128),
    amountCents: z.number().int().nonnegative(),
    /** SPLIT checkouts (gift card + tap): every captured payment on the order —
     *  finalize verifies the SUM. Absent = single tap. */
    paymentIds: z.array(z.string().min(1).max(128)).max(6).optional(),
  }),
});
export type TerminalFinalizeInput = z.infer<typeof TerminalFinalizeSchema>;

/**
 * On-prem bridge queue (web reloads → local EIS credit). The bridge on each
 * center's kiosk PC polls POST /api/game-card-bridge/claim outbound, runs the
 * EIS credit locally, then reports via /ack. Auth is a shared-secret header
 * checked in the routes — these schemas are the payloads only.
 */
export const BridgeClaimSchema = z.object({
  locationCode: z.number().int(),
  /** Stable per-process id (hostname-pid) — pins acks to the claiming bridge. */
  workerId: z.string().trim().min(1).max(80),
  max: z.number().int().min(1).max(5).default(3),
});
export type BridgeClaimInput = z.infer<typeof BridgeClaimSchema>;

export const BridgeAckSchema = z.object({
  txnId: z.string().uuid(),
  workerId: z.string().trim().min(1).max(80),
  /**
   * ok       EIS ResponseCode 0 — credited
   * declined EIS replied non-0 — definitively NOT credited
   * no_attempt the request never reached the EIS (connect failed / stale claim)
   * unknown  request written but no/partial reply — outcome ambiguous; the row
   *          goes to 'verify' and is NEVER blindly retried (no EIS dedup)
   */
  outcome: z.enum(["ok", "declined", "no_attempt", "unknown"]),
  code: z.string().max(16).optional(),
  description: z.string().max(300).optional(),
});
export type BridgeAckInput = z.infer<typeof BridgeAckSchema>;

/** Success-screen poll: has each card in this purchase group loaded yet?
 *  The groupId is a server-minted UUID (capability token — unguessable). */
export const LoadStatusSchema = z.object({
  groupId: z.string().uuid(),
});
export type LoadStatusInput = z.infer<typeof LoadStatusSchema>;

/** Attach + load tokens onto ONE just-dispensed new card (post-charge). */
/**
 * Game Zone COMP voucher redemption (kiosk). `claim` takes the code and hands
 * back a $0 ledger row to dispense against; `release` gives an unspent code
 * back when no card left the stacker. Codes are the BMI 24-char shape — the
 * server re-validates against BMI_VOUCHER_RE, this is only a cheap gate.
 */
export const VoucherRedeemSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("claim"),
    code: z.string().trim().min(8).max(64),
    locationCode: z.number().int(),
    center: z.string().trim().max(40).optional(),
    kioskId: z.string().trim().max(120).optional(),
    /** Swipe kiosk (no dispenser): the blank the guest already swiped for this
     *  leg. Persisted on the comped row at claim (persist-first) so a load
     *  that never reaches the server still leaves a row the cron can credit. */
    accountNumber: accountNumber.optional(),
  }),
  z.object({
    action: z.literal("release"),
    code: z.string().trim().min(8).max(64),
    txnId: z.string().uuid(),
    reason: z.string().trim().max(200).optional(),
  }),
  /** Scan step: is this code good? Claims NOTHING (kiosk basket). Location +
   *  center are only needed to peek a BMI comp (tenant selection); native
   *  validation ignores them, so they stay optional for compatibility. */
  z.object({
    action: z.literal("validate"),
    code: z.string().trim().min(8).max(64),
    locationCode: z.number().int().optional(),
    center: z.string().trim().max(40).optional(),
  }),
  /** Read-only per-item state (native codes only) — the confirmation page's
   *  Available/Used chips. Same data the public /v/{code} page renders; the
   *  code is the bearer instrument either way. */
  z.object({
    action: z.literal("status"),
    code: z.string().trim().min(8).max(64),
  }),
  /** WEB leg: credit the value onto a card the guest already holds. */
  z.object({
    action: z.literal("to-card"),
    code: z.string().trim().min(8).max(64),
    accountNumber,
    locationCode: z.number().int(),
  }),
]);
export type VoucherRedeemInput = z.infer<typeof VoucherRedeemSchema>;

export const LoadCardSchema = z.object({
  groupId: z.string().uuid(),
  txnId: z.string().uuid(),
  accountNumber,
  locationCode: z.number().int(),
  /**
   * The kiosk PC's on-prem bridge already credited the tokens via the local EIS
   * server (the fast path). When true, the server records the load WITHOUT
   * re-crediting through the cloud SOAP path — never double-load. Absent/false →
   * the server credits via SOAP (the fallback when no bridge is reachable).
   */
  /**
   * The account came off a card the GUEST presented (swiped on an MSR-only
   * kiosk — a blank from the holder under the screen), not off a blank the
   * dispenser pulled from its stacker. A guest-presented card is never
   * clear-on-encoded: a blank has nothing to clear, and a card that somehow
   * carries value must keep it (the guest paid for the tokens being added).
   */
  swiped: z.boolean().optional(),
});
export type LoadCardInput = z.infer<typeof LoadCardSchema>;

/**
 * Card consolidation (kiosk, CLOUD ONLY): move ALL value from one source card
 * onto a target card, then clear the source — done server-side via cloud SOAP.
 * One source per call (the reader holds one card at a time); the kiosk loops.
 * Both accounts are bigint strings; a card can't be combined onto itself.
 */
export const ConsolidateSchema = z
  .object({
    locationCode: z.number().int(),
    targetAccount: accountNumber,
    sourceAccount: accountNumber,
  })
  .refine((v) => v.targetAccount !== v.sourceAccount, {
    message: "A card can't be combined onto itself",
    path: ["sourceAccount"],
  });
export type ConsolidateInput = z.infer<typeof ConsolidateSchema>;
