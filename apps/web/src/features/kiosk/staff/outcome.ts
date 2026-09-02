/**
 * /kiosk/staff Card loads tab — the plain-English outcome chip for a ledger row.
 *
 * The question staff are answering at the machine is "did the guest get what
 * they paid for?", so the chip collapses `state` × `load_state` to four
 * answers. Pure + exhaustive: every pair maps to exactly one label (tested),
 * because an "unknown" chip on a money row is a support call.
 *
 * KNOWN LIMIT (deliberate): a row stamped `loaded` whose card is actually
 * empty (the ~8% 2026-09-01 smoke defect) still reads *Loaded* — the ledger
 * cannot see the card, and inventing a worse answer here would just make every
 * healthy row suspect. The card-lookup panel (live Intercard balance) is the
 * tool that catches those.
 */
import type { LoadState, TxnState } from "../../game-cards/types";

export interface LoadOutcome {
  label: "Loaded" | "Charged, not loaded" | "Charge failed" | "In progress";
  /** Chip colour class family: good=green, warn=amber, bad=red, idle=grey. */
  tone: "good" | "warn" | "bad" | "idle";
  /** One sentence staff can act on. */
  detail: string;
}

export function loadOutcome(row: { state: TxnState; loadState: LoadState }): LoadOutcome {
  // The load's own verdict wins over the charge lifecycle: `loaded` means
  // Intercard confirmed the credit (code 0), whatever the row's charge state
  // says about how it got there.
  if (row.loadState === "loaded") {
    return {
      label: "Loaded",
      tone: "good",
      detail: "Intercard confirmed the credit. If the guest disputes, check the live balance.",
    };
  }

  if (row.state === "charge_failed" || row.state === "failed") {
    return {
      label: "Charge failed",
      tone: "idle",
      detail: "The payment never completed — nothing is owed onto a card.",
    };
  }

  if (row.loadState === "load_failed") {
    return {
      label: "Charged, not loaded",
      tone: "bad",
      detail:
        "The guest paid and Intercard REFUSED the credit. Check the row's error, then the live balance.",
    };
  }

  // load_state = pending from here down.
  if (row.state === "charged" || row.state === "completed") {
    return {
      label: "Charged, not loaded",
      tone: "warn",
      detail:
        "The guest paid; the credit hasn't confirmed yet. The reconcile cron retries it — recheck in a few minutes.",
    };
  }

  // state = started: checkout still running, or abandoned before paying.
  return {
    label: "In progress",
    tone: "idle",
    detail: "Checkout started but no charge has completed (yet, or the guest abandoned it).",
  };
}
