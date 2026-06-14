import { sql, isDbConfigured } from "@ft/db";

/**
 * Guest Survey — survey-specific Neon data layer.
 *
 * Tables:
 *   guest_surveys             — one row per survey invitation sent (response payload + reward audit)
 *   guest_survey_questions    — the question pool, tagged by topic (bowling / food / racing / ...)
 *   guest_survey_promo_codes  — issued e-gift card promo codes + redemption tracking
 *
 * Cross-campaign tables (marketing_consent, marketing_touches) live in
 * marketing-db.ts and are bootstrapped independently.
 *
 * Schema is auto-bootstrapped on first write via `ensureGuestSurveySchema()`.
 *
 * ── Marketing vs transactional ────────────────────────────────────────
 * This is deliberately separate from sales_log (transactional) and
 * sms_log (delivery audit). Survey response data is *marketing
 * intelligence* and may grow large — keep it isolated.
 */

let schemaReady = false;

export async function ensureGuestSurveySchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();

  // ── guest_surveys ────────────────────────────────────────────────
  await q`
    CREATE TABLE IF NOT EXISTS guest_surveys (
      id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      token               TEXT        NOT NULL UNIQUE,
      square_customer_id  TEXT        NOT NULL,
      phone_e164          TEXT        NOT NULL,
      origin              TEXT        NOT NULL,            -- 'bowling' | 'racing'
      origin_ref          TEXT        NOT NULL,            -- qamf reservation id | vt3 match id
      center_code         TEXT        NOT NULL,
      visit_date          DATE        NOT NULL,
      context_json        JSONB       NOT NULL,            -- Square orders found + tag set
      questions_json      JSONB       NOT NULL,            -- exact question set shown
      responses_json      JSONB,                            -- null until submitted
      reward_kind         TEXT,                             -- 'gift_card' | 'pinz' | 'declined'
      reward_ref          TEXT,                             -- square gift_card id | loyalty event id | promo code
      reward_value        INTEGER,                          -- 500 (cents) or 500 (points)
      sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      opened_at           TIMESTAMPTZ,
      completed_at        TIMESTAMPTZ,
      expires_at          TIMESTAMPTZ NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS gs_customer_sent ON guest_surveys(square_customer_id, sent_at DESC)`;
  await q`CREATE UNIQUE INDEX IF NOT EXISTS gs_origin_ref ON guest_surveys(origin, origin_ref)`;

  // ── guest_survey_questions ───────────────────────────────────────
  // Tag values: 'baseline' | 'bowling' | 'fnb_service' | 'food_drink' |
  //             'gel_blaster' | 'arcade' | 'racing'
  // 'kind' values: 'rating_1_5' | 'multi' | 'text' | 'yes_no'
  //
  // Gating:
  //   gate_ordinal + gate_answer → "only show this question if the question
  //   at (tag, gate_ordinal) was answered gate_answer." Within-tag scope only.
  //   The picker still grabs all matching questions; the survey UI hides
  //   gated ones at render time until their gate is satisfied.
  //
  // Tag selection policy (authoritative copy lives in questions.ts):
  //   - baseline + closing are always included
  //   - For bowling visits: tags = [baseline, bowling, fnb_service, closing]
  //   - For racing visits:  tags = [baseline, racing, food_drink, closing]
  //                         (food_drink self-gates on its purchase Q1)
  //   - Max 4 tags per survey
  //   - No question-count cap; gating keeps the survey adaptive
  await q`
    CREATE TABLE IF NOT EXISTS guest_survey_questions (
      id           SERIAL      PRIMARY KEY,
      tag          TEXT        NOT NULL,
      ordinal      INTEGER     NOT NULL,
      question     TEXT        NOT NULL,
      kind         TEXT        NOT NULL,
      choices_json JSONB,
      gate_ordinal INTEGER,
      gate_answer  TEXT,
      active       BOOLEAN     NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Idempotent ALTERs for already-bootstrapped environments.
  await q`ALTER TABLE guest_survey_questions ADD COLUMN IF NOT EXISTS gate_ordinal INTEGER`;
  await q`ALTER TABLE guest_survey_questions ADD COLUMN IF NOT EXISTS gate_answer  TEXT`;
  await q`CREATE INDEX IF NOT EXISTS gsq_tag_active ON guest_survey_questions(tag, ordinal) WHERE active = TRUE`;
  // Uniqueness on (tag, ordinal) supports idempotent seeding (ON CONFLICT DO NOTHING).
  await q`CREATE UNIQUE INDEX IF NOT EXISTS gsq_tag_ordinal_uniq ON guest_survey_questions(tag, ordinal)`;

  // ── guest_survey_promo_codes ─────────────────────────────────────
  // Tracks issued e-gift card promo codes for survey rewards.
  // square_gift_card_id is the real Square Gift Card minted via /v2/gift-cards.
  // The 'GS-' prefix on `code` is the routing token the discount-line webhook
  // uses to recognize survey-funded gift card redemptions.
  await q`
    CREATE TABLE IF NOT EXISTS guest_survey_promo_codes (
      code                  TEXT        PRIMARY KEY,
      survey_id             UUID        NOT NULL REFERENCES guest_surveys(id),
      square_gift_card_id   TEXT        NOT NULL,
      square_gift_card_gan  TEXT        NOT NULL,
      amount_cents          INTEGER     NOT NULL,
      issued_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      redeemed_at           TIMESTAMPTZ,
      redeemed_order_id     TEXT
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS gspc_gift_card ON guest_survey_promo_codes(square_gift_card_id)`;
  await q`CREATE INDEX IF NOT EXISTS gspc_unredeemed ON guest_survey_promo_codes(survey_id) WHERE redeemed_at IS NULL`;

  schemaReady = true;
}

/**
 * Reset the schema-ready cache. Test-only — exported so vitest can force
 * a fresh bootstrap when running against a clean test schema.
 * @internal
 */
export function _resetGuestSurveySchemaCache(): void {
  schemaReady = false;
}

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export type SurveyOrigin = "bowling" | "racing";

export type SurveyRewardKind = "gift_card" | "pinz" | "declined";

export type SurveyQuestionKind = "rating_1_5" | "multi" | "text" | "yes_no";

export type SurveyQuestionTag =
  | "baseline"
  | "bowling"
  | "fnb_service"
  | "food_drink"
  | "gel_blaster"
  | "arcade"
  | "racing"
  // 'closing' tag: universal "wrap-up" questions shown at the END of every
  // survey regardless of visit type — Team Member Fist Bump + open
  // comments. The picker treats this as always-included and sorts it last
  // via TAG_PRIORITY, bypassing the alphabetical default.
  | "closing";

export interface GuestSurveyQuestion {
  id: number;
  tag: SurveyQuestionTag;
  ordinal: number;
  question: string;
  kind: SurveyQuestionKind;
  choices: string[] | null;
  /**
   * Gate ordinal — only show this question if the question at
   * (tag, gateOrdinal) was answered `gateAnswer`. Null = always shown.
   */
  gateOrdinal: number | null;
  /** Required answer value for the gate question. Null when ungated. */
  gateAnswer: string | null;
  active: boolean;
  createdAt: string;
}

export interface GuestSurveyRow {
  id: string;
  token: string;
  squareCustomerId: string;
  phoneE164: string;
  origin: SurveyOrigin;
  originRef: string;
  centerCode: string;
  visitDate: string; // YYYY-MM-DD
  context: Record<string, unknown>;
  questions: GuestSurveyQuestion[];
  responses: Record<string, unknown> | null;
  rewardKind: SurveyRewardKind | null;
  rewardRef: string | null;
  rewardValue: number | null;
  sentAt: string;
  openedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface GuestSurveyPromoCode {
  code: string;
  surveyId: string;
  squareGiftCardId: string;
  squareGiftCardGan: string;
  amountCents: number;
  issuedAt: string;
  redeemedAt: string | null;
  redeemedOrderId: string | null;
}

// ─────────────────────────────────────────────────────────────────
// Row mappers
// ─────────────────────────────────────────────────────────────────

function parseJsonb<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === "object") return raw as T;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function rowToSurvey(row: Record<string, unknown>): GuestSurveyRow {
  return {
    id: row.id as string,
    token: row.token as string,
    squareCustomerId: row.square_customer_id as string,
    phoneE164: row.phone_e164 as string,
    origin: row.origin as SurveyOrigin,
    originRef: row.origin_ref as string,
    centerCode: row.center_code as string,
    visitDate: (row.visit_date as Date).toISOString().slice(0, 10),
    context: parseJsonb<Record<string, unknown>>(row.context_json, {}),
    questions: parseJsonb<GuestSurveyQuestion[]>(row.questions_json, []),
    responses: row.responses_json
      ? parseJsonb<Record<string, unknown>>(row.responses_json, {})
      : null,
    rewardKind: (row.reward_kind as SurveyRewardKind) ?? null,
    rewardRef: (row.reward_ref as string) ?? null,
    rewardValue: (row.reward_value as number) ?? null,
    sentAt: (row.sent_at as Date).toISOString(),
    openedAt: row.opened_at ? (row.opened_at as Date).toISOString() : null,
    completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : null,
    expiresAt: (row.expires_at as Date).toISOString(),
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function rowToQuestion(row: Record<string, unknown>): GuestSurveyQuestion {
  return {
    id: row.id as number,
    tag: row.tag as SurveyQuestionTag,
    ordinal: row.ordinal as number,
    question: row.question as string,
    kind: row.kind as SurveyQuestionKind,
    choices: row.choices_json ? parseJsonb<string[]>(row.choices_json, []) : null,
    gateOrdinal: (row.gate_ordinal as number) ?? null,
    gateAnswer: (row.gate_answer as string) ?? null,
    active: row.active as boolean,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function rowToPromoCode(row: Record<string, unknown>): GuestSurveyPromoCode {
  return {
    code: row.code as string,
    surveyId: row.survey_id as string,
    squareGiftCardId: row.square_gift_card_id as string,
    squareGiftCardGan: row.square_gift_card_gan as string,
    amountCents: row.amount_cents as number,
    issuedAt: (row.issued_at as Date).toISOString(),
    redeemedAt: row.redeemed_at ? (row.redeemed_at as Date).toISOString() : null,
    redeemedOrderId: (row.redeemed_order_id as string) ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────
// guest_surveys helpers
// ─────────────────────────────────────────────────────────────────

export interface InsertGuestSurveyInput {
  token: string;
  squareCustomerId: string;
  phoneE164: string;
  origin: SurveyOrigin;
  originRef: string;
  centerCode: string;
  visitDate: string; // YYYY-MM-DD
  context: Record<string, unknown>;
  questions: GuestSurveyQuestion[];
  expiresAt: string; // ISO timestamp
}

export async function insertGuestSurvey(input: InsertGuestSurveyInput): Promise<GuestSurveyRow> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL not configured");
  await ensureGuestSurveySchema();
  const q = sql();
  const rows = await q`
    INSERT INTO guest_surveys (
      token, square_customer_id, phone_e164,
      origin, origin_ref, center_code, visit_date,
      context_json, questions_json, expires_at
    ) VALUES (
      ${input.token}, ${input.squareCustomerId}, ${input.phoneE164},
      ${input.origin}, ${input.originRef}, ${input.centerCode}, ${input.visitDate},
      ${JSON.stringify(input.context)}::jsonb,
      ${JSON.stringify(input.questions)}::jsonb,
      ${input.expiresAt}
    )
    RETURNING *
  `;
  return rowToSurvey(rows[0] as Record<string, unknown>);
}

/**
 * Hard-delete a guest_surveys row by token. Used as a rollback when an
 * SMS send fails after the row has been inserted — leaving the row in
 * place would (a) report a sent-at the customer never received, and
 * (b) block retries via the (origin, origin_ref) uniqueness constraint.
 *
 * Best-effort: callers wrap this in their own try/catch and log on
 * failure. Returns true if a row was deleted.
 */
export async function deleteGuestSurveyByToken(token: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensureGuestSurveySchema();
  const q = sql();
  const rows = await q`DELETE FROM guest_surveys WHERE token = ${token} RETURNING id`;
  return rows.length > 0;
}

/**
 * Hard-delete ALL guest_surveys rows for a phone. Test-only — used by the
 * admin debug endpoint to clear prior failed sends so a force-retry can
 * re-fire without colliding with the (origin, origin_ref) unique index.
 *
 * Cascades to guest_survey_promo_codes first (the table has a FK on
 * survey_id that would otherwise block the delete with 23503).
 *
 * Note: this does NOT touch the underlying Square gift cards. Any minted
 * card stays funded in Square; only the DB linkage is removed. That's the
 * right behavior for test cleanup but means operator must reconcile real
 * promo codes manually.
 *
 * Returns the count of guest_surveys rows deleted.
 */
export async function deleteGuestSurveysByPhone(phoneE164: string): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureGuestSurveySchema();
  const q = sql();
  // First drop dependent promo codes (FK guard).
  await q`
    DELETE FROM guest_survey_promo_codes
    WHERE survey_id IN (
      SELECT id FROM guest_surveys WHERE phone_e164 = ${phoneE164}
    )
  `;
  const rows = await q`
    DELETE FROM guest_surveys WHERE phone_e164 = ${phoneE164} RETURNING id
  `;
  return rows.length;
}

export async function getGuestSurveyByToken(token: string): Promise<GuestSurveyRow | null> {
  if (!isDbConfigured()) return null;
  await ensureGuestSurveySchema();
  const q = sql();
  const rows = await q`SELECT * FROM guest_surveys WHERE token = ${token} LIMIT 1`;
  return rows.length ? rowToSurvey(rows[0] as Record<string, unknown>) : null;
}

/**
 * Per-reservation survey snapshot used by the admin reservation list to
 * render a "Survey: sent / opened / completed" chip without forcing the
 * UI to know about every column on guest_surveys.
 */
export interface ReservationSurveySnapshot {
  token: string;
  /** Funnel stage. Derived from sent_at / opened_at / completed_at. */
  status: "sent" | "opened" | "completed";
  rewardKind: SurveyRewardKind | null;
  /** Cents (gift_card) or points (pinz). */
  rewardValue: number | null;
  sentAt: string;
  openedAt: string | null;
  completedAt: string | null;
  /** SMS body channel used for the send — 'sms' or 'email' fallback. */
  channel: "sms" | "email" | null;
}

/**
 * Bulk lookup: given a list of bowling reservation IDs, return a map
 * keyed by reservation_id → most-recent survey snapshot. Reservations
 * with no survey row are omitted from the map (caller treats absent
 * as "no survey sent yet").
 *
 * One query, indexed on (origin, origin_ref). Designed to be called
 * once per admin-reservations page render — no N+1.
 */
export async function getSurveysForReservations(
  reservationIds: Array<string | number>,
): Promise<Map<string, ReservationSurveySnapshot>> {
  const out = new Map<string, ReservationSurveySnapshot>();
  if (!isDbConfigured() || reservationIds.length === 0) return out;
  await ensureGuestSurveySchema();
  const q = sql();
  const stringIds = reservationIds.map((id) => String(id));
  // Latest survey per origin_ref (defensive — there should only ever be
  // one per (origin, origin_ref) thanks to the unique index, but JOIN
  // semantics make this clear).
  const rows = await q`
    SELECT origin_ref, token, reward_kind, reward_value,
           sent_at, opened_at, completed_at,
           context_json
    FROM guest_surveys
    WHERE origin = 'bowling'
      AND origin_ref = ANY(${stringIds}::text[])
  `;
  for (const r of rows as Record<string, unknown>[]) {
    const sentAt = (r.sent_at as Date).toISOString();
    const openedAt = r.opened_at ? (r.opened_at as Date).toISOString() : null;
    const completedAt = r.completed_at ? (r.completed_at as Date).toISOString() : null;
    const status: "sent" | "opened" | "completed" = completedAt
      ? "completed"
      : openedAt
        ? "opened"
        : "sent";
    const ctx = parseJsonb<Record<string, unknown>>(r.context_json, {});
    const channel = (ctx.channel as "sms" | "email" | undefined) ?? null;
    out.set(r.origin_ref as string, {
      token: r.token as string,
      status,
      rewardKind: (r.reward_kind as SurveyRewardKind) ?? null,
      rewardValue: (r.reward_value as number) ?? null,
      sentAt,
      openedAt,
      completedAt,
      channel,
    });
  }
  return out;
}

/**
 * Bulk lookup: given a list of normalized phone numbers, return the
 * set of phones that already have AT LEAST ONE guest_surveys row
 * (any origin). Used by the manual backfill to never send a second
 * survey to a phone that's already been surveyed.
 */
export async function getPhonesWithExistingSurveys(phones: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!isDbConfigured() || phones.length === 0) return out;
  await ensureGuestSurveySchema();
  const q = sql();
  const rows = await q`
    SELECT DISTINCT phone_e164 FROM guest_surveys
    WHERE phone_e164 = ANY(${phones}::text[])
  `;
  for (const r of rows as Array<{ phone_e164: string }>) out.add(r.phone_e164);
  return out;
}

export interface GuestSurveyListItem extends GuestSurveyRow {
  /** GS-XXXX promo code for gift-card rewards, null for Pinz/declined. */
  promoCode: string | null;
  /** Square gift card GAN for gift-card rewards, null otherwise. */
  promoCodeGan: string | null;
  /** Square Gift Card id (gftc:hex) for gift-card rewards, null otherwise. */
  promoCodeGiftCardId: string | null;
  /** Has the gift card been redeemed yet? */
  promoCodeRedeemedAt: string | null;
}

/**
 * List recent guest surveys with their gift-card promo codes joined.
 *
 * Read-only — no mutation. All filters are optional and ANDed.
 *
 * Filters:
 *   - since        Lower-bound on sent_at (ISO date or timestamp).
 *   - until        Upper-bound on sent_at (ISO date or timestamp; inclusive of the day).
 *   - centerCode   Exact-match filter.
 *   - origin       'bowling' | 'racing'.
 *   - tag          Survey must include this tag in context_json.tags.
 *   - rewardKind   Filter to surveys that issued this reward kind.
 *   - hasResponses Only rows where responses_json IS NOT NULL (= submitted).
 *   - hasReward    Only rows where reward_kind IS NOT NULL.
 *   - completedOnly Alias of hasResponses (kept for back-compat).
 *   - limit / offset for pagination. Defaults limit=50 (max 500), offset=0.
 */
export interface ListGuestSurveysOpts {
  since?: string | null;
  until?: string | null;
  centerCode?: string | null;
  origin?: SurveyOrigin | null;
  tag?: SurveyQuestionTag | string | null;
  rewardKind?: SurveyRewardKind | null;
  hasResponses?: boolean | null;
  hasReward?: boolean | null;
  /** E.164 phone (exact match). Use to pull one customer's history. */
  phoneE164?: string | null;
  /** Square customer id (exact match). Same purpose, different key. */
  squareCustomerId?: string | null;
  /** @deprecated use hasResponses */
  completedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function listGuestSurveys(opts: ListGuestSurveysOpts): Promise<GuestSurveyListItem[]> {
  if (!isDbConfigured()) return [];
  await ensureGuestSurveySchema();
  const q = sql();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const completedOnly = opts.hasResponses ?? opts.completedOnly ?? false;
  // Each filter is ` ? IS NULL OR <predicate>` so optional filters drop in
  // cleanly without dynamic SQL string concat. The `tag` filter uses
  // jsonb `@>` containment against the {tags:[…]} array.
  const rows = await q`
    SELECT
      s.*,
      p.code                  AS promo_code,
      p.square_gift_card_id   AS promo_gift_card_id,
      p.square_gift_card_gan  AS promo_gan,
      p.redeemed_at           AS promo_redeemed_at
    FROM guest_surveys s
    LEFT JOIN guest_survey_promo_codes p ON p.survey_id = s.id
    WHERE (${opts.since ?? null}::timestamptz IS NULL OR s.sent_at >= ${opts.since ?? null}::timestamptz)
      AND (${opts.until ?? null}::timestamptz IS NULL OR s.sent_at <= ${opts.until ?? null}::timestamptz)
      AND (${opts.centerCode ?? null}::text IS NULL OR s.center_code = ${opts.centerCode ?? null})
      AND (${opts.origin ?? null}::text IS NULL OR s.origin = ${opts.origin ?? null})
      AND (${opts.rewardKind ?? null}::text IS NULL OR s.reward_kind = ${opts.rewardKind ?? null})
      AND (${opts.phoneE164 ?? null}::text IS NULL OR s.phone_e164 = ${opts.phoneE164 ?? null})
      AND (${opts.squareCustomerId ?? null}::text IS NULL OR s.square_customer_id = ${opts.squareCustomerId ?? null})
      AND (${opts.tag ?? null}::text IS NULL OR s.context_json @> jsonb_build_object('tags', jsonb_build_array(${opts.tag ?? null}::text)))
      AND (${completedOnly ? "true" : "false"}::boolean = false OR s.completed_at IS NOT NULL)
      AND (${opts.hasReward ? "true" : "false"}::boolean = false OR s.reward_kind IS NOT NULL)
    ORDER BY s.sent_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return (rows as Record<string, unknown>[]).map((row) => {
    const base = rowToSurvey(row);
    return {
      ...base,
      promoCode: (row.promo_code as string) ?? null,
      promoCodeGiftCardId: (row.promo_gift_card_id as string) ?? null,
      promoCodeGan: (row.promo_gan as string) ?? null,
      promoCodeRedeemedAt: row.promo_redeemed_at
        ? (row.promo_redeemed_at as Date).toISOString()
        : null,
    };
  });
}

