/**
 * PassKit project ids — one entry per pass PROGRAM we run.
 *
 * HARD-CODED, NOT ENV, on purpose. These are stable identifiers, not secrets:
 * they are useless without the API key, they never rotate, and there will be
 * several of them (vouchers today; the racing licence, deal packs and arena
 * tickets are all queued behind it). Three env vars per program would be nine
 * Vercel entries to keep in sync across three environments, and a typo in one of
 * them fails at runtime in a way nobody notices until a guest taps a button.
 * In code they are reviewable, diffable, and typo-checked by `tsc`.
 *
 * Only the CREDENTIALS live in env (`PASSKIT_API_KEY` / `PASSKIT_API_SECRET`) —
 * see src/lib/api/passkit.ts.
 *
 * TRADE-OFF ACCEPTED (owner decision 2026-08-03): preview deploys therefore
 * share production's campaign. That is safe for vouchers specifically, because a
 * pass is keyed by `externalId` = the real `HPW…` code and creation is
 * idempotent, so a preview tap on a real voucher produces the same single pass
 * production would. Do NOT copy that reasoning to a program where preview could
 * mint objects that production has to live with — give that one its own ids.
 *
 * ── Where these come from ────────────────────────────────────────────────────
 * Created 2026-08-03 by `scripts/passkit-voucher-template.mts` (design) and the
 * campaign/offer chain documented in tasks/future/passkit-wallet-passes.md § 7.
 * Region is **pub2** (USA); every PassKit doc example says pub1 and 404s here.
 */

export interface PassKitProject {
  /** Coupon campaign — the container. */
  campaignId: string;
  /** Offer within the campaign — carries the before/after-redeem templates. */
  offerId: string;
  /** Pass design. `scripts/passkit-voucher-template.mts` owns its content. */
  templateId: string;
}

/**
 * Guest vouchers (`HPW…`). Single-use coupon protocol: billed once at issuance,
 * so passes are created lazily when a guest taps Add to Wallet.
 */
/**
 * The voucher offer's `redemptionEndDate`, and a HARD CEILING on any coupon
 * expiry we send.
 *
 * The offer runs `couponExpiryType: EXPIRE_ON_VARIABLE_DATE_TIME`, which makes
 * `expiryDate` MANDATORY on every coupon — omitting it answers
 * `cannot set coupon expiry. missing expiryDate field.` and the guest's Add to
 * Wallet button silently bounces back with `?wallet=error` (live 2026-08-06,
 * every voucher without its own expiry). Sending one LATER than this answers
 * `expiry date cannot greater than the redemption end date`. So it is required
 * AND capped, and both failure modes are a 400 that looks like a broken button.
 *
 * Kept here beside the offer id because it belongs to that offer: change one in
 * the PassKit portal and this must move with it.
 */
export const PASSKIT_VOUCHER_EXPIRY_CEILING = "2027-08-04T03:59:59Z";

export const PASSKIT_VOUCHER: PassKitProject = {
  campaignId: "5ZmFoKJyWxD4kAFLr1uHoa",
  offerId: "4Al5xm9HjoqBZd5PUtE9Xr",
  templateId: "6HiVKEm5GaiU2AoBsGZqM8",
};

/**
 * Every program, keyed for the places that iterate (admin tooling, the template
 * scripts). Add new programs here AND as a named export above — the named export
 * is what feature code imports, so a rename is a compile error rather than a
 * silent lookup miss.
 */
export const PASSKIT_PROJECTS = {
  voucher: PASSKIT_VOUCHER,
} as const satisfies Record<string, PassKitProject>;

export type PassKitProgram = keyof typeof PASSKIT_PROJECTS;

/**
 * A MEMBER program — a different PassKit object family from the coupon chain
 * above, so it gets its own shape rather than being forced into
 * `PassKitProject`: members have a program + tiers and no offer.
 *
 * BILLING IS THE OPPOSITE WAY ROUND, and it is the thing to remember here.
 * A coupon bills ONCE at issuance; a member record bills EVERY MONTH it exists
 * (~$0.045). So a licence must stay opt-in — never auto-issued across the racer
 * table — and deleting a lapsed one actually stops the charge.
 */
export interface PassKitMemberProgram {
  /** Members program — the container. */
  programId: string;
  /** Tier a new member is enrolled into. */
  tierId: string;
  /** Pass design. `scripts/passkit-licence-pass.mts` owns its content. */
  templateId: string;
}

/**
 * FastTrax Racing Licence. One pass per racer, `externalId` = BMI personId.
 *
 * `externalId` is the personId and NOT a login code, deliberately: a racer holds
 * several codes (tags are append-only, ~one per visit) but exactly one identity,
 * and a duplicate externalId is refused with a 409 — which is what makes issuing
 * idempotent and stops a re-tap minting a second monthly-billed record.
 */
export const PASSKIT_LICENCE: PassKitMemberProgram = {
  programId: "4m1Y7wCXyloclQk0hqvjRS",
  tierId: "licence",
  templateId: "75paqKfII1FIn9kImwIvi2",
};
