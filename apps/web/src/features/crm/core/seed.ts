/**
 * The idempotent seed (brief §3.8 "Seeds"). Every insert is `ON CONFLICT DO
 * NOTHING` or `WHERE NOT EXISTS` — bar the reps row, whose conflict arm only
 * HEALS a NULL `bmi_user_id` / `bmi_username` / `seven_shifts_user_id` from the
 * seed (`seedReps`) — so running it twice writes nothing the second time and a
 * director's later edits are never overwritten. It runs lazily from
 * `ensureCrmSchema()` when `crm_reps` is empty and on demand via
 * `POST /api/admin/crm/jobs/run {kind:"seed"}`.
 *
 * SOURCES, all committed code — nothing typed from memory:
 *   reps         crm-data.js:17-23 (slugs, names, initials, centres, roles)
 *                + lib/sales-lead-config.ts PLANNERS (E.164 phones, Teams chat
 *                ids, mailboxes) + daily-events/constants.ts USER_NAMES (Office
 *                user ids: Kelsea 28267036, Lori 465247, Stephanie 465242,
 *                Guest Services 30080112, Jacob 7251049, Eric 75262).
 *                `bmi_username` is the exact Office display name — the
 *                substring Pandora's `agent` matches and the KPI fallback key.
 *                + 7shifts user ids, probed live by the B2 rules PR on
 *                2026-09-13 and matched by name (Kelsea 10832991, Lori 6568770
 *                — 7shifts lists her as "Lori Coates-Lehman" — Stephanie
 *                8204948). Guest Services has no 7shifts user; mkt / jacob /
 *                eric need none. Production was seeded before these were known,
 *                so `seedReps` heals the three live rows.
 *   logins       one row per mailbox the SSO may present, lowercased.
 *   statuses     crm-data.js:44-55; `on_board` false for the five statuses the
 *                board folds into Booked / Closed (direction-b.html:67).
 *   rules        crm-data.js:33-41 (R1..R7).
 *   templates    crm-data.js:375-382 (T-1..T-6).
 *   settings     core/settings.ts SETTINGS_SEED.
 *
 * SEVEN rep rows, not six: Eric gets his own director row (`slug='eric'`,
 * charter "Decisions already made"). Jacob's Office id is 7251049 (USER_NAMES
 * "7251049": "Jacob Elliott") — unknown when production was first seeded, so
 * the live row carried NULL until the owner confirmed it on 2026-09-13; the
 * reps upsert heals that row rather than needing a hand edit (`seedReps`).
 * Marketing Director (`mkt`, a hold row) has no mailbox pending D13.
 *
 * The prototype's DIDs `(239) 555-01xx` are placeholders and are NOT seeded:
 * `vox_did` / `threecx_extension` stay NULL until C1/C3 assign real numbers.
 */

import { PLANNERS, GUEST_SERVICES_CHAT_ID } from "@/lib/sales-lead-config";
import { seedSettings } from "./data/settings-db";
import { SETTINGS_SEED } from "./settings";
import type { CentreCode, CrmStatusInput, RepRole } from "./types";
import { ensureRepsSchema, seedRepLogins, seedReps, type RepSeed } from "~/features/crm/reps";
import { seedStatuses } from "~/features/crm/statuses";
import { seedRules, type RuleSeed } from "~/features/crm/rules";
import { seedTemplates, type TemplateSeed } from "~/features/crm/collateral";

const ALL_CENTRES: CentreCode[] = ["HPFM", "FT", "HPN"];