/**
 * Aggregate stats for the dashboard: funnel counts, reward breakdown,
 * per-tag completion, daily time series. All filters mirror
 * listGuestSurveys (date range, centerCode, origin, tag).
 *
 * Returns ONE row of summary numbers (no pagination).
 */
export interface GuestSurveyStats {
  window: { since: string | null; until: string | null };
  filters: { centerCode: string | null; origin: SurveyOrigin | null; tag: string | null };
  funnel: {
    sent: number;
    opened: number;
    completed: number;
    openRate: number;
    completionRate: number;
  };
  rewards: {
    pinz: number;
    gift_card: number;
    declined: number;
    issued: number; // pinz + gift_card
    redeemed: number; // gift cards with redeemed_at set
  };
  byTag: Array<{ tag: string; sent: number; completed: number }>;
  byDay: Array<{ day: string; sent: number; opened: number; completed: number }>;
  byCenter: Array<{ centerCode: string; sent: number; completed: number }>;
}

export async function getGuestSurveyStats(opts: {
  since?: string | null;
  until?: string | null;
  centerCode?: string | null;
  origin?: SurveyOrigin | null;
  tag?: string | null;
}): Promise<GuestSurveyStats> {
  const empty: GuestSurveyStats = {
    window: { since: opts.since ?? null, until: opts.until ?? null },
    filters: {
      centerCode: opts.centerCode ?? null,
      origin: opts.origin ?? null,
      tag: opts.tag ?? null,
    },
    funnel: { sent: 0, opened: 0, completed: 0, openRate: 0, completionRate: 0 },
    rewards: { pinz: 0, gift_card: 0, declined: 0, issued: 0, redeemed: 0 },
    byTag: [],
    byDay: [],
    byCenter: [],
  };
  if (!isDbConfigured()) return empty;
  await ensureGuestSurveySchema();
  const q = sql();

  // Funnel + reward counters in ONE pass using FILTER aggregates.
  const funnelRows = await q`
    SELECT
      COUNT(*)::int                                                                AS sent,
      COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int                           AS opened,
      COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int                        AS completed,
      COUNT(*) FILTER (WHERE reward_kind = 'pinz')::int                            AS reward_pinz,
      COUNT(*) FILTER (WHERE reward_kind = 'gift_card')::int                       AS reward_gift_card,
      COUNT(*) FILTER (WHERE reward_kind = 'declined')::int                        AS reward_declined
    FROM guest_surveys s
    WHERE (${opts.since ?? null}::timestamptz IS NULL OR s.sent_at >= ${opts.since ?? null}::timestamptz)
      AND (${opts.until ?? null}::timestamptz IS NULL OR s.sent_at <= ${opts.until ?? null}::timestamptz)
      AND (${opts.centerCode ?? null}::text IS NULL OR s.center_code = ${opts.centerCode ?? null})
      AND (${opts.origin ?? null}::text IS NULL OR s.origin = ${opts.origin ?? null})
      AND (${opts.tag ?? null}::text IS NULL OR s.context_json @> jsonb_build_object('tags', jsonb_build_array(${opts.tag ?? null}::text)))
  `;
  const f = funnelRows[0] as Record<string, number>;

  const redeemedRows = await q`
    SELECT COUNT(DISTINCT p.code)::int AS redeemed
    FROM guest_survey_promo_codes p
    JOIN guest_surveys s ON s.id = p.survey_id
    WHERE p.redeemed_at IS NOT NULL
      AND (${opts.since ?? null}::timestamptz IS NULL OR s.sent_at >= ${opts.since ?? null}::timestamptz)
      AND (${opts.until ?? null}::timestamptz IS NULL OR s.sent_at <= ${opts.until ?? null}::timestamptz)
      AND (${opts.centerCode ?? null}::text IS NULL OR s.center_code = ${opts.centerCode ?? null})
      AND (${opts.origin ?? null}::text IS NULL OR s.origin = ${opts.origin ?? null})
  `;
  const redeemed = (redeemedRows[0] as { redeemed: number }).redeemed;

  // By-tag: unnest the context_json.tags array and group.
  const tagRows = await q`
    SELECT
      tag::text                                                              AS tag,
      COUNT(*)::int                                                          AS sent,
      COUNT(*) FILTER (WHERE s.completed_at IS NOT NULL)::int                AS completed
    FROM guest_surveys s,
         jsonb_array_elements_text(s.context_json -> 'tags') AS tag
    WHERE (${opts.since ?? null}::timestamptz IS NULL OR s.sent_at >= ${opts.since ?? null}::timestamptz)
      AND (${opts.until ?? null}::timestamptz IS NULL OR s.sent_at <= ${opts.until ?? null}::timestamptz)
      AND (${opts.centerCode ?? null}::text IS NULL OR s.center_code = ${opts.centerCode ?? null})
      AND (${opts.origin ?? null}::text IS NULL OR s.origin = ${opts.origin ?? null})
    GROUP BY tag
    ORDER BY sent DESC
  `;

  // By-day: group by sent_at::date in America/New_York.
  const dayRows = await q`
    SELECT
      (s.sent_at AT TIME ZONE 'America/New_York')::date::text                AS day,
      COUNT(*)::int                                                          AS sent,
      COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int                     AS opened,
      COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int                  AS completed
    FROM guest_surveys s
    WHERE (${opts.since ?? null}::timestamptz IS NULL OR s.sent_at >= ${opts.since ?? null}::timestamptz)
      AND (${opts.until ?? null}::timestamptz IS NULL OR s.sent_at <= ${opts.until ?? null}::timestamptz)
      AND (${opts.centerCode ?? null}::text IS NULL OR s.center_code = ${opts.centerCode ?? null})
      AND (${opts.origin ?? null}::text IS NULL OR s.origin = ${opts.origin ?? null})
      AND (${opts.tag ?? null}::text IS NULL OR s.context_json @> jsonb_build_object('tags', jsonb_build_array(${opts.tag ?? null}::text)))
    GROUP BY day
    ORDER BY day ASC
  `;

  // By-center: useful when no center filter applied.
  const centerRows = await q`
    SELECT
      s.center_code                                                          AS center_code,
      COUNT(*)::int                                                          AS sent,
      COUNT(*) FILTER (WHERE s.completed_at IS NOT NULL)::int                AS completed
    FROM guest_surveys s
    WHERE (${opts.since ?? null}::timestamptz IS NULL OR s.sent_at >= ${opts.since ?? null}::timestamptz)
      AND (${opts.until ?? null}::timestamptz IS NULL OR s.sent_at <= ${opts.until ?? null}::timestamptz)
      AND (${opts.origin ?? null}::text IS NULL OR s.origin = ${opts.origin ?? null})
      AND (${opts.tag ?? null}::text IS NULL OR s.context_json @> jsonb_build_object('tags', jsonb_build_array(${opts.tag ?? null}::text)))
    GROUP BY s.center_code
    ORDER BY sent DESC
  `;

  const sent = f.sent ?? 0;
  const opened = f.opened ?? 0;
  const completed = f.completed ?? 0;
  return {
    window: { since: opts.since ?? null, until: opts.until ?? null },
    filters: {
      centerCode: opts.centerCode ?? null,
      origin: opts.origin ?? null,
      tag: opts.tag ?? null,
    },
    funnel: {
      sent,
      opened,
      completed,
      openRate: sent ? +(opened / sent).toFixed(4) : 0,
      completionRate: sent ? +(completed / sent).toFixed(4) : 0,
    },
    rewards: {
      pinz: f.reward_pinz ?? 0,
      gift_card: f.reward_gift_card ?? 0,
      declined: f.reward_declined ?? 0,
      issued: (f.reward_pinz ?? 0) + (f.reward_gift_card ?? 0),
      redeemed,
    },
    byTag: (tagRows as Array<{ tag: string; sent: number; completed: number }>).map((r) => ({
      tag: r.tag,
      sent: r.sent,
      completed: r.completed,
    })),
    byDay: (dayRows as Array<{ day: string; sent: number; opened: number; completed: number }>).map(
      (r) => ({ day: r.day, sent: r.sent, opened: r.opened, completed: r.completed }),
    ),
    byCenter: (centerRows as Array<{ center_code: string; sent: number; completed: number }>).map(
      (r) => ({ centerCode: r.center_code, sent: r.sent, completed: r.completed }),
    ),
  };
}

