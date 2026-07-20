/**
 * Dispenser fault → recovery behavior. Pure classification over the reader's
 * CrtErrorInfo taxonomy (protocol/errors.ts) — the single place that decides
 * how the guest flow reacts to each hardware fault. No DOM, no I/O.
 *
 * Behaviors:
 *  - retry:      transient — resend (optionally after an INIT). Invisible to the guest.
 *  - hold:       recoverable physical fault — pause on a "one moment" screen. Recovery is
 *                ALWAYS a staff Resume tap (never automatic); when `resumeReady` is set the
 *                button stays disabled until the sensor confirms the fault is cleared.
 *  - card-retry: the CARD, not the machine — re-dispense a fresh blank / ask for another card.
 *  - abort:      dead end — stop and send the guest to an attendant (money is safe).
 */
import type { CrtErrorInfo } from "./protocol/errors";
import type { CrtStatus } from "./protocol/status";

export type FaultBehavior =
  | { kind: "retry"; maxTries: number; reinit: boolean }
  | {
      kind: "hold";
      title: string;
      message: string;
      hint?: string;
      /** Gates the staff Resume button — disabled until this returns true. Omitted = enabled now. */
      resumeReady?: (s: CrtStatus) => boolean;
      /** Run INIT when staff resume (the device lost its card position). */
      reinitOnResume: boolean;
    }
  | { kind: "card-retry" }
  | { kind: "abort"; message: string };

const SEE_ATTENDANT = "Please see an attendant — your payment is safe.";

export function classifyFault(info: CrtErrorInfo): FaultBehavior {
  const { category, code, message, hint } = info;

  switch (category) {
    case "retryable":
      return { kind: "retry", maxTries: 2, reinit: false };

    case "needsInit":
      return { kind: "retry", maxTries: 1, reinit: true };

    case "cardError":
      return { kind: "card-retry" };

    case "fatal":
      // portClosed (reader unplugged) and undefined/unsupported commands can't self-heal.
      return { kind: "abort", message: `${message}. ${SEE_ATTENDANT}` };

    case "attention": {
      // Physical faults that hold the flow. Sensor-detectable ones gate Resume
      // until cleared; the rest enable Resume immediately (staff judgment).
      switch (code) {
        case "A0": // stacker empty
          return {
            kind: "hold",
            title: "Out of cards",
            message: "The card dispenser needs to be refilled.",
            hint,
            resumeReady: (s) => s.stacker !== "empty" && s.stacker !== "unknown",
            reinitOnResume: false,
          };
        case "A1": // error bin full
        case "50": // retract counter overflow
          return {
            kind: "hold",
            title: "Card bin full",
            message: "The reject bin needs to be emptied.",
            hint,
            // Watch the sensor for full → empty: Resume unlocks once the bin
            // reads clear (a pull-out to empty it triggers this once).
            resumeReady: (s) => s.errorBin === "ok",
            reinitOnResume: true,
          };
        case "10": // card jam
        case "40": // unable to retract
          return {
            kind: "hold",
            title: "Card jam",
            message: "A card needs to be cleared from the dispenser.",
            hint,
            resumeReady: (s) => s.card === "none",
            reinitOnResume: true,
          };
        default: // 12 sensor, 13/14 size, 43 can't-move-to-IC, 51 motor, …
          return {
            kind: "hold",
            title: "Dispenser needs attention",
            message,
            hint,
            // No reliable sensor signal — let staff decide it's cleared.
            reinitOnResume: true,
          };
      }
    }
  }
}
