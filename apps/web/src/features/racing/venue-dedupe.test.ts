import { describe, expect, it } from "vitest";
import { venueDedupeKey, VENUE_DEDUPE_TTL_SECONDS } from "./venue-dedupe";

/**
 * REAL WIRE RECORDS, verbatim from `kart:events:queue` (survey 2026-08-19,
 * 88,172 invocations). The duplicate pairs below are actual consecutive
 * deliveries — same event, ~0.1-0.3s apart.
 */

/** An EnterTap, delivered three times ~0.1s apart. Copies are byte-identical. */
const ENTER_TAP = {
  $type: "EnterTapNotification",
  TrapId: 20899703,
  TrapName: "Pit Area",
  Occured: "2026-08-16T22:03:54.185",
  PassingId: 58987256,
  RentalObjectId: 11994801,
  RentalObjectName: "54",
  TransponderCode: "25:04:66:82:13:25",
  ParticipantId: 58964040,
  ParticipantName: "Makenna Smith",
  SessionId: 58599015,
  SessionName: "55 - Blue Junior Starter",
  NotificationMetaId: -213,
  Id: 58987260,
  Date: "2026-08-16T22:03:54.389",
};

/**
 * THE TRAP THAT KILLED THE ID-KEYED DESIGN.
 *
 * All three carry `Id: 63000000008866056` — the PROJECT id, not a notification
 * id — and are three genuinely different transitions of one reservation,
 * 156ms apart. A dedupe keyed on ($type, Id) drops the last two and the
 * booking silently never reaches "Confirmation".
 */
const PROJECT_PAYMENT_STARTED = {
  $type: "ProjectStateChangedNotification",
  Id: 63000000008866056,
  ProjectKindId: -10,
  ProjectKind: "Online Reservation",
  Date: "2026-08-19T10:31:43.721",
  OldProjectStateId: -100,
  OldProjectState: "Pending online",
  ProjectStateId: -101,
  ProjectState: "Payment started",
  PartyMetaId: null,
  ResourceIds: [11208654, 11208660],
};
const PROJECT_PAID = {
  ...PROJECT_PAYMENT_STARTED,
  Date: "2026-08-19T10:31:43.831",
  OldProjectStateId: -101,
  OldProjectState: "Payment started",
  ProjectStateId: -102,
  ProjectState: "Paid online",
};
const PROJECT_CONFIRMED = {
  ...PROJECT_PAYMENT_STARTED,
  Date: "2026-08-19T10:31:43.877",
  OldProjectStateId: -102,
  OldProjectState: "Paid online",
  ProjectStateId: -3,
  ProjectState: "Confirmation",
};

/** Same notification id, same state, but fanned out per track. Also distinct. */
const PROJECT_CANCEL_BLUE = {
  $type: "ProjectStateChangedNotification",
  Id: 63000000008868210,
  ProjectKindId: -10,
  ProjectKind: "Online Reservation",
  Date: "2026-08-19T11:12:17.484",
  OldProjectStateId: -100,
  OldProjectState: "Pending online",
  ProjectStateId: -4,
  ProjectState: "Cancellation",
  PartyMetaId: null,
  ResourceIds: [11208654],
};
const PROJECT_CANCEL_RED = { ...PROJECT_CANCEL_BLUE, ResourceIds: [11208660] };

/** A race-list dump — the shape a reconnect catch-up replays verbatim. */
const RACE_LIST_DUMP = [
  {
    $type: "RaceAdvice",
    DurationTime: "00:07:00",
    RaceId: 58599144,
    ResourceId: 11208660,
    ResourceName: "Red Track",
    Name: "57 - Red Intermediate",
    RecordVersion: 13431524620678000,
    Drivers: [],
  },
];

describe("venueDedupeKey", () => {
  it("gives byte-identical redeliveries the same key", () => {
    // The real duplicate: same event, delivered again 114ms later.
    const first = venueDedupeKey(ENTER_TAP);
    const second = venueDedupeKey({ ...ENTER_TAP });
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("is INDEPENDENT of key order", () => {
    const reordered = Object.fromEntries(Object.entries(ENTER_TAP).reverse());
    expect(venueDedupeKey(reordered)).toBe(venueDedupeKey(ENTER_TAP));
  });

  it("keeps the three ProjectStateChanged transitions that share one Id apart", () => {
    const keys = new Set(
      [PROJECT_PAYMENT_STARTED, PROJECT_PAID, PROJECT_CONFIRMED].map(venueDedupeKey),
    );
    // Three real transitions of one reservation — none may collapse.
    expect(keys.size).toBe(3);
  });

  it("keeps the same notification fanned out to two resources apart", () => {
    expect(venueDedupeKey(PROJECT_CANCEL_BLUE)).not.toBe(venueDedupeKey(PROJECT_CANCEL_RED));
  });

  it("separates two events that differ only in a nested array", () => {
    const a = { ...PROJECT_CANCEL_BLUE, ResourceIds: [11208654, 11208660] };
    const b = { ...PROJECT_CANCEL_BLUE, ResourceIds: [11208660, 11208654] };
    // Order inside a wire array is data, not formatting — do not canonicalise it away.
    expect(venueDedupeKey(a)).not.toBe(venueDedupeKey(b));
  });

  it("NEVER dedupes an array frame — the clock recovers from replayed dumps", () => {
    expect(venueDedupeKey(RACE_LIST_DUMP)).toBeNull();
  });

  it("passes through anything that is not a $type-bearing object", () => {
    expect(venueDedupeKey(null)).toBeNull();
    expect(venueDedupeKey("BcTime")).toBeNull();
    expect(venueDedupeKey(42)).toBeNull();
    expect(venueDedupeKey({ Id: 1 })).toBeNull(); // no $type — never guess
  });

  it("namespaces the key by type so a hash collision cannot cross types", () => {
    expect(venueDedupeKey(ENTER_TAP)).toMatch(/^venue:evt:seen:EnterTapNotification:[0-9a-f]{20}$/);
  });

  it("remembers an event for far longer than the widest observed redelivery spread", () => {
    // Widest first→last spread between copies of one event in the survey: 110s.
    expect(VENUE_DEDUPE_TTL_SECONDS).toBeGreaterThan(110);
  });
});