/**
 * Per-question response distribution. For rating_1_5 + yes_no + multi
 * questions, returns the histogram of answers. Open-text questions
 * return a count + the most-recent N answers (for spot-checking, not
 * full export — the list endpoint covers that with format=csv).
 */
export interface QuestionStat {
  questionId: number;
  tag: string;
  ordinal: number;
  question: string;
  kind: SurveyQuestionKind;
  totalAnswered: number;
  /** Histogram for rating_1_5 / yes_no / multi. Empty for text. */
  distribution: Record<string, number>;
  /** Numeric mean for rating_1_5 only. null otherwise. */
  averageRating: number | null;
  /** For 'text' questions: a sample of recent answers (max 25). */
  recentTextAnswers: string[];
}

export async function getQuestionStats(opts: {
  since?: string | null;
  until?: string | null;
  centerCode?: string | null;
  origin?: SurveyOrigin | null;
}): Promise<QuestionStat[]> {
  if (!isDbConfigured()) return [];
  await ensureGuestSurveySchema();
  const q = sql();
  // Pull the question pool (active OR referenced).
  const questions = await q`
    SELECT id, tag, ordinal, question, kind FROM guest_survey_questions
    WHERE active = TRUE
    ORDER BY tag, ordinal
  `;
  // Pull completed survey responses in the window.
  const surveyRows = await q`
    SELECT responses_json
    FROM guest_surveys s
    WHERE s.completed_at IS NOT NULL
      AND (${opts.since ?? null}::timestamptz IS NULL OR s.sent_at >= ${opts.since ?? null}::timestamptz)
      AND (${opts.until ?? null}::timestamptz IS NULL OR s.sent_at <= ${opts.until ?? null}::timestamptz)
      AND (${opts.centerCode ?? null}::text IS NULL OR s.center_code = ${opts.centerCode ?? null})
      AND (${opts.origin ?? null}::text IS NULL OR s.origin = ${opts.origin ?? null})
    ORDER BY s.completed_at DESC
  `;

  // Aggregate per-question in memory.
  const stats = new Map<number, QuestionStat>();
  for (const qRow of questions as Array<Record<string, unknown>>) {
    stats.set(qRow.id as number, {
      questionId: qRow.id as number,
      tag: qRow.tag as string,
      ordinal: qRow.ordinal as number,
      question: qRow.question as string,
      kind: qRow.kind as SurveyQuestionKind,
      totalAnswered: 0,
      distribution: {},
      averageRating: null,
      recentTextAnswers: [],
    });
  }

  const ratingSums = new Map<number, { sum: number; count: number }>();

  for (const sRow of surveyRows as Array<Record<string, unknown>>) {
    const responses = parseJsonb<Record<string, unknown>>(sRow.responses_json, {});
    for (const [keyStr, answerRaw] of Object.entries(responses)) {
      const qid = Number(keyStr);
      if (!Number.isFinite(qid)) continue;
      const stat = stats.get(qid);
      if (!stat) continue;
      if (answerRaw == null || answerRaw === "") continue;
      stat.totalAnswered++;
      const answer = typeof answerRaw === "string" ? answerRaw : String(answerRaw);
      if (stat.kind === "rating_1_5") {
        const n = Number(answer);
        if (Number.isFinite(n)) {
          const bucket = ratingSums.get(qid) ?? { sum: 0, count: 0 };
          bucket.sum += n;
          bucket.count += 1;
          ratingSums.set(qid, bucket);
        }
        stat.distribution[answer] = (stat.distribution[answer] ?? 0) + 1;
      } else if (stat.kind === "yes_no" || stat.kind === "multi") {
        stat.distribution[answer] = (stat.distribution[answer] ?? 0) + 1;
      } else if (stat.kind === "text") {
        if (stat.recentTextAnswers.length < 25) {
          stat.recentTextAnswers.push(answer);
        }
      }
    }
  }

  for (const [qid, bucket] of ratingSums) {
    const stat = stats.get(qid);
    if (stat && bucket.count > 0) {
      stat.averageRating = +(bucket.sum / bucket.count).toFixed(3);
    }
  }

  return Array.from(stats.values());
}

