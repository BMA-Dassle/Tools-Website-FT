import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMsw, rawJson } from "@/test/msw/server";
import { http } from "msw";
import { VOX_SEND_URL, voxFixtures, voxSent } from "@/test/msw/handlers/vox";

/**
 * THE `sentFrom` CONTRACT (C1's additive change to `lib/sms-retry.ts`).
 *
 * Before this PR, a `fromOverride` that Vox rejected was silently retried from
 * the A2P DID with a "(From …)" prefix and NOTHING in the result said so
 * (`sms-retry.ts:483-490`). A rep's thread would then claim the text went out
 * from their own number while the guest saw a different one — and a reply would
 * land in the automated keyword rail instead of the conversation.
 *
 * Pinned here with MSW against the REAL `voxSend`, because the point is the
 * transport's behaviour and not a stub's.
 */

const redisStub = {
  get: vi.fn(async () => null),
  set: vi.fn(async () => "OK"),
  del: vi.fn(async () => 1),
  expire: vi.fn(async () => 1),
  hincrby: vi.fn(async () => 1),
  lpush: vi.fn(async () => 1),
  ltrim: vi.fn(async () => "OK"),
  zadd: vi.fn(async () => 1),
  multi: () => ({
    incr: () => redisStub.multi(),
    expire: () => redisStub.multi(),
    set: () => redisStub.multi(),
    lpush: () => redisStub.multi(),
    ltrim: () => redisStub.multi(),
    hincrby: () => redisStub.multi(),
    exec: async () => [],
  }),
};

vi.mock("@/lib/redis", () => ({ default: redisStub }));
vi.mock("~/features/sms/suppression-db", () => ({
  lookupSuppression: vi.fn(async () => ({ suppressed: false })),
}));
vi.mock("@/lib/sms-log", () => ({ logSms: vi.fn(async () => undefined) }));
vi.mock("@/lib/twilio-send", () => ({
  twilioSend: vi.fn(async () => ({ ok: false, status: 500, error: "no twilio in tests" })),
  isTwilioQuotaError: () => false,
}));

const REP_DID = "+12392058142";
const A2P_DID = "+12394412867";

const server = installMsw();

const { voxSend } = await import("@/lib/sms-retry");

beforeEach(() => {
  voxSent.length = 0;
  process.env.VOX_API_KEY = "test-key";
  process.env.SMS_A2P_DID = A2P_DID;
  server.resetHandlers();
});

describe("voxSend reports the number the message actually left from", () => {
  it("a send from the rep's own DID reports that DID", async () => {
    server.use(
      http.post(VOX_SEND_URL, async ({ request }) => {
        voxSent.push(await request.json());
        return rawJson(voxFixtures.send());
      }),
    );
    const res = await voxSend("+12395551234", "Hi Dana, it's Kelsea at HP Fort Myers!", {
      fromOverride: REP_DID,
      category: "transactional",
      auditSource: "crm-sms",
    });
    expect(res.ok).toBe(true);
    expect(res.sentFrom).toBe(REP_DID);
    expect((voxSent[0] as { from: string }).from).toBe(REP_DID);
  });

  it("a DID Vox rejects falls back to the A2P number AND SAYS SO", async () => {
    let call = 0;
    server.use(
      http.post(VOX_SEND_URL, async ({ request }) => {
        const body = (await request.json()) as { from: string };
        voxSent.push(body);
        call += 1;
        // First attempt: the rep DID is not provisioned on our account.
        if (call === 1) return rawJson(`{"error":"unknown from number"}`, { status: 403 });
        return rawJson(voxFixtures.send());
      }),
    );
    const res = await voxSend("+12395551234", "Hi Dana", {
      fromOverride: REP_DID,
      fallbackPrefix: "(From Kelsea) ",
      category: "transactional",
    });
    expect(res.ok).toBe(true);
    // The honest answer: it did NOT leave from the rep's number.
    expect(res.sentFrom).toBe(A2P_DID);
    expect(res.sentFrom).not.toBe(REP_DID);
    expect(voxSent).toHaveLength(2);
    expect((voxSent[1] as { body: string }).body.startsWith("(From Kelsea) ")).toBe(true);
  });

  it("a send that never reached anyone reports no sender at all", async () => {
    server.use(http.post(VOX_SEND_URL, () => rawJson(`{"error":"boom"}`, { status: 500 })));
    const res = await voxSend("+12395551234", "Hi Dana", { fromOverride: REP_DID });
    expect(res.ok).toBe(false);
    expect(res.sentFrom).toBeUndefined();
  });
});
