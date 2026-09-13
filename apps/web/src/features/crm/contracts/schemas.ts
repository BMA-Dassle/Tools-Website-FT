/**
 * Zod shapes for `/api/admin/crm/contracts/**`. Clamped like every other admin
 * input: the token that guards `/api/admin/*` is a shared credential, so a body
 * is hostile input, not something only a director can produce.
 *
 * Every action takes its quote from the URL's `shortId`, never from the body —
 * a body that could name a different contract than the one the router matched
 * is a confused-deputy waiting to happen.
 */

import { z } from "zod";
import { CENTRE_CODES } from "../core/centres";
import { CONTRACT_STATUS_FILTERS, CONTRACTS_PAGE_MAX, type ContractWindow } from "./contracts";

const Flag = z.enum(["1", "0", "true", "false"]);

/**
 * Spelled out rather than derived: `z.enum` wants a literal tuple, and casting
 * `CONTRACT_WINDOWS` into one throws the literal types away, which would make
 * `input.win` a bare `string` and force a cast at every call site. The
 * `satisfies` keeps the two lists honest — drop a window from one and this
 * stops compiling.
 */
export const CONTRACT_WINDOW_VALUES = [
  "attention",
  "7",
  "30",
  "90",
  "past",
  "all",
] as const satisfies readonly ContractWindow[];

/** `contract_short_id` is a short base62 key minted by the dispatch cron. */
export const ShortIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{4,32}$/, "expected a contract short id");

export const ContractsListQuerySchema = z.object({
  win: z.enum(CONTRACT_WINDOW_VALUES).optional(),
  status: z.enum(CONTRACT_STATUS_FILTERS).optional(),
  centre: z.enum(CENTRE_CODES).optional(),
  /** A `crm_reps` slug; resolved to the planner's email server-side. */
  rep: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{1,31}$/)
    .optional(),
  q: z.string().trim().max(80).optional(),
  /** Show completed / cancelled / denied / expired too. */
  closed: Flag.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(CONTRACTS_PAGE_MAX).optional(),
  /** Counts only — the sidebar badge poll. No rows, no COUNT over the page. */
  counts: Flag.optional(),
});

export type ContractsListQuery = z.infer<typeof ContractsListQuerySchema>;

export const ContractDetailQuerySchema = z.object({
  /** Live Square read; its own request so the tab can load without it. */
  payments: Flag.optional(),
  history: Flag.optional(),
  /** Live BMI public notes for the guest preview; its own request, same reason. */
  notes: Flag.optional(),
});

export type ContractDetailQuery = z.infer<typeof ContractDetailQuerySchema>;

/** POST …/approve — the memo the approve sheet asks for when a warning stands. */
export const ApproveBodySchema = z.object({
  memo: z.string().trim().max(1000).optional().nullable(),
});

/** POST …/deny — the reason is sent to the planner, so it is required. */
export const DenyBodySchema = z.object({
  reason: z.string().trim().min(3).max(1000),
});

/** POST …/resend — same link, same version; the note lands on the timeline. */
export const ResendBodySchema = z.object({
  note: z.string().trim().max(500).optional().nullable(),
});

/** POST …/remind — one rule key from `group-event-rules`. */
export const RemindBodySchema = z.object({
  ruleKey: z
    .string()
    .trim()
    .regex(/^[a-z0-9_:-]{2,64}$/i, "expected a reminder rule key"),
});

/** POST …/charge-balance and …/send-balance-link. */
export const ChargeBalanceBodySchema = z.object({
  reason: z.string().trim().max(200).optional().nullable(),
});

/** POST …/backfill-dayof takes nothing but the short id. */
export const EmptyBodySchema = z.object({});

/** POST …/cancel — a reason for accounting plus an optional note. */
export const CANCEL_REASONS = [
  "Guest cancelled",
  "Booked elsewhere",
  "Weather / closure",
  "Duplicate",
] as const;

export const CancelBodySchema = z.object({
  reason: z.enum(CANCEL_REASONS),
  note: z.string().trim().max(1000).optional().nullable(),
});

export type ApproveBody = z.infer<typeof ApproveBodySchema>;
export type DenyBody = z.infer<typeof DenyBodySchema>;
export type ResendBody = z.infer<typeof ResendBodySchema>;
export type RemindBody = z.infer<typeof RemindBodySchema>;
export type ChargeBalanceBody = z.infer<typeof ChargeBalanceBodySchema>;
export type CancelBody = z.infer<typeof CancelBodySchema>;