/**
 * Merge a partial patch into `context_json` for a survey identified by
 * token. Used by the SMS→email fallback path to stamp the channel that
 * actually delivered, so the admin chip can show "via email".
 */
export async function updateGuestSurveyContext(opts: {
  token: string;
  patch: Record<string, unknown>;
}): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureGuestSurveySchema();
  const q = sql();
  // jsonb || jsonb merges keys; right-hand wins on collision.
  await q`
    UPDATE guest_surveys
    SET context_json = COALESCE(context_json, '{}'::jsonb) || ${JSON.stringify(opts.patch)}::jsonb
    WHERE token = ${opts.token}
  `;
}

export async function getGuestSurveyByOriginRef(opts: {
  origin: SurveyOrigin;
  originRef: string;
}): Promise<GuestSurveyRow | null> {
  if (!isDbConfigured()) return null;
  await ensureGuestSurveySchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM guest_surveys
    WHERE origin = ${opts.origin} AND origin_ref = ${opts.originRef}
    LIMIT 1
  `;
  return rows.length ? rowToSurvey(rows[0] as Record<string, unknown>) : null;
}

/**
 * Stamp opened_at on first GET (idempotent — second call is a no-op).
 */
export async function markGuestSurveyOpened(token: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureGuestSurveySchema();
  const q = sql();
  await q`
    UPDATE guest_surveys
    SET opened_at = NOW()
    WHERE token = ${token} AND opened_at IS NULL
  `;
}

export async function saveGuestSurveyResponses(opts: {
  token: string;
  responses: Record<string, unknown>;
}): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureGuestSurveySchema();
  const q = sql();
  await q`
    UPDATE guest_surveys
    SET responses_json = ${JSON.stringify(opts.responses)}::jsonb,
        completed_at   = COALESCE(completed_at, NOW())
    WHERE token = ${opts.token}
  `;
}

export async function saveGuestSurveyReward(opts: {
  token: string;
  rewardKind: SurveyRewardKind;
  rewardRef: string;
  rewardValue: number;
}): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureGuestSurveySchema();
  const q = sql();
  await q`
    UPDATE guest_surveys
    SET reward_kind  = ${opts.rewardKind},
        reward_ref   = ${opts.rewardRef},
        reward_value = ${opts.rewardValue}
    WHERE token = ${opts.token}
  `;
}

// ─────────────────────────────────────────────────────────────────
// guest_survey_questions helpers
// ─────────────────────────────────────────────────────────────────

/**
 * Get active questions filtered to the given tags, ordered by tag then
 * ordinal. Caller is responsible for capping the final list.
 */
export async function getActiveQuestionsForTags(
  tags: SurveyQuestionTag[],
): Promise<GuestSurveyQuestion[]> {
  if (!isDbConfigured()) return [];
  if (tags.length === 0) return [];
  await ensureGuestSurveySchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM guest_survey_questions
    WHERE active = TRUE
      AND tag = ANY(${tags as string[]})
    ORDER BY tag, ordinal, id
  `;
  return rows.map((r) => rowToQuestion(r as Record<string, unknown>));
}

