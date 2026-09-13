/**
 * `createTestQuote` — a real `pending_approval` contract, made on purpose, so
 * the approve / deny path can be smoked without waiting for a live post-paid
 * booking (brief §5.8 blocker (b); no test quote exists at any centre).
 *
 * SHIPPED AS A COMMITTED MODULE, not a probe script (R14): it runs through
 * `POST /api/admin/crm/jobs/run {kind:"seed-test-quote"}`, which is
 * director-only, so nothing about it lives outside the repo or outside the
 * gate.
 *
 * SAFETY, because previews share PRODUCTION Neon:
 *   - `guestEmail` is REQUIRED and must be supplied by the person running it.
 *     Approving sends a real contract email; there is no default address and
 *     there never will be.
 *   - the phone is fixed to the `2395551234` test number and cannot be
 *     overridden.
 *   - the row is marked in every human-visible field — "CRM TEST — ignore" —
 *     and carries no BMI project, so no Office write can ever touch a guest's
 *     reservation from it (the notes rail fails, is caught, and says so).
 *   - `bmi_reservation_id` is a `crm-test-…` sentinel, never a project id, so
 *     `getGfQuoteByReservationId` on a real project can never return it.
 *
 * What it deliberately does NOT do: move a BMI state, mint anything in Office
 * or Pandora, or create a Square order. It is a contract row for the approval
 * flow, and it says so.
 */

import { randomBytes } from "crypto";
import { isDbConfigured, sql } from "@ft/db";
import { HERMES_CENTER_MAP } from "@/lib/hermes-client";
import { CENTRES, isCentreCode } from "../../core/centres";
import { shiftYmd, todayEasternYmd } from "../../core/dates";
import type { CentreCode } from "../../core/types";
import { ensureGfSchema, getGfQuoteByShortId, type GroupFunctionQuote } from "../transport";
import { ContractActionError } from "./actions";

/** The one phone number a test row may carry. */
export const TEST_PHONE = "2395551234";
export const TEST_MARKER = "CRM TEST — ignore";

/** `center_code` → the hermes centre row that carries brand, base url and GAN prefix. */
function centerInfoFor(centre: CentreCode) {
  const centerCode = CENTRES[centre].centerCode;
  const info = Object.values(HERMES_CENTER_MAP).find((c) => c.centerCode === centerCode);
  if (!info) throw new ContractActionError(400, "unknown_centre");
  return info;
}

export interface CreateTestQuoteInput {
  centre: CentreCode;
  /** The director's own mailbox, or another they control. No default. */
  guestEmail: string;
  actor: string;
  /** Days from today for the event date; default 21. */
  daysOut?: number;
  now?: Date;
}

export interface CreateTestQuoteResult {
  shortId: string;
  quoteId: string;
  centre: CentreCode;
  eventDate: string;
  guestEmail: string;
  totalCents: number;
  guestUrl: string;
}

const TOTAL_CENTS = 164_000;

export async function createTestQuote(input: CreateTestQuoteInput): Promise<CreateTestQuoteResult> {
  if (!isDbConfigured()) throw new ContractActionError(503, "database_not_configured");
  if (!isCentreCode(input.centre)) throw new ContractActionError(400, "unknown_centre");
  const guestEmail = (input.guestEmail ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guestEmail)) {
    throw new ContractActionError(400, "guest_email_required");
  }

  await ensureGfSchema();
  const now = input.now ?? new Date();
  const centre = CENTRES[input.centre];
  const info = centerInfoFor(input.centre);
  const eventDate = shiftYmd(todayEasternYmd(now), input.daysOut ?? 21);
  const shortId = randomBytes(4).toString("hex");
  const sentinel = `crm-test-${shortId}`;

  const q = sql();
  const rows = (await q`
    INSERT INTO group_function_quotes (
      bmi_reservation_id, hermes_center, center_code, center_name, square_location_id,
      brand, base_url, gan_prefix,
      planner_email, guest_first_name, guest_last_name, guest_email, guest_phone,
      event_name, event_number, event_date, event_date_display, guest_count, notes,
      total_cents, tax_cents, deposit_due_cents, balance_cents,
      line_items, prior_payments,
      contract_short_id, approval_required, is_tax_exempt,
      hermes_last_processed_at, status
    ) VALUES (
      ${sentinel}, ${sentinel}, ${centre.centerCode}, ${centre.name}, ${info.squareLocationId},
      ${info.brand}, ${info.baseUrl}, ${info.ganPrefix},
      ${input.actor.toLowerCase()}, 'CRM', 'Test', ${guestEmail}, ${TEST_PHONE},
      ${TEST_MARKER}, ${`TEST-${shortId.toUpperCase()}`}, ${eventDate}, ${TEST_MARKER},
      ${20}, ${`${TEST_MARKER} — created from the CRM by ${input.actor} to smoke the approval flow. Safe to deny or leave.`},
      ${TOTAL_CENTS}, ${0}, ${0}, ${TOTAL_CENTS},
      ${JSON.stringify([{ name: `${TEST_MARKER} — post-paid package`, price: 82, qty: 20, total: 1640 }])},
      ${JSON.stringify([])},
      ${shortId}, TRUE, FALSE,
      NOW(), 'pending_approval'
    )
    RETURNING id
  `) as { id: number }[];

  const created = rows[0];
  if (!created) throw new ContractActionError(500, "test_quote_insert_failed");

  console.log(
    `[crm] test quote created short_id=${shortId} centre=${input.centre} actor_email=${input.actor}`,
  );

  return {
    shortId,
    quoteId: String(created.id),
    centre: input.centre,
    eventDate,
    guestEmail,
    totalCents: TOTAL_CENTS,
    guestUrl: `${info.baseUrl}/contract/${shortId}`,
  };
}

/** The job payload `POST /jobs/run {kind:"seed-test-quote"}` accepts. */
export async function runSeedTestQuoteJob(
  payload: Record<string, unknown>,
  actorEmail: string | null,
): Promise<CreateTestQuoteResult> {
  const centre = payload.centre;
  if (!isCentreCode(centre)) throw new ContractActionError(400, "unknown_centre");
  const guestEmail = typeof payload.guestEmail === "string" ? payload.guestEmail : "";
  const actor = actorEmail ?? "system";
  const daysOut = typeof payload.daysOut === "number" ? payload.daysOut : undefined;
  return createTestQuote({ centre, guestEmail, actor, daysOut });
}

/** Read a test quote back — used by the job result and by the smoke checklist. */
export async function getTestQuote(shortId: string): Promise<GroupFunctionQuote | null> {
  return getGfQuoteByShortId(shortId);
}
