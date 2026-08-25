import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The rule this file exists to hold: A CRON NEVER RUNS ON TOP OF ITSELF, AND A
 * LOCK NEVER STOPS IT RUNNING AT ALL.
 *
 * Both halves matter and they pull against each other. group-quote-dispatch was
 * measured at 58-66s on a 60s schedule (2026-08-25), so overlap was real. But
 * this job sends contracts and the sweep it guards recovers paid bookings BMI
 * wrongly cancelled — a lock that fails closed would turn a Redis blip into
 * guests arriving to nothing. Every test is named for one of those two failures.
 */

const store = new Map<string, string>();
const set = vi.fn(async (k: string, v: string, _ex: string, _ttl: number, nx?: string) => {
  if (nx === "NX" && store.has(k)) return null;
  store.set(k, v);
  return "OK";
});
const get = vi.fn(async (k: string) => store.get(k) ?? null);
const del = vi.fn(async (k: string) => (store.delete(k) ? 1 : 0));

vi.mock("@/lib/redis", () => ({ default: { set, get, del } }));

const { withCronLock } = await import("../cron-lock");

beforeEach(() => {
  store.clear();
  set.mockClear();
  get.mockClear();
  del.mockClear();
});

describe("withCronLock", () => {
  it("runs the job and releases, so the next tick is free", async () => {
    const r = await withCronLock("job", 60, async () => "done");
    expect(r).toEqual({ ran: true, result: "done" });
    expect(store.size).toBe(0); // released

    const again = await withCronLock("job", 60, async () => "second");
    expect(again.ran).toBe(true);
  });

  it("skips the tick while a previous run still holds the lock", async () => {
    // The overlap this exists to prevent: tick 2 arriving inside tick 1.
    let release: (() => void) | undefined;
    const slow = withCronLock(
      "job",
      60,
      () => new Promise<string>((r) => (release = () => r("slow"))),
    );
    await Promise.resolve();

    const overlapping = await withCronLock("job", 60, async () => "should not run");
    expect(overlapping).toEqual({ ran: false });
    expect(overlapping.result).toBeUndefined();

    release?.();
    expect((await slow).result).toBe("slow");
  });

  it("releases even when the job throws, so one error does not park the cron", async () => {
    await expect(
      withCronLock("job", 60, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(store.size).toBe(0);
  });

  it("does NOT delete a lock the next run already owns", async () => {
    // A run that overran its TTL must not release someone else's lock, or the
    // exclusion silently stops working under exactly the load that needs it.
    let release: (() => void) | undefined;
    const overrunning = withCronLock(
      "job",
      60,
      () => new Promise<string>((r) => (release = () => r("late"))),
    );
    await Promise.resolve();

    // Its TTL lapses and a fresh run takes the lock.
    store.set("cron:lock:job", "a-different-runs-token");

    release?.();
    await overrunning;
    expect(store.get("cron:lock:job")).toBe("a-different-runs-token");
  });

  it("FAILS OPEN when Redis is unreachable rather than parking the job", async () => {
    // A cron that recovers bookings must not stop because the lock store blinked.
    set.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await withCronLock("job", 60, async () => "ran anyway");
    expect(r.ran).toBe(true);
    expect(r.result).toBe("ran anyway");
    expect(r.degraded).toBe(true);
  });

  it("does not try to release a lock it never acquired", async () => {
    set.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await withCronLock("job", 60, async () => "x");
    expect(del).not.toHaveBeenCalled();
  });

  it("keys by name, so two different crons never block each other", async () => {
    let release: (() => void) | undefined;
    const a = withCronLock("job-a", 60, () => new Promise<string>((r) => (release = () => r("a"))));
    await Promise.resolve();
    const b = await withCronLock("job-b", 60, async () => "b");
    expect(b.ran).toBe(true);
    release?.();
    await a;
  });

  it("asks Redis for the TTL it was given", async () => {
    await withCronLock("job", 180, async () => null);
    expect(set).toHaveBeenCalledWith("cron:lock:job", expect.any(String), "EX", 180, "NX");
  });
});