/**
 * Insert a question. Tests + admin UI use this; the seed script uses it too.
 */
export async function insertGuestSurveyQuestion(input: {
  tag: SurveyQuestionTag;
  ordinal: number;
  question: string;
  kind: SurveyQuestionKind;
  choices?: string[] | null;
  gateOrdinal?: number | null;
  gateAnswer?: string | null;
  active?: boolean;
}): Promise<GuestSurveyQuestion> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL not configured");
  await ensureGuestSurveySchema();
  const q = sql();
  const rows = await q`
    INSERT INTO guest_survey_questions
      (tag, ordinal, question, kind, choices_json, gate_ordinal, gate_answer, active)
    VALUES (
      ${input.tag},
      ${input.ordinal},
      ${input.question},
      ${input.kind},
      ${input.choices ? JSON.stringify(input.choices) : null}::jsonb,
      ${input.gateOrdinal ?? null},
      ${input.gateAnswer ?? null},
      ${input.active ?? true}
    )
    RETURNING *
  `;
  return rowToQuestion(rows[0] as Record<string, unknown>);
}

/**
 * Canonical seed for guest_survey_questions.
 *
 * Idempotent: only inserts if the table is empty. Future edits should
 * happen via the admin UI (PR-GS6) so the seed doesn't overwrite manual
 * changes. Tests can force a fresh seed by `_resetGuestSurveySchemaCache()`
 * + truncating the table.
 *
 * Returns the number of rows inserted (0 if table was already populated).
 */
