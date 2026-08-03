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
