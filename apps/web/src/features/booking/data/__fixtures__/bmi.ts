/**
 * BMI mock fixtures — deterministic-ish responses used when the BMI
 * adapter runs in mock mode (`LOCAL_BMI_MOCK=1`).
 *
 * Mocks return data shaped like the real BMI proxy responses so a fresh
 * clone can walk the whole wizard without BMI credentials. All mock IDs
 * are 17 digits prefixed with '9' so they're clearly fake but match the
 * BMI shape (and stay above MAX_SAFE_INTEGER, exercising the raw-ID
 * handling that real BMI IDs require).
 *
 * Real fixture data (heat schedules, prices) is intentionally simple
 * here — the goal is "wizard works end-to-end with fake data," not
 * "exhaustively models BMI's edge cases." Tests should exercise edge
 * cases by injecting their own responses, not by stretching these.
 */
import type {
  BmiAvailabilityResponse,
  BmiBookResult,
  BmiOrderOverview,
  GetAvailabilityArgs,
} from "../bmi";

/** State held in-memory per mock orderId between bookHeat / removeBookingLine / overview calls. */
export interface MockBookSession {
  orderId: string;
  lines: Array<{
    productId: string;
    billLineId: string;
    quantity: number;
    start: string | null;
    stop: string | null;
    resourceId: number | null;
  }>;
  reservationNumber: string | null;
  reservationCode: string | null;
}

/** Generate a fake 17-digit personId. */
export function fixturePersonId(): string {
  return `9${Date.now().toString().slice(-13)}${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0")}`;
}

/**
 * Deterministic availability fixture: 4 blocks across the day at
 * 17:00, 17:30, 18:00, 18:30. Each block has 10 free spots / 10 capacity.
 * Time strings echo the input date so the wizard renders something
 * coherent even though the data is fake.
 */
export function fixtureAvailability(args: GetAvailabilityArgs): BmiAvailabilityResponse {
  const { date } = args;
  const times = ["17:00:00", "17:30:00", "18:00:00", "18:30:00"];
  return {
    proposals: times.map((time, i) => ({
      blocks: [
        {
          productLineIds: [],
          block: {
            name: `Mock heat ${i + 1}`,
            capacity: 10,
            freeSpots: 10,
            resourceId: 1000 + i,
            prices: [{ amount: 20.99, kind: 0, shortName: "m", depositKind: 0 }],
            start: `${date}T${time}.000`,
            stop: `${date}T${time.replace("00", "10")}.000`,
          },
        },
      ],
      productLineId: null,
    })),
  };
}

/** Build a BmiBookResult for a mock booking. */
export function fixtureBookResponse(args: {
  rawOrderId: string;
  billLineId: string;
  productId: string;
  quantity: number;
  block?: { start?: string; stop?: string; resourceId?: number } | undefined;
}): BmiBookResult {
  const start = args.block?.start ?? new Date().toISOString();
  return {
    rawOrderId: args.rawOrderId,
    billLineId: args.billLineId,
    result: {
      success: true,
      errorMessage: null,
      schedules: [
        {
          start,
          name: `Mock heat for ${args.productId}`,
          quantity: args.quantity,
          resourceId: args.block?.resourceId ?? 1000,
        },
      ],
      prices: [{ amount: 20.99, kind: 0, shortName: "m", depositKind: 0 }],
    },
  };
}

/** Build a BmiOrderOverview from a mock session's accumulated lines. */
export function fixtureOrderOverview(session: MockBookSession): BmiOrderOverview {
  return {
    rawOrderId: session.orderId,
    reservationNumber: session.reservationNumber,
    reservationCode: session.reservationCode,
    lines: session.lines.map((l) => ({
      productId: l.productId,
      name: `Mock heat ${l.productId}`,
      quantity: l.quantity,
      amount: 20.99,
      track: null,
      start: l.start ?? undefined,
      stop: l.stop ?? undefined,
    })),
  };
}