/**
 * Sync the prod questions table to match the in-code GUEST_SURVEY_QUESTIONS_SEED.
 *
 * Unlike `seedGuestSurveyQuestionsIfEmpty` (which only runs against an empty
 * table), this is the *destructive update* path used by the admin sync
 * endpoint when the seed constant has been edited:
 *
 *   - Upserts every (tag, ordinal) tuple in the current seed, OVERWRITING
 *     question text / kind / choices / gating fields and setting active=TRUE.
 *   - Deactivates any (tag, ordinal) currently in the DB that is NOT in the
 *     current seed — soft delete via active=FALSE so historical responses
 *     keep their foreign key.
 *
 * Returns counts for ops visibility.
 */
export async function syncGuestSurveyQuestions(): Promise<{
  upserted: number;
  deactivated: number;
}> {
  if (!isDbConfigured()) return { upserted: 0, deactivated: 0 };
  await ensureGuestSurveySchema();
  const q = sql();

  let upserted = 0;
  for (const row of GUEST_SURVEY_QUESTIONS_SEED) {
    await q`
      INSERT INTO guest_survey_questions
        (tag, ordinal, question, kind, choices_json, gate_ordinal, gate_answer, active)
      VALUES (
        ${row.tag},
        ${row.ordinal},
        ${row.question},
        ${row.kind},
        ${row.choices ? JSON.stringify(row.choices) : null}::jsonb,
        ${row.gateOrdinal ?? null},
        ${row.gateAnswer ?? null},
        TRUE
      )
      ON CONFLICT (tag, ordinal) DO UPDATE SET
        question     = EXCLUDED.question,
        kind         = EXCLUDED.kind,
        choices_json = EXCLUDED.choices_json,
        gate_ordinal = EXCLUDED.gate_ordinal,
        gate_answer  = EXCLUDED.gate_answer,
        active       = TRUE
    `;
    upserted += 1;
  }

  // Deactivate any (tag, ordinal) not in the current seed.
  // Build the "keep" list as parallel arrays so we can ANY/ANY-compare.
  const keepTags = GUEST_SURVEY_QUESTIONS_SEED.map((r) => r.tag);
  const keepOrdinals = GUEST_SURVEY_QUESTIONS_SEED.map((r) => r.ordinal);
  const deactivated = await q`
    UPDATE guest_survey_questions
    SET active = FALSE
    WHERE active = TRUE
      AND (tag, ordinal) NOT IN (
        SELECT UNNEST(${keepTags}::text[]) AS tag, UNNEST(${keepOrdinals}::int[]) AS ordinal
      )
    RETURNING id
  `;

  return { upserted, deactivated: deactivated.length };
}

