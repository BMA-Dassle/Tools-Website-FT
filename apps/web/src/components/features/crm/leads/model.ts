import { daysOut } from "~/features/crm/core/dates";
import type { CrmStatus, EventType } from "~/features/crm/core/types";
import {
  NEEDS_EMAIL_OR_TIME,
  type BmiResponsibleSyncOutcome,
  type LeadView,
} from "~/features/crm/leads/contracts";
import { DOW } from "../primitives/DateBlock";
import { formatMinutes } from "../primitives/Timer";

/**
 * Pure helpers behind the lead cards and the deal (ported from
 * `crm-shared.js`: `leadName`, `leadTitle`, `dueLabel`, `bmiChip`, `typeIcon`,
 * `stepIndex`, `urgency`). Tested; no hooks, no fetch.
 */

export function leadName(l: Pick<LeadView, "guest">): string {
  return `${l.guest.first} ${l.guest.last}`.trim() || "Guest";
}

/** The company when there is one, else the guest. */
export function leadTitle(l: Pick<LeadView, "guest">): string {
  return l.guest.company || leadName(l);
}

export interface DueLabel {
  t: string;
  k: "" | "warn" | "crit";
}

/** `dueLabel(iso)` from crm-shared.js:79. */
export function dueLabel(dueIso: string, now: Date): DueLabel {
  const m = Math.round((new Date(dueIso).getTime() - now.getTime()) / 60_000);
  if (m < -1440) return { t: `Overdue ${Math.floor(-m / 1440)} d`, k: "crit" };
  if (m < 0) return { t: `Overdue ${formatMinutes(-m)}`, k: "crit" };
  if (m < 120) return { t: `Due in ${formatMinutes(m)}`, k: "warn" };
  if (m < 1440) return { t: "Due today", k: "" };
  return { t: `Due ${DOW[new Date(dueIso).getDay()]}`, k: "" };
}

export function isOpen(status: CrmStatus | undefined): boolean {
  return !status || status.kind === "open";
}

/** The card tint: `overdue` (crit) / `due` (warn) / "" — only while the lead is open. */
export function cardUrgency(
  l: LeadView,
  status: CrmStatus | undefined,
  now: Date,
): "" | "due" | "overdue" {
  if (!l.nextAction || !isOpen(status)) return "";
  const k = dueLabel(l.nextAction.due, now).k;
  return k === "crit" ? "overdue" : k === "warn" ? "due" : "";
}

export type TypeIcon = "building" | "gift" | "users" | "star" | "flag" | "calendar";

/** `typeIcon(t)` from crm-shared.js:209 — the semantic key; `TypeGlyph` draws it. */
export function typeIcon(t: EventType): TypeIcon {
  switch (t) {
    case "corporate":
      return "building";
    case "birthday":
    case "holiday":
      return "gift";
    case "team":
      return "users";
    case "school":
      return "star";
    case "fundraiser":
      return "flag";
    default:
      return "calendar";
  }
}

export const STEPS: readonly (readonly [string, string])[] = [
  ["assigned", "Assigned"],
  ["contacted", "Contacted"],
  ["quote", "Quote"],
  ["contract", "Contract"],
  ["deposit", "Booked"],
];

const STEP_INDEX: Record<string, number> = {
  new: 0,
  assigned: 0,
  contacted: 1,
  waiting: 2,
  quote: 2,
  contract: 3,
  deposit: 4,
  confirmed: 4,
  lost: -1,
  noresp: -1,
};

/** `stepIndex(st)` from crm-shared.js:289; an unknown status sits on step 0. */
export function stepIndex(status: string): number {
  return STEP_INDEX[status] ?? 0;
}

export interface BmiChipSpec {
  label: string;
  /** `bmi` = the outlined chip; the others map to Chip `kind`. */
  kind: "bmi" | "lost" | "warn" | "open";
  title: string;
}