export const REP_SEED: readonly RepSeed[] = [
  {
    slug: "kelsea",
    displayName: "Kelsea Kosco",
    firstName: "Kelsea",
    initials: "KK",
    role: "rep",
    email: PLANNERS.kelsea.email.toLowerCase(),
    bmiUserId: "28267036",
    bmiUsername: "Kelsea Kosco",
    sevenShiftsUserId: 10832991,
    teamsChatId: PLANNERS.kelsea.teamsChatId,
    phoneE164: PLANNERS.kelsea.phone,
    centres: ALL_CENTRES,
    sortOrder: 10,
  },
  {
    slug: "lori",
    displayName: "Lori Lehman",
    firstName: "Lori",
    initials: "LL",
    role: "rep",
    email: PLANNERS.lori.email.toLowerCase(),
    bmiUserId: "465247",
    bmiUsername: "Lori Lehman",
    sevenShiftsUserId: 6568770, // 7shifts lists her as "Lori Coates-Lehman"
    teamsChatId: PLANNERS.lori.teamsChatId,
    phoneE164: PLANNERS.lori.phone,
    centres: ALL_CENTRES,
    sortOrder: 20,
  },
  {
    slug: "stephanie",
    displayName: "Stephanie Wegman",
    firstName: "Stephanie",
    initials: "SW",
    role: "rep",
    email: PLANNERS.stephanie.email.toLowerCase(),
    bmiUserId: "465242",
    bmiUsername: "Stephanie Wegman",
    sevenShiftsUserId: 8204948,
    teamsChatId: PLANNERS.stephanie.teamsChatId,
    phoneE164: PLANNERS.stephanie.phone,
    centres: ALL_CENTRES,
    sortOrder: 30,
  },
  {
    slug: "gs",
    displayName: "Guest Services",
    firstName: "Guest Services",
    initials: "GS",
    role: "bucket",
    email: "guestservices@headpinz.com",
    bmiUserId: "30080112",
    bmiUsername: "Guest Services",
    sevenShiftsUserId: null,
    teamsChatId: GUEST_SERVICES_CHAT_ID,
    phoneE164: null,
    centres: ALL_CENTRES,
    sortOrder: 40,
  },
  {
    slug: "mkt",
    displayName: "Marketing Director",
    firstName: "Marketing",
    initials: "MD",
    role: "hold",
    email: null,
    bmiUserId: null,
    bmiUsername: null,
    sevenShiftsUserId: null,
    teamsChatId: null,
    phoneE164: null,
    centres: ALL_CENTRES,
    sortOrder: 50,
  },
  {
    slug: "jacob",
    displayName: "Jacob",
    firstName: "Jacob",
    initials: "J",
    role: "director",
    email: "jacob@headpinz.com",
    bmiUserId: "7251049",
    bmiUsername: "Jacob Elliott",
    sevenShiftsUserId: null,
    teamsChatId: null,
    phoneE164: null,
    centres: ALL_CENTRES,
    sortOrder: 60,
  },
  {
    slug: "eric",
    displayName: "Eric Osborn",
    firstName: "Eric",
    initials: "EO",
    role: "director",
    email: "eric@headpinz.com",
    bmiUserId: "75262",
    bmiUsername: "Eric Osborn",
    sevenShiftsUserId: null,
    teamsChatId: null,
    phoneE164: null,
    centres: ALL_CENTRES,
    sortOrder: 70,
  },
];

/** login email → rep slug. Lowercased on write. */
export const LOGIN_SEED: ReadonlyArray<{ email: string; slug: string }> = [
  { email: "kelsea@headpinz.com", slug: "kelsea" },
  { email: "lori@headpinz.com", slug: "lori" },
  { email: "stephanie@headpinz.com", slug: "stephanie" },
  { email: "guestservices@headpinz.com", slug: "gs" },
  { email: "jacob@headpinz.com", slug: "jacob" },
  { email: "eric@headpinz.com", slug: "eric" },
];

/** The five statuses the board folds into synthetic Booked / Closed columns. */
export const OFF_BOARD_STATUS_IDS: readonly string[] = [
  "new",
  "deposit",
  "confirmed",
  "lost",
  "noresp",
];

const STATUS_ROWS: readonly Omit<CrmStatusInput, "onBoard">[] = [
  {
    id: "new",
    label: "New",
    kind: "open",
    position: 1,
    slaLabel: "1 h to first touch",
    slaHours: 1,
  },
  {
    id: "assigned",
    label: "Assigned",
    kind: "open",
    position: 2,
    slaLabel: "1 h to first touch",
    slaHours: 1,
  },
  {
    id: "contacted",
    label: "Contacted",
    kind: "open",
    position: 3,
    slaLabel: "48 h to next touch",
    slaHours: 48,
  },
  {
    id: "waiting",
    label: "Waiting on guest",
    kind: "open",
    position: 4,
    slaLabel: "72 h then nudge",
    slaHours: 72,
  },
  {
    id: "quote",
    label: "Quote sent",
    kind: "open",
    position: 5,
    slaLabel: "48 h follow-up",
    slaHours: 48,
  },
  {
    id: "contract",
    label: "Contract sent",
    kind: "open",
    position: 6,
    slaLabel: "Auto 96 h reminder",
    slaHours: 96,
  },
  {
    id: "deposit",
    label: "Deposit paid",
    kind: "won",
    position: 7,
    slaLabel: null,
    slaHours: null,
  },
  { id: "confirmed", label: "Confirmed", kind: "won", position: 8, slaLabel: null, slaHours: null },
  { id: "lost", label: "Lost", kind: "lost", position: 9, slaLabel: null, slaHours: null },
  {
    id: "noresp",
    label: "No response",
    kind: "lost",
    position: 10,
    slaLabel: "After 3 touches",
    slaHours: null,
  },
];

export const STATUS_SEED: readonly CrmStatusInput[] = STATUS_ROWS.map((s) => ({
  ...s,
  onBoard: !OFF_BOARD_STATUS_IDS.includes(s.id),
}));