export async function seedGuestSurveyQuestionsIfEmpty(): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureGuestSurveySchema();
  const q = sql();
  const existing = await q`SELECT COUNT(*)::int AS count FROM guest_survey_questions`;
  if ((existing[0] as { count: number }).count > 0) return 0;

  for (const row of GUEST_SURVEY_QUESTIONS_SEED) {
    await q`
      INSERT INTO guest_survey_questions
        (tag, ordinal, question, kind, choices_json, gate_ordinal, gate_answer, active)
      VALUES (
        ${row.tag},
        ${row.ordinal},
        ${row.question},
        ${row.kind},
        ${row.choices ? JSON.stringify(row.choices) : null}::jsonb,
        ${row.gateOrdinal ?? null},
        ${row.gateAnswer ?? null},
        TRUE
      )
      ON CONFLICT (tag, ordinal) DO NOTHING
    `;
  }
  return GUEST_SURVEY_QUESTIONS_SEED.length;
}

interface SeedQuestion {
  tag: SurveyQuestionTag;
  ordinal: number;
  question: string;
  kind: SurveyQuestionKind;
  choices?: string[];
  gateOrdinal?: number;
  gateAnswer?: string;
}

/**
 * Canonical question pool. Mirrors the user-approved seed dated 2026-05-20.
 * Exported for tests + admin tooling.
 *
 * Picker policy (authoritative copy in questions.ts):
 *   - bowling visits  → tags = [baseline, bowling, fnb_service, closing]
 *   - racing visits   → tags = [baseline, racing, food_drink, closing]
 *   - max 4 tags total; no question-count cap (gating keeps length adaptive)
 */
