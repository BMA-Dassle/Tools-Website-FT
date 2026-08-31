/**
 * Lane arrangement kill switch.
 *
 * ON by default, per the owner's flag rule: a merged feature is on, and a flag exists
 * only so it can be turned OFF in a hurry without a deploy. Set
 * `LANE_ARRANGEMENT="false"` in Vercel to stop the engine touching anything.
 *
 * Scope is deliberately narrower than the switch: only FastTrax duckpin (11542) is
 * arranged today. FastTrax is the right pilot for a structural reason, not just a good
 * backtest — it sells ONE web offer across all eight lanes, so there is no lane group to
 * derive and none of the section-inventory problems that make HeadPinz Fort Myers
 * contradict itself day to day.
 */
import { FASTTRAX_QAMF_CENTER_ID } from "@/lib/qamf-centers";

/** Emergency off switch. Anything other than the literal "false" leaves it on. */
export function laneArrangementEnabled(): boolean {
  return process.env.LANE_ARRANGEMENT !== "false";
}

/** Centers the engine is allowed to arrange. FastTrax only, for now. */
export function laneArrangementCenter(centerId: number): boolean {
  return centerId === FASTTRAX_QAMF_CENTER_ID;
}

/**
 * Same-day only.
 *
 * A lane chosen days ahead is optimised against a board that is essentially empty and
 * bears no relation to the evening that actually happens — measuring that as if it were
 * this feature was the mistake that made the first backtests meaningless. We only place
 * bookings made FOR the day they are made ON, where the board we are reading is the board
 * the guest will actually walk into.
 *
 * Both stamps are compared as Eastern operating dates, so a 12:30am booking is judged
 * against the night it belongs to rather than the calendar rolling over mid-shift.
 */
export function isSameOperatingDay(bookedAtMs: number, nowMs: number): boolean {
  return operatingDateEt(bookedAtMs) === operatingDateEt(nowMs);
}

/** The Eastern date a moment belongs to, with anything before 4am counted as the night before. */
function operatingDateEt(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  if (Number(get("hour")) >= 4) return ymd;
  // Before 4am ET the centre is still working the previous day's session.
  const prev = new Date(Date.parse(`${ymd}T12:00:00Z`) - 86400000);
  return prev.toISOString().slice(0, 10);
}

/** Every gate in one place, so a caller cannot satisfy some of them and forget the rest. */
export function shouldArrangeLane(opts: {
  centerId: number;
  bookedAtMs: number;
  nowMs: number;
}): boolean {
  return (
    laneArrangementEnabled() &&
    laneArrangementCenter(opts.centerId) &&
    isSameOperatingDay(opts.bookedAtMs, opts.nowMs)
  );
}
