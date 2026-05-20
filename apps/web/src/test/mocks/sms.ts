import { vi } from "vitest";

/**
 * SMS send mock — captures voxSend / twilioSend / logSms calls without
 * hitting providers or Redis.
 *
 * Usage in tests:
 *   vi.mock("@/lib/sms-retry", () => import("~/test/mocks/sms"));
 *   vi.mock("@/lib/sms-log",   () => import("~/test/mocks/sms"));
 *
 *   import * as smsMock from "~/test/mocks/sms";
 *   expect(smsMock.lastSend()).toMatchObject({ to: "+15551234567" });
 *
 * The module exports the same symbol names the production code imports
 * (voxSend, twilioSend, logSms) so vi.mock can drop this in wholesale.
 * Test helpers (resetSmsCaptures, lastSend, etc.) coexist as additional
 * named exports — unused by production code paths.
 */

export interface CapturedSend {
  to: string;
  body: string;
  fromOverride?: string;
  source: "vox" | "twilio";
}

const captured: CapturedSend[] = [];

/** Reset captures + clear vi.fn call history. Call in beforeEach. */
export function resetSmsCaptures(): void {
  captured.length = 0;
  voxSend.mockClear();
  twilioSend.mockClear();
  logSms.mockClear();
  // Restore default (success) behavior in case a previous test forced a failure.
  voxSend.mockImplementation(defaultVoxSend);
  twilioSend.mockImplementation(defaultTwilioSend);
  logSms.mockImplementation(defaultLogSms);
}

export function allSends(): CapturedSend[] {
  return [...captured];
}

export function lastSend(): CapturedSend | undefined {
  return captured[captured.length - 1];
}

export function findSend(predicate: (s: CapturedSend) => boolean): CapturedSend | undefined {
  return captured.find(predicate);
}

/**
 * Shape matches the real `VoxSendResult` from @/lib/sms-retry so tests can
 * override with either success or failure shapes via `.mockImplementationOnce`.
 */
export interface MockVoxSendResult {
  ok: boolean;
  status: number | null;
  error?: string;
  skipped?: boolean;
  quotaHit?: boolean;
  provider?: "vox" | "twilio";
  failedOver?: boolean;
  voxId?: string;
  twilioSid?: string;
}

const defaultVoxSend = async (
  phone: string,
  body: string,
  opts?: { fromOverride?: string },
): Promise<MockVoxSendResult> => {
  captured.push({
    to: phone,
    body,
    fromOverride: opts?.fromOverride,
    source: "vox",
  });
  return {
    ok: true,
    status: 200,
    voxId: `mock-vox-${captured.length}`,
    provider: "vox",
    failedOver: false,
  };
};

const defaultTwilioSend = async (to: string, body: string, fromOverride?: string) => {
  captured.push({ to, body, fromOverride, source: "twilio" });
  return { ok: true, status: 201, sid: `mock-sid-${captured.length}` };
};

const defaultLogSms = async () => {};

/**
 * Bare named exports — these are what `vi.mock("@/lib/sms-retry", () => import("~/test/mocks/sms"))`
 * substitutes for the production functions. Configure failure behavior in
 * tests via `voxSend.mockImplementationOnce(...)`.
 */
export const voxSend = vi.fn(defaultVoxSend);
export const twilioSend = vi.fn(defaultTwilioSend);
export const logSms = vi.fn(defaultLogSms);

/**
 * Legacy factory kept for backwards-compatibility with the audience test
 * that already references it. Returns the same captured set.
 */
export function createTwilioSendMock() {
  return { voxSend, twilioSend, logSms };
}