export const GUEST_SURVEY_QUESTIONS_SEED: SeedQuestion[] = [
  // ── baseline ────────────────────────────────────────────────────
  { tag: "baseline", ordinal: 1, question: "How was your visit overall?", kind: "rating_1_5" },
  {
    tag: "baseline",
    ordinal: 2,
    question: "Would you recommend us to a friend?",
    kind: "yes_no",
  },

  // ── bowling ─────────────────────────────────────────────────────
  // (Ordinal 3 "Did your lane open on time?" was removed 2026-05-20.)
  {
    tag: "bowling",
    ordinal: 1,
    question: "How was the bowling experience?",
    kind: "rating_1_5",
  },
  {
    tag: "bowling",
    ordinal: 2,
    question: "How was the cleanliness of your bowling area?",
    kind: "multi",
    choices: ["Spotless", "Clean", "OK", "Could be better", "Dirty"],
  },

  // ── fnb_service ─────────────────────────────────────────────────
  // Q1 is the gate; Q2-5 are conditional on Q1 = "Yes".
  // Q6 (manager check) is independent — always shown.
  {
    tag: "fnb_service",
    ordinal: 1,
    question: "Did you have a server at your lane?",
    kind: "yes_no",
  },
  {
    tag: "fnb_service",
    ordinal: 2,
    question: "How quickly did your server first check on you?",
    kind: "multi",
    choices: ["Within 1-2 minutes", "Within 3-5 minutes", "5+ minutes"],
    gateOrdinal: 1,
    gateAnswer: "Yes",
  },
  {
    tag: "fnb_service",
    ordinal: 3,
    question:
      "Did your server offer additional food or drinks without you having to flag them down?",
    kind: "yes_no",
    gateOrdinal: 1,
    gateAnswer: "Yes",
  },
  {
    tag: "fnb_service",
    ordinal: 4,
    question: "Did your server suggest any specials, promotions, or add-ons?",
    kind: "yes_no",
    gateOrdinal: 1,
    gateAnswer: "Yes",
  },
  {
    tag: "fnb_service",
    ordinal: 5,
    question:
      "Did your server check back after delivering your food to make sure everything was correct?",
    kind: "yes_no",
    gateOrdinal: 1,
    gateAnswer: "Yes",
  },
  {
    tag: "fnb_service",
    ordinal: 6,
    question: "Did a manager check on you during your visit?",
    kind: "yes_no",
  },

  // ── food_drink (racing-only tag — self-contained food + service) ──
  // Used ONLY by racing surveys (bowling uses fnb_service instead — see
  // the racing tag policy in questions.ts). Q1 is the
  // purchase gate: a racer who bought nothing answers "No" and skips
  // straight to the manager-check (Q7, independent). The service +
  // manager-check questions mirror the HeadPinz fnb_service set so
  // racing food gets the same scrutiny as bowling lane service.
  {
    tag: "food_drink",
    ordinal: 1,
    question: "Did you purchase any food or drinks during your visit?",
    kind: "yes_no",
  },
  {
    tag: "food_drink",
    ordinal: 2,
    question: "Rate the food & drinks",
    kind: "rating_1_5",
    gateOrdinal: 1,
    gateAnswer: "Yes",
  },
  {
    tag: "food_drink",
    ordinal: 3,
    question: "How fast was your order ready?",
    kind: "multi",
    choices: ["Very fast", "Fast", "OK", "Slow", "Very slow"],
    gateOrdinal: 1,
    gateAnswer: "Yes",
  },
  {
    tag: "food_drink",
    ordinal: 4,
    question: "Was your order correct?",
    kind: "yes_no",
    gateOrdinal: 1,
    gateAnswer: "Yes",
  },
  {
    tag: "food_drink",
    ordinal: 5,
    question: "Did a team member offer more food or drinks without you having to flag them down?",
    kind: "yes_no",
    gateOrdinal: 1,
    gateAnswer: "Yes",
  },
  {
    // Independent (no gate) — a manager may check on a racer whether or
    // not they bought food, exactly like the bowling fnb_service Q6.
    tag: "food_drink",
    ordinal: 6,
    question: "Did a manager check on you during your visit?",
    kind: "yes_no",
  },

  // ── gel_blaster ─────────────────────────────────────────────────
  { tag: "gel_blaster", ordinal: 1, question: "How was Gel Blaster?", kind: "rating_1_5" },
  {
    tag: "gel_blaster",
    ordinal: 2,
    question: "How did the game length feel?",
    kind: "multi",
    choices: ["Too short", "Just right", "Too long"],
  },

  // ── arcade ──────────────────────────────────────────────────────
  { tag: "arcade", ordinal: 1, question: "How was the arcade?", kind: "rating_1_5" },
  {
    tag: "arcade",
    ordinal: 2,
    question: "How were the games?",
    kind: "multi",
    choices: ["All worked", "Most worked", "Some broken", "Many broken"],
  },

  // ── racing ──────────────────────────────────────────────────────
  // Ordered by moment, likes grouped: the race itself (1-5: experience →
  // crew → the on-track slow-down chain) then arrival / Guest Services
  // (6-8). The slow-down chain is gated: understand (Q4, only if Q3=Yes)
  // → SmartKart explainer (Q5, only if Q4=No), so the explanation is
  // shown ONLY to racers who said they didn't understand the slow-down.
  { tag: "racing", ordinal: 1, question: "How was your racing experience?", kind: "rating_1_5" },
  {
    tag: "racing",
    ordinal: 2,
    question: "How were our karting team members (track crew)?",
    kind: "rating_1_5",
  },
  {
    tag: "racing",
    ordinal: 3,
    question: "Did you experience a slow-down during your race?",
    kind: "yes_no",
  },
  {
    tag: "racing",
    ordinal: 4,
    question: "Did you understand why your kart slowed down?",
    kind: "yes_no",
    gateOrdinal: 3,
    gateAnswer: "Yes",
  },
  {
    tag: "racing",
    ordinal: 5,
    question:
      "Good to know: our SmartKart system slows ONLY a kart near a spin-out, while everyone else keeps racing - most tracks slow the whole field. For a full red-flag stop, we credit your time back. Does that make sense now?",
    kind: "yes_no",
    gateOrdinal: 4,
    gateAnswer: "No",
  },
  {
    tag: "racing",
    ordinal: 6,
    question: "How was our Guest Services team that greeted you upstairs?",
    kind: "rating_1_5",
  },
  {
    tag: "racing",
    ordinal: 7,
    question: "Did you book a reservation in advance?",
    kind: "yes_no",
  },
  {
    tag: "racing",
    ordinal: 8,
    question: "After booking at the front desk, how long until you got on track?",
    kind: "multi",
    choices: ["Under 15 min", "15-30 min", "30-45 min", "45+ min"],
    gateOrdinal: 7,
    gateAnswer: "No",
  },

  // ── closing (universal — always rendered last) ──────────────────
  {
    tag: "closing",
    ordinal: 1,
    question:
      "Team Member Fist Bump — do you know the name of a team member who made your visit exceptional?",
    kind: "text",
  },
  {
    tag: "closing",
    ordinal: 2,
    question: "Anything else you'd like to share?",
    kind: "text",
  },
];

// ─────────────────────────────────────────────────────────────────
// guest_survey_promo_codes helpers
// ─────────────────────────────────────────────────────────────────

export async function insertGuestSurveyPromoCode(input: {
  code: string;
  surveyId: string;
  squareGiftCardId: string;
  squareGiftCardGan: string;
  amountCents: number;
}): Promise<GuestSurveyPromoCode> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL not configured");
  await ensureGuestSurveySchema();
  const q = sql();
  const rows = await q`
    INSERT INTO guest_survey_promo_codes
      (code, survey_id, square_gift_card_id, square_gift_card_gan, amount_cents)
    VALUES
      (${input.code}, ${input.surveyId}, ${input.squareGiftCardId}, ${input.squareGiftCardGan}, ${input.amountCents})
    RETURNING *
  `;
  return rowToPromoCode(rows[0] as Record<string, unknown>);
}

export async function getPromoCodeByCode(code: string): Promise<GuestSurveyPromoCode | null> {
  if (!isDbConfigured()) return null;
  await ensureGuestSurveySchema();
  const q = sql();
  const rows = await q`SELECT * FROM guest_survey_promo_codes WHERE code = ${code} LIMIT 1`;
  return rows.length ? rowToPromoCode(rows[0] as Record<string, unknown>) : null;
}

export async function getPromoCodeByGiftCardId(
  giftCardId: string,
): Promise<GuestSurveyPromoCode | null> {
  if (!isDbConfigured()) return null;
  await ensureGuestSurveySchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM guest_survey_promo_codes
    WHERE square_gift_card_id = ${giftCardId}
    LIMIT 1
  `;
  return rows.length ? rowToPromoCode(rows[0] as Record<string, unknown>) : null;
}

export async function markPromoCodeRedeemed(opts: {
  code: string;
  redeemedOrderId: string;
}): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureGuestSurveySchema();
  const q = sql();
  await q`
    UPDATE guest_survey_promo_codes
    SET redeemed_at = NOW(), redeemed_order_id = ${opts.redeemedOrderId}
    WHERE code = ${opts.code} AND redeemed_at IS NULL
  `;
}
