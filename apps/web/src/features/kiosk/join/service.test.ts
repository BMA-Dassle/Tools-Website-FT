/**
 * Mobile-join session state machine, run against an in-memory Redis fake so
 * the atomic-command choreography (SET/EX, RPUSH, SADD, HSET, EXPIRE) is
 * exercised for real: supersede-on-create, TTL slides, the 2h cap, presence
 * math, dedupe/replay, landed-late, and idempotent close.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeEntry {
  str?: string;
  list?: string[];
  set?: Set<string>;
  hash?: Map<string, string>;
  ttl?: number;
}

vi.mock("@/lib/redis", () => {
  const db = new Map<string, FakeEntry>();
  const ensure = (k: string): FakeEntry => {
    let e = db.get(k);
    if (!e) {
      e = {};
      db.set(k, e);
    }
    return e;
  };
  const hooks: { onRpush?: () => void } = {};
  const fake = {
    __db: db,
    __hooks: hooks,
    __reset() {
      db.clear();
      hooks.onRpush = undefined;
    },
    __ttl(k: string) {
      return db.get(k)?.ttl;
    },
    async get(k: string) {
      return db.get(k)?.str ?? null;
    },
    async set(k: string, v: string, _ex?: string, ttl?: number) {
      const e = ensure(k);
      e.str = v;
      if (typeof ttl === "number") e.ttl = ttl;
      return "OK";
    },
    async del(k: string) {
      return db.delete(k) ? 1 : 0;
    },
    async expire(k: string, ttl: number) {
      const e = db.get(k);
      if (!e) return 0;
      e.ttl = ttl;
      return 1;
    },
    async rpush(k: string, v: string) {
      hooks.onRpush?.();
      const e = ensure(k);
      e.list = e.list ?? [];
      e.list.push(v);
      return e.list.length;
    },
    async lrange(k: string, start: number, stop: number) {
      const list = db.get(k)?.list ?? [];
      return stop === -1 ? list.slice(start) : list.slice(start, stop + 1);
    },
    async llen(k: string) {
      return db.get(k)?.list?.length ?? 0;
    },
    async sadd(k: string, member: string) {
      const e = ensure(k);
      e.set = e.set ?? new Set();
      if (e.set.has(member)) return 0;
      e.set.add(member);
      return 1;
    },
    async srem(k: string, member: string) {
      return db.get(k)?.set?.delete(member) ? 1 : 0;
    },
    async hset(k: string, field: string, v: string) {
      const e = ensure(k);
      e.hash = e.hash ?? new Map();
      e.hash.set(field, v);
      return 1;
    },
    async hgetall(k: string) {
      const h = db.get(k)?.hash;
      return h ? Object.fromEntries(h) : {};
    },
    async incr(k: string) {
      const e = ensure(k);
      const n = (e.str ? Number(e.str) : 0) + 1;
      e.str = String(n);
      return n;
    },
  };
  return { default: fake };
});

import redis from "@/lib/redis";
import * as store from "./store";
import {
  closeJoinSession,
  createJoinSession,
  guestMeta,
  identityKeyFor,
  kioskPoll,
  submitGuest,
} from "./service";
import {
  ABSOLUTE_CAP_MS,
  CLOSED_GRACE_SEC,
  MAX_JOINS_PER_SESSION,
  SESSION_TTL_SEC,
  type JoinGuestPayload,
} from "./types";

const fake = redis as unknown as {
  __reset: () => void;
  __ttl: (k: string) => number | undefined;
  __hooks: { onRpush?: () => void };
  __db: Map<string, FakeEntry>;
};

const KIOSK_INPUT = {
  kioskId: "fort-myers:4",
  center: "fort-myers" as const,
  brand: "fasttrax" as const,
  stepKind: "race" as const,
};

function adultGuest(overrides: Partial<JoinGuestPayload> = {}): JoinGuestPayload {
  return {
    firstName: "Ann",
    lastName: "Tester",
    bmiPersonId: "12345678901234567",
    pandoraPersonId: "88421",
    isNewRacer: false,
    category: "adult",
    waiverValid: true,
    dobIso: "1990-01-15",
    ...overrides,
  };
}

async function createOpen() {
  return createJoinSession(KIOSK_INPUT, "https://fasttraxfl.com");
}

beforeEach(() => fake.__reset());

describe("createJoinSession", () => {
  it("returns an unguessable code and a same-origin join URL", async () => {
    const { code, joinUrl, expiresAt } = await createOpen();
    expect(code).toHaveLength(12);
    expect(joinUrl).toBe(`https://fasttraxfl.com/join/${code}`);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(fake.__ttl(`kiosk:join:${code}`)).toBe(SESSION_TTL_SEC);
  });

  it("supersedes the prior open session for the same kiosk", async () => {
    const first = await createOpen();
    const second = await createOpen();
    expect(second.code).not.toBe(first.code);
    const prior = await store.readSession(first.code);
    expect(prior?.status).toBe("closed");
    expect(prior?.closeReason).toBe("superseded");
    expect(await store.getKioskPointer(KIOSK_INPUT.kioskId)).toBe(second.code);
  });
});

describe("kioskPoll", () => {
  it("slides the TTL and reports guests + presence", async () => {
    const { code } = await createOpen();
    await submitGuest(code, "phone-1", adultGuest());
    // Simulate TTL decay, then poll — it must re-slide to the full window.
    await redis.expire(`kiosk:join:${code}`, 30);
    const result = await kioskPoll(code);
    expect(result.status).toBe("open");
    if (result.status !== "open") return;
    expect(result.guests).toHaveLength(1);
    expect(result.guests[0].guest.firstName).toBe("Ann");
    // Guest POST marks its client "done" — connected but not in-progress.
    expect(result.clients).toEqual({ active: 1, inProgress: 0 });
    expect(fake.__ttl(`kiosk:join:${code}`)).toBe(SESSION_TTL_SEC);
  });

  it("counts fresh non-done clients as in-progress and ignores stale ones", async () => {
    const { code } = await createOpen();
    await store.heartbeat(code, "engaged", "signing-in");
    await store.heartbeat(code, "finished", "done");
    // A phone that vanished 5 minutes ago.
    await redis.hset(
      `kiosk:join:${code}:clients`,
      "stale",
      JSON.stringify({ lastSeen: Date.now() - 300_000, stage: "waiver" }),
    );
    const result = await kioskPoll(code);
    if (result.status !== "open") throw new Error("expected open");
    expect(result.clients).toEqual({ active: 2, inProgress: 1 });
  });

  it("flips to closed/expired past the absolute cap", async () => {
    const { code } = await createOpen();
    const session = await store.readSession(code);
    await store.writeSession(
      { ...session!, createdAt: Date.now() - ABSOLUTE_CAP_MS - 1000 },
      SESSION_TTL_SEC,
    );
    const result = await kioskPoll(code);
    expect(result).toEqual({ status: "closed", closeReason: "expired" });
    expect(fake.__ttl(`kiosk:join:${code}`)).toBe(CLOSED_GRACE_SEC);
  });

  it("reports gone for unknown codes", async () => {
    expect(await kioskPoll("nope")).toEqual({ status: "gone" });
  });
});

describe("closeJoinSession", () => {
  it("closes with the given reason and shrinks TTLs to the grace window", async () => {
    const { code } = await createOpen();
    await submitGuest(code, "phone-1", adultGuest());
    await closeJoinSession(code, "continued");
    const session = await store.readSession(code);
    expect(session?.status).toBe("closed");
    expect(session?.closeReason).toBe("continued");
    expect(fake.__ttl(`kiosk:join:${code}`)).toBe(CLOSED_GRACE_SEC);
    expect(fake.__ttl(`kiosk:join:${code}:guests`)).toBe(CLOSED_GRACE_SEC);
    expect(await store.getKioskPointer(KIOSK_INPUT.kioskId)).toBeNull();
  });

  it("is idempotent — the first reason wins and missing sessions are fine", async () => {
    const { code } = await createOpen();
    await closeJoinSession(code, "idle");
    await closeJoinSession(code, "start-over");
    expect((await store.readSession(code))?.closeReason).toBe("idle");
    await expect(closeJoinSession("missing", "done")).resolves.toBeUndefined();
  });
});

describe("guestMeta", () => {
  it("returns open meta and records the heartbeat when a clientId polls", async () => {
    const { code } = await createOpen();
    const meta = await guestMeta(code, "phone-1", "signing-in");
    expect(meta).toEqual({
      status: "open",
      center: "fort-myers",
      brand: "fasttrax",
      stepKind: "race",
      splitPaymentAvailable: false,
    });
    const clients = await store.readClients(code);
    expect(clients["phone-1"]?.stage).toBe("signing-in");
  });

  it("returns the close reason during the grace window, then gone", async () => {
    const { code } = await createOpen();
    await closeJoinSession(code, "continued");
    expect(await guestMeta(code)).toEqual({
      status: "closed",
      closeReason: "continued",
      center: "fort-myers",
      brand: "fasttrax",
    });
    expect(await guestMeta("missing")).toEqual({ status: "gone" });
  });
});

describe("submitGuest", () => {
  it("accepts an adult, lists them, and marks the client done", async () => {
    const { code } = await createOpen();
    const result = await submitGuest(code, "phone-1", adultGuest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.joinId).toBeTruthy();
    const guests = await store.listGuests(code);
    expect(guests).toHaveLength(1);
    expect(guests[0].guest.bmiPersonId).toBe("12345678901234567"); // stays a string
    expect((await store.readClients(code))["phone-1"]?.stage).toBe("done");
  });

  it("rejects minors server-side", async () => {
    const { code } = await createOpen();
    const dob = new Date();
    const under18 = `${dob.getFullYear() - 17}-01-15`;
    const result = await submitGuest(code, "phone-1", adultGuest({ dobIso: under18 }));
    expect(result).toEqual({ ok: false, error: "must-be-adult" });
    expect(await store.listGuests(code)).toHaveLength(0);
  });

  it("treats duplicates and replays as success without a second list entry", async () => {
    const { code } = await createOpen();
    await submitGuest(code, "phone-1", adultGuest());
    const replay = await submitGuest(code, "phone-2", adultGuest());
    expect(replay).toEqual({ ok: true, alreadyJoined: true });
    expect(await store.listGuests(code)).toHaveLength(1);
  });

  it("dedupes by bmi id first, then pandora id, then name+dob", () => {
    expect(identityKeyFor(adultGuest())).toBe("bmi:12345678901234567");
    expect(identityKeyFor(adultGuest({ bmiPersonId: undefined }))).toBe("pandora:88421");
    expect(identityKeyFor(adultGuest({ bmiPersonId: undefined, pandoraPersonId: undefined }))).toBe(
      "name:ann|tester|1990-01-15",
    );
  });

  it("rejects joins on a closed session with the close reason", async () => {
    const { code } = await createOpen();
    await closeJoinSession(code, "continued");
    const result = await submitGuest(code, "phone-1", adultGuest());
    expect(result).toEqual({ ok: false, error: "closed", reason: "continued" });
  });

  it("reports landed-late when the kiosk closes mid-submit", async () => {
    const { code } = await createOpen();
    // Close the session at the exact RPUSH moment (the TOCTOU window).
    fake.__hooks.onRpush = () => {
      const key = `kiosk:join:${code}`;
      const entry = fake.__db.get(key)!;
      const session = JSON.parse(entry.str!);
      entry.str = JSON.stringify({ ...session, status: "closed", closeReason: "continued" });
    };
    const result = await submitGuest(code, "phone-1", adultGuest());
    expect(result).toEqual({ ok: false, error: "landed-late" });
  });

  it("caps joins per session", async () => {
    const { code } = await createOpen();
    for (let i = 0; i < MAX_JOINS_PER_SESSION; i++) {
      await redis.rpush(`kiosk:join:${code}:guests`, JSON.stringify({ joinId: `j${i}` }));
    }
    const result = await submitGuest(code, "phone-1", adultGuest());
    expect(result).toEqual({ ok: false, error: "full" });
  });

  it("releases the identity claim if the list append fails, so a retry lands", async () => {
    const { code } = await createOpen();
    fake.__hooks.onRpush = () => {
      fake.__hooks.onRpush = undefined; // fail only the first attempt
      throw new Error("redis hiccup");
    };
    await expect(submitGuest(code, "phone-1", adultGuest())).rejects.toThrow("redis hiccup");
    const retry = await submitGuest(code, "phone-1", adultGuest());
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.alreadyJoined).toBeUndefined();
    expect(await store.listGuests(code)).toHaveLength(1);
  });

  it("reports gone for unknown codes", async () => {
    expect(await submitGuest("missing", "phone-1", adultGuest())).toEqual({
      ok: false,
      error: "gone",
    });
  });
});
