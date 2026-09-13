/**
 * WHICH BMI BRANCH A STATUS CHANGE TAKES — pure, so the decision is testable
 * without an Office wire, and so the UI can pre-declare the branch before a
 * rep drags anything (the brief's B4 smoke: "read `crm_status_bmi_map` for the
 * test project's centre and write down which branch applies").
 *
 * The five branches, in the order they are checked:
 *
 *   no_project  the lead has never been minted — nothing in Office to move.
 *   unmapped    the status has no `crm_status_bmi_map` row for this tenant.
 *               New Lead / Contacted / Quote / Deposit Requested are UNKNOWN
 *               per centre until a director confirms them on the Statuses
 *               screen (brief §1.8), so this is the normal state of affairs on
 *               day one, not an error: Neon moves, Office does not, and the
 *               deal wears a `bmi_sync_pending` chip that says why.
 *   paused      `CRM_BMI_WRITES` / the per-centre list / the director's Neon
 *               toggle (R4 — a missing row means ON).
 *   builtin     the mapped state id is NEGATIVE (`-3` Confirmation, `-4`
 *               Cancelled). Those are Pandora-first rails with their own
 *               proof-by-re-read; `-4` is the CONTRACTS PR's cancel path
 *               (B5) and is deliberately NOT written from a board drag — a
 *               cancellation is an action with consequences for money, not a
 *               card moving one column right.
 *   write       a custom (positive) state id: Office is written and verified.
 *
 * `bmi_sync_pending` in the brief is a CHIP, not a column: every branch but
 * `write` leaves `crm_leads.bmi_state_id` untouched, and the chip is derived
 * from the outcome the route returns plus the lead row itself.
 */

import type { StatusBmiMapRow } from "../../core/types";

export type BmiStateBranch = "write" | "unmapped" | "paused" | "no_project" | "builtin";

export interface BmiStateBranchInput {
  /** `crm_leads.bmi.projectId` — null until the lead is minted. */
  projectId: string | null;
  /** The `crm_status_bmi_map` row for (status, tenant), or null when unmapped. */
  mapping: StatusBmiMapRow | null;
  /** `bmiWritesAllowedFor(clientKey, setting)`. */
  writesAllowed: boolean;
}

export function bmiStateBranch(input: BmiStateBranchInput): BmiStateBranch {
  if (!input.projectId) return "no_project";
  if (!input.mapping) return "unmapped";
  if (!input.writesAllowed) return "paused";
  return isBuiltInStateId(input.mapping.bmiStateId) ? "builtin" : "write";
}

/** Office's built-in states are negative ids (`-3` Confirmation, `-4` Cancelled). */
export function isBuiltInStateId(stateId: string): boolean {
  return stateId.trim().startsWith("-");
}

export type BmiStateSyncStatus = BmiStateBranch | "pending";

/** What the deal and the board say about the BMI side of a status change. */
export interface BmiStateSyncOutcome {
  status: BmiStateSyncStatus;
  /** The state we tried to write (null when no branch wrote). */
  stateId: string | null;
  stateName: string | null;
  error?: string;
}

/** The chip a lead wears after a transition — label, tone and the "why". */
export interface BmiSyncChip {
  label: string;
  kind: "bmi" | "warn" | "lost" | "open";
  title: string;
}

/**
 * One sentence per branch, so nobody has to guess what happened in Office.
 * Copy lives here (not in a component) because the board, the deal header and
 * the toast all say the same thing.
 */
export function bmiSyncChipFor(outcome: BmiStateSyncOutcome): BmiSyncChip | null {
  switch (outcome.status) {
    case "write":
      return {
        label: `BMI · ${outcome.stateName ?? outcome.stateId ?? "updated"}`,
        kind: "bmi",
        title: "The mapped Office state was written and verified by re-read",
      };
    case "unmapped":
      return {
        label: "BMI · not mapped",
        kind: "open",
        title:
          "This status has no Office state for this centre yet — set one on Statuses & BMI. The CRM moved; Office did not.",
      };
    case "paused":
      return {
        label: "BMI · writes paused",
        kind: "warn",
        title: "BMI writes are paused for this centre — the CRM moved; Office did not.",
      };
    case "no_project":
      return {
        label: "BMI · no project",
        kind: "warn",
        title: "There is no Office project for this lead yet, so there is no state to move.",
      };
    case "builtin":
      return {
        label: "BMI · use Cancel",
        kind: "warn",
        title:
          "This status maps to an Office built-in state. Cancelling a booking is done from the Contract tab, not from the board.",
      };
    case "pending":
      return {
        label: "BMI · sync pending",
        kind: "lost",
        title: outcome.error
          ? `Office did not confirm the new state: ${outcome.error}`
          : "Office did not confirm the new state — the CRM moved; the mirror will reconcile.",
      };
    default:
      return null;
  }
}

/** The toast after a drag / a status pick. */
export function transitionToastFor(
  statusLabel: string,
  outcome: BmiStateSyncOutcome,
): { text: string; kind: "ok" | "warn" | "crit" } {
  switch (outcome.status) {
    case "write":
      return {
        text: `Status → ${statusLabel} · BMI → ${outcome.stateName ?? ""}`.trim(),
        kind: "ok",
      };
    case "unmapped":
      return {
        text: `Status → ${statusLabel} · no BMI state mapped for this centre`,
        kind: "warn",
      };
    case "paused":
      return { text: `Status → ${statusLabel} · BMI writes are paused`, kind: "warn" };
    case "no_project":
      return { text: `Status → ${statusLabel} · no BMI project yet`, kind: "ok" };
    case "builtin":
      return {
        text: `Status → ${statusLabel} · that Office state is set from the Contract tab`,
        kind: "warn",
      };
    case "pending":
      return { text: `Status → ${statusLabel} · BMI did not confirm — sync pending`, kind: "crit" };
    default:
      return { text: `Status → ${statusLabel}`, kind: "ok" };
  }
}
