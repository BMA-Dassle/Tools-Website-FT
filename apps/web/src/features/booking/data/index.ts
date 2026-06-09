/**
 * Booking data layer — vendor adapters.
 *
 * Each adapter (bmi, conq, square, pandora, kbf) is a typed wrapper around
 * its v1 lib/* counterpart. Adapters NEVER expose vendor SDK types directly
 * — they return shapes the booking service layer cares about, scrubbed of
 * vendor-specific quirks.
 *
 * Stub mode: every adapter consults the helper in `./mock-mode.ts` to decide
 * whether to call the real vendor or return fixtures. See `./square.ts` for
 * the reference pattern. Local dev defaults to mocks for vendors without
 * sandbox accounts; production always uses the real impl.
 *
 * Ships so far:
 *   - mock-mode.ts (the toggle primitive)
 *   - square.ts (Square Order adapter — DRAFT/CREATE/GET/CANCEL)
 *   - bmi.ts (BMI adapter — getAvailability, bookHeat, removeBookingLine,
 *     confirmPayment, getOrderOverview, createPerson; raw-ID-safe via
 *     @ft/db.stringifyWithRawIds)
 *
 * Conq (bowling) + Pandora + KBF land in PR-B5 / B6.
 */
export { isMockMode } from "./mock-mode";
export { squareAdapter, type SquareAdapter } from "./square";

export { bmiAdapter, type BmiAdapter } from "./bmi";
export type {
  BmiAvailabilityResponse,
  BmiBlock,
  BmiBookResult,
  BmiOrderOverview,
  BmiPrice,
  BmiProposal,
  BmiProposalBlock,
  BookHeatArgs,
  ConfirmPaymentArgs,
  CreatePersonArgs,
  GetAvailabilityArgs,
  GetOrderOverviewArgs,
  RemoveBookingLineArgs,
} from "./bmi";