export const RULE_SEED: readonly RuleSeed[] = [
  {
    position: 1,
    kind: "hold",
    label: "Big groups go to Marketing",
    when: { guestsMin: 100 },
    then: { hold: "mkt" },
    why: "Marketing Director holds any lead of 100+ guests",
  },
  {
    position: 2,
    kind: "route",
    label: "Kids' birthdays to Guest Services",
    when: { type: "birthday", kids: true },
    then: { route: "gs" },
    why: "The call center books children's parties",
  },
  {
    position: 3,
    kind: "route",
    label: "School and youth groups to Guest Services when under 40",
    when: { type: "school", guestsMax: 39 },
    then: { route: "gs" },
    why: "Small youth groups are handled like parties",
  },
  {
    position: 4,
    kind: "avail",
    label: "Skip anyone marked off today",
    when: {},
    then: { skipOff: true },
    why: "Off-day reps never receive new leads",
  },
  {
    position: 5,
    kind: "avail",
    label: "Prefer whoever is on shift now, then the next shift",
    when: {},
    then: { onShift: true },
    why: "A lead should reach someone who can act on it",
  },
  {
    position: 6,
    kind: "standard",
    label: "Lowest volume for the party's month",
    when: {},
    then: { standard: true },
    why: "Balance by guests already in open leads for that month; tie → fewest leads",
  },
  {
    position: 7,
    kind: "fallback",
    // Renamed 2026-09-13: the rules assign at capture, so nothing "waits 60
    // minutes, then auto" any more. The old label is healed in place by
    // `seedRules` so production does not gain a second fallback rule.
    label: "Otherwise park it for Jacob",
    when: {},
    then: { queue: true },
    why: "Nothing matched; it sits on the queue board until a director assigns it, and the safety-net sweep re-checks the rules",
    previousLabels: ["Otherwise wait for Jacob (60 min, then auto)"],
  },
];

export const TEMPLATE_SEED: readonly TemplateSeed[] = [
  {
    position: 1,
    kind: "sms",
    name: "New lead — first text",
    body: "Hi {{guest.first}}, it's {{rep.first}} at {{centre.short}}! Got your request for {{event.date}}. Do you have 10 minutes today to talk through options?",
  },
  {
    position: 2,
    kind: "sms",
    name: "Quote nudge (48 h)",
    body: "Hi {{guest.first}} — checking in on the {{event.date}} quote. Anything I can adjust? I'm holding your lanes until {{hold.until}}.",
  },
  {
    position: 3,
    kind: "sms",
    name: "Contract reminder",
    body: "Hi {{guest.first}}, your {{centre.short}} contract is ready to sign: {{contract.link}}. Takes about 3 minutes. Text me with any questions!",
  },
  {
    position: 4,
    kind: "email",
    name: "First-touch email with pricing",
    subject: "{{centre.name}} — {{event.type}} on {{event.date}}",
    body: "Hi {{guest.first}},\n\nGreat to connect! Attached is our 2026 group pricing for {{centre.name}}. For {{event.guests}} guests on {{event.date}} I'd suggest…",
  },
  {
    position: 5,
    kind: "email",
    name: "Same time last year",
    subject: "Ready for round two at {{centre.short}}?",
    body: "Hi {{guest.first}},\n\nIt's almost a year since {{lastYear.date}} — we'd love to host {{account.name}} again. I can hold {{event.date}} for you this week…",
  },
  {
    position: 6,
    kind: "email",
    name: "Quote follow-up",
    subject: "RE: Quote — {{event.date}}",
    body: "Hi {{guest.first}}, following up on the quote I sent {{quote.sentAgo}}. Happy to adjust the headcount or menu…",
  },
];

export interface SeedCounts {
  /** Rep rows inserted OR healed — `seedReps` fills a NULL Office / 7shifts id on an existing row. */
  reps: number;
  logins: number;
  statuses: number;
  rules: number;
  templates: number;
  settings: number;
}

/** Insert whatever is missing (heal what `seedReps` may); return how many rows each step wrote. */
export async function runSeed(): Promise<SeedCounts> {
  await ensureRepsSchema();
  const reps = await seedReps(REP_SEED);
  const logins = await seedRepLogins(LOGIN_SEED);
  const statuses = await seedStatuses(STATUS_SEED);
  const rules = await seedRules(RULE_SEED);
  const templates = await seedTemplates(TEMPLATE_SEED);
  const settings = await seedSettings(SETTINGS_SEED);
  const counts = { reps, logins, statuses, rules, templates, settings };
  console.log("[crm] seed", counts);
  return counts;
}

/** Type guard for the roles the seed uses (documentation for readers of REP_SEED). */
export const SEEDED_REP_ROLES: readonly RepRole[] = ["rep", "bucket", "hold", "director"];
