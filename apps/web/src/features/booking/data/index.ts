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
 * PR-B1 ships:
 *   - The stub-mode primitive (mock-mode.ts).
 *   - One worked example adapter (square.ts) demonstrating the pattern.
 *
 * PR-B2..B6 add the other adapters (bmi, conq, pandora, kbf) as each
 * activity needs them.
 */
export { isMockMode } from "./mock-mode";
export { squareAdapter, type SquareAdapter } from "./square";