/**
 * Does the BMI chip TELL A PLANNER ANYTHING on this card?
 *
 * Owner, 2026-09-14, of the pipeline tiles: "I still think you can do better
 * with these tiles." Every card in the "Pending Quote" column wore a chip
 * reading "BMI · Pending Quote" — a whole line repeating the column header it
 * was already sitting under, twenty times down a column. Repeated on every
 * card, it stopped being read at all.
 *
 * So the chip earns its line only when Office DISAGREES with the column: a
 * card in Assigned whose project still says New Lead, or one in Contract sent
 * that Office never moved. That is the case a planner has to act on, and it is
 * now the only case that draws a chip — which makes seeing one mean something.
 *
 * Compared on the LABEL rather than the state id, because the two sides are
 * mapped per tenant and the director may rename a status; matching the words
 * on screen is what makes "Pending Quote" under "Pending Quote" disappear
 * however it was configured. Normalised the same way the KPI buckets normalise
 * Office names, so "Deposit Requested (HPFM)" matches "Deposit Requested".
 */
export function bmiChipIsRedundant(l: LeadView, statusLabel: string | null | undefined): boolean {
  // Only a real, minted project can be redundant. "not minted", "creating…"
  // and "needs email & time" are always worth saying.
  if (!l.bmi.projectId || !statusLabel) return false;
  const state = normaliseChipText(l.bmi.stateName);
  if (!state) return false;
  return state === normaliseChipText(statusLabel);
}

function normaliseChipText(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * `bmiChip(l)` from crm-shared.js:204, plus the two states the CRM knows and
 * the prototype did not: minting in progress, and "needs email / time".
 */
export function bmiChip(l: LeadView): BmiChipSpec {
  if (l.bmi.projectId) {
    return {
      label: `BMI · ${l.bmi.stateName ?? "New Lead"}`,
      kind: "bmi",
      title: `BMI Office state · project ${l.bmi.projectNumber ?? l.bmi.projectId}`,
    };
  }
  if (l.isProspect) {
    return {
      label: "Prospect · no BMI yet",
      kind: "bmi",
      title: "Prospect — a BMI project is created when they show interest",
    };
  }
  if (l.mintStatus === "pending") {
    return { label: "BMI · creating…", kind: "open", title: "The BMI project is being created" };
  }
  if (l.mintStatus === "none" && l.mintError === NEEDS_EMAIL_OR_TIME) {
    return {
      label: "BMI · needs email & time",
      kind: "warn",
      title:
        "Pandora requires an email and an event time — complete the lead to create the project",
    };
  }
  return {
    label: "BMI · not minted",
    kind: "lost",
    title:
      "Every real lead should have a BMI project — this one failed to mint and is queued for retry",
  };
}

/** Days from ET today to the event. */
export function daysOutOf(l: Pick<LeadView, "eventDate">, now: Date): number {
  return daysOut(l.eventDate, now);
}

/** The toast after a hand-off, with what happened in BMI (crm-shared.js:242 wording, made truthful). */
export function assignToastText(
  firstName: string,
  bmi: BmiResponsibleSyncOutcome,
): { text: string; kind: "ok" | "warn" } {
  switch (bmi.status) {
    case "synced":
      return { text: `Assigned to ${firstName} · BMI responsible updated`, kind: "ok" };
    case "failed":
      return { text: `Assigned to ${firstName} · BMI responsible queued for retry`, kind: "warn" };
    case "paused":
      return { text: `Assigned to ${firstName} · BMI writes are paused`, kind: "warn" };
    case "no_project":
      return { text: `Assigned to ${firstName} · no BMI project yet`, kind: "ok" };
    case "no_bmi_user":
      return { text: `Assigned to ${firstName} · no Office user for them`, kind: "warn" };
    default:
      return { text: `Assigned to ${firstName}`, kind: "ok" };
  }
}

/** `rel(iso)` from crm-shared.js:78. */
export function relativeAge(iso: string, now: Date): string {
  const m = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / 1440)} d ago`;
}

/** `tel:` / `sms:` / `mailto:` targets for the rail buttons; null when the guest has none. */
export function contactHrefs(l: Pick<LeadView, "guest">): {
  tel: string | null;
  sms: string | null;
  mailto: string | null;
} {
  return {
    tel: l.guest.phone ? `tel:${l.guest.phone}` : null,
    sms: l.guest.phone ? `sms:${l.guest.phone}` : null,
    mailto: l.guest.email ? `mailto:${l.guest.email}` : null,
  };
}
