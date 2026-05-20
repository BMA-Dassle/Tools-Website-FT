import { vi } from "vitest";

/**
 * SMS send mock — captures voxSend / twilioSend calls without hitting providers.
 *
 * The real send helpers live in apps/web/lib/twilio-send.ts and rely on env
 * + network. Tests that need to assert "we tried to send SMS X to phone Y"
 * should `vi.mock("@/lib/twilio-send", ...)` with this helper.
 *
 * Usage:
 *   vi.mock("@/lib/twilio-send", async () => {
 *     const mod = await import("~/test/mocks/sms");
 *     return mod.createTwilioSendMock();
 *   });
 *
 *   const sms = await import("~/test/mocks/sms");
 *   expect(sms.lastSend()).toMatchObject({ to: "+15551234567", body: /survey/ });
 */

interface CapturedSend {
  to: string;
  body: string;
  fromOverride?: string;
  source: "vox" | "twilio";
}

const captured: CapturedSend[] = [];

export function resetSmsCaptures(): void {
  captured.length = 0;
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

export function createTwilioSendMock() {
  return {
    voxSend: vi.fn(async (phone: string, body: string, opts?: { fromOverride?: string }) => {
      captured.push({
        to: phone,
        body,
        fromOverride: opts?.fromOverride,
        source: "vox",
      });
      return { ok: true, status: 200, voxId: `mock-vox-${captured.length}` };
    }),
    twilioSend: vi.fn(async (to: string, body: string, fromOverride?: string) => {
      captured.push({ to, body, fromOverride, source: "twilio" });
      return { ok: true, status: 201, sid: `mock-sid-${captured.length}` };
    }),
    logSms: vi.fn(async () => {}),
  };
}
