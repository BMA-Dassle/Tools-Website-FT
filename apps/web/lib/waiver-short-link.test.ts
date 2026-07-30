/**
 * The waiver short-link contract. Every case here is a way a capability link has
 * gone wrong or could go wrong:
 *
 *   fresh code per send   -> the link in already-delivered mail stops working, and
 *                            click history for one reservation splits in two
 *   guessable capability  -> anyone holding a forwarded sign-only link can delete
 *                            guests from someone else's booking
 *   Redis as truth        -> a 90-day TTL (with an OOM/eviction history) under a
 *                            5-month lead time = a guest clicks in November and
 *                            gets nothing
 *   DDL on a guest read   -> a November click depends on a CREATE TABLE succeeding,
 *                            so ONE failing DDL statement kills every outstanding
 *                            link in every inbox at once
 *   a code we never wrote -> a `/w/{code}` in delivered mail that Neon has no row
 *                            for: permanently dead, and nobody can report it
 *   id through Number()   -> a 17-digit BMI projectId silently becomes its
 *                            neighbour, and the "organizer" code manages the wrong
 *                            booking
 *   mint throws in a send -> the guest gets no email at all because of a link
 *
 * Neon and Redis are both faked in-memory: the Neon fake enforces the real UNIQUE
 * (location_id, project_id, capability) key so idempotency is exercised rather than
 * asserted, and the Redis fake can be made to fail so the fall-through to Neon is
 * proven, not assumed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeRow {
  code: string;
  capability: string;
  center: string | null;
  location_id: string;
  project_id: string;
  hits: number;
}

interface FakeCall {
  text: string;
  values: unknown[];
}

const neon = {
  configured: true,
  fail: false,
  /**
   * Fail the next N statements, then behave normally. This is the TRANSIENT failure —
   * a dropped connection, a cold start — as opposed to `fail`, which is a database
   * that is simply down. A retry is only worth having if it survives this one, and
   * only defensible if it is bounded.
   */
  failTimes: 0,
  /**
   * Simulate a `waiver_link_codes_idem` index narrowed to (location_id, project_id) —
   * i.e. an UPSERT whose ON CONFLICT no longer discriminates on capability, so it
   * RETURNs the reservation's OTHER row. A schema drift, a hand-built index or a
   * future migration can all produce it, and the consequence is that asking for a
   * `register` code hands back the ORGANIZER one.
   */
  upsertIgnoresCapability: false,
  /**
   * The table is not there yet. Every non-DDL statement then rejects with a real
   * 42P01, exactly like Postgres, and a successful CREATE clears it — so a code path
   * that WRITES before it bootstraps fails here instead of passing by luck.
   */
  missingTable: false,
  /** DDL rejects. `ddlError` chooses WHICH failure: a real outage vs a catalog race. */
  failDdl: false,
  ddlError: null as (Error & { code?: string }) | null,
  /** The INSERT stores + RETURNs a code that could never pass WAIVER_LINK_CODE_RE. */
  mangleCode: false,
  rows: new Map<string, FakeRow>(),
  calls: [] as FakeCall[],
  reset() {
    this.configured = true;
    this.fail = false;
    this.failTimes = 0;
    this.upsertIgnoresCapability = false;
    this.missingTable = false;
    this.failDdl = false;
    this.ddlError = null;
    this.mangleCode = false;
    this.rows.clear();
    this.calls.length = 0;
  },
};

/** A NeonDbError-shaped rejection: the driver puts the SQLSTATE on `.code`. */
function pgError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const cache = {
  fail: false,
  /**
   * Redis took the command and never answered — the shape ioredis produces when a server
   * is unreachable but the socket has not failed yet: commands queue silently. Distinct
   * from `fail` (a rejection) because a STALL is the failure that can outlast the truth,
   * and a cache is never allowed to be slower than the row it caches.
   */
  hang: false,
  store: new Map<string, string>(),
  reset() {
    this.fail = false;
    this.hang = false;
    this.store.clear();
  },
};

vi.mock("@/lib/db", () => {
  const out = (r: FakeRow) => ({
    code: r.code,
    capability: r.capability,
    center: r.center,
    location_id: r.location_id,
    project_id: r.project_id,
  });
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").trim();
    neon.calls.push({ text, values });
    if (neon.fail) return Promise.reject(new Error("neon unreachable"));
    if (neon.failTimes > 0) {
      neon.failTimes -= 1;
      return Promise.reject(new Error("neon connection reset"));
    }
    if (/^CREATE/i.test(text)) {
      if (neon.failDdl) {
        return Promise.reject(
          neon.ddlError ?? pgError("permission denied for schema public", "42501"),
        );
      }
      neon.missingTable = false; // DDL is the only thing that creates it
      return Promise.resolve([]);
    }
    // Postgres does not invent the table for you on a SELECT/INSERT/UPDATE.
    if (neon.missingTable) {
      return Promise.reject(pgError('relation "waiver_link_codes" does not exist', "42P01"));
    }
    if (/^INSERT INTO waiver_link_codes/i.test(text)) {
      const [candidate, capability, center, locationId, projectId] = values as [
        string,
        string,
        string | null,
        string,
        string,
      ];
      // A stored code that the inbound shape gate would reject: a legacy row, a
      // hand-inserted one, or a generator change. `/w/{that}` is dead on arrival.
      const code = neon.mangleCode ? "nope" : candidate;
      // The real UNIQUE (location_id, project_id, capability) index.
      const existing = [...neon.rows.values()].find(
        (r) =>
          r.location_id === locationId &&
          r.project_id === projectId &&
          (neon.upsertIgnoresCapability || r.capability === capability),
      );
      if (existing) {
        existing.center = center ?? existing.center; // COALESCE(EXCLUDED.center, …)
        return Promise.resolve([out(existing)]);
      }
      const row: FakeRow = {
        code,
        capability,
        center: center ?? null,
        location_id: locationId,
        project_id: projectId,
        hits: 0,
      };
      neon.rows.set(code, row);
      return Promise.resolve([out(row)]);
    }
    if (/^SELECT[\s\S]*FROM waiver_link_codes/i.test(text)) {
      const row = neon.rows.get(String(values[0]));
      return Promise.resolve(row ? [out(row)] : []);
    }
    if (/^UPDATE waiver_link_codes/i.test(text)) {
      const row = neon.rows.get(String(values[0]));
      if (row) row.hits += 1;
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return { isDbConfigured: () => neon.configured, sql: () => tag };
});

vi.mock("@/lib/redis", () => ({
  default: {
    async get(key: string) {
      if (cache.hang) return new Promise<string | null>(() => {}); // never settles
      if (cache.fail) throw new Error("redis unreachable");
      return cache.store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      if (cache.hang) return new Promise<string>(() => {});
      if (cache.fail) throw new Error("redis unreachable");
      cache.store.set(key, value);
      return "OK";
    },
  },
}));

import { NextRequest, type NextResponse } from "next/server";
import { buildWaiverUrl } from "~/features/waiver/build-waiver-url";
// The middleware and the resolver route are exercised HERE, in the file that owns
// the short-link contract, because a minted URL that does not resolve on the host it
// was addressed to is a defect in this contract — not in some other file's.
import { config as middlewareConfig, middleware } from "@/middleware";
import { GET as resolveShortLinkRoute } from "@/app/w/[code]/route";
import {
  WAIVER_LINK_CODE_RE,
  WAIVER_LINK_COOKIE,
  WAIVER_LINK_COOKIE_MAX_AGE,
  WAIVER_LINK_PATH,
  WaiverLinkMintError,
  _resetWaiverLinkSchemaCache,
  isDurabilityFailure,
  isRetryableLookup,
  lookupWaiverLink,
  lookupWaiverLinkTarget,
  maskCode,
  mintWaiverLink,
  mintWaiverLinkOrLongUrl,
  recordWaiverLinkHit,
  resolveWaiverLink,
  resolveWaiverLinkTarget,
  waiverLinkGrantsOrganizerFor,
  waiverShortPath,
} from "./waiver-short-link";

/** 63000000004542824 > Number.MAX_SAFE_INTEGER — the production off-by-one id. */
const BIG_PID = "63000000004542824";
/** Its adjacent id. Any Number() round-trip collapses these two together. */
const NEIGHBOUR_PID = "63000000004542825";
/** The brand host most of these links go to — and the one the /hp rewrite breaks. */
const ORIGIN = "https://headpinz.com";
/** The other brand host. ONE stored row has to serve both. */
const FT_ORIGIN = "https://fasttraxent.com";

const FM = {
  center: "fort-myers" as const,
  reservation: { locationId: 467486, projectId: "51383608" },
  origin: ORIGIN,
};

function statements(kind: RegExp): FakeCall[] {
  return neon.calls.filter((c) => kind.test(c.text));
}

beforeEach(() => {
  neon.reset();
  cache.reset();
  _resetWaiverLinkSchemaCache();
});

describe("mintWaiverLink — idempotency", () => {
  it("returns the SAME code and URL every time for one (reservation, capability)", async () => {
    const first = await mintWaiverLink({ ...FM, capability: "organizer" });
    const second = await mintWaiverLink({ ...FM, capability: "organizer" });
    expect(second.code).toBe(first.code);
    expect(second.url).toBe(first.url);
    expect(neon.rows.size).toBe(1);
  });

  it("stays stable when the cache is gone (the mail is already delivered)", async () => {
    const first = await mintWaiverLink({ ...FM, capability: "register" });
    cache.store.clear();
    _resetWaiverLinkSchemaCache();
    const again = await mintWaiverLink({ ...FM, capability: "register" });
    expect(again.code).toBe(first.code);
  });

  it("upserts on the real idempotency key", async () => {
    await mintWaiverLink({ ...FM, capability: "organizer" });
    const ddl = statements(/^CREATE UNIQUE INDEX/i)[0];
    expect(ddl?.text).toContain("waiver_link_codes (location_id, project_id, capability)");
    const insert = statements(/^INSERT INTO waiver_link_codes/i)[0];
    expect(insert?.text).toContain("ON CONFLICT (location_id, project_id, capability)");
    expect(insert?.text).toContain("RETURNING code");
  });

  it("fills in a center that was unknown at first mint, without ever blanking one", async () => {
    const blind = await mintWaiverLink({
      center: null,
      reservation: FM.reservation,
      capability: "organizer",
      origin: ORIGIN,
    });
    expect(blind.center).toBeNull();
    const repaired = await mintWaiverLink({ ...FM, capability: "organizer" });
    expect(repaired.code).toBe(blind.code);
    expect(repaired.center).toBe("fort-myers");
    // A later caller that does not know the center must not undo the repair.
    const third = await mintWaiverLink({
      center: null,
      reservation: FM.reservation,
      capability: "organizer",
      origin: ORIGIN,
    });
    expect(third.center).toBe("fort-myers");
  });
});

describe("mintWaiverLink — capabilities are separate codes", () => {
  it("admin and register for the SAME reservation are DIFFERENT codes", async () => {
    const admin = await mintWaiverLink({ ...FM, capability: "organizer" });
    const register = await mintWaiverLink({ ...FM, capability: "register" });
    expect(admin.code).not.toBe(register.code);
    expect(admin.url).not.toBe(register.url);
    expect(neon.rows.size).toBe(2);
  });

  it("different reservations never share a code", async () => {
    const a = await mintWaiverLink({ ...FM, capability: "organizer" });
    const b = await mintWaiverLink({
      center: "naples",
      reservation: { locationId: 332145, projectId: BIG_PID },
      capability: "organizer",
      origin: ORIGIN,
    });
    expect(a.code).not.toBe(b.code);
  });

  it("refuses an unknown capability", async () => {
    await expect(
      // @ts-expect-error — the point of the guard is callers that lie about the type.
      mintWaiverLink({ ...FM, capability: "owner" }),
    ).rejects.toThrow(/unknown capability/i);
  });
});

describe("mintWaiverLink — the URL that goes in the email", () => {
  it("is the short /w/{code} path on the caller's brand origin", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "register" });
    expect(WAIVER_LINK_PATH).toBe("/w");
    expect(link.url).toBe(`${ORIGIN}${waiverShortPath(link.code)}`);
    expect(new URL(link.url).pathname).toBe(`/w/${link.code}`);
    // Short enough to matter in an SMS.
    expect(link.url.length).toBeLessThan(ORIGIN.length + 24);
  });

  it("never produces a double slash from a trailing-slash origin", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "register", origin: "https://x.com/" });
    expect(link.url).toBe(`https://x.com/w/${link.code}`);
  });

  it("falls back to NEXT_PUBLIC_SITE_URL exactly like buildWaiverUrl does", async () => {
    const prev = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = "https://fasttraxent.com";
    try {
      const link = await mintWaiverLink({
        center: FM.center,
        reservation: FM.reservation,
        capability: "register",
      });
      expect(link.url).toBe(`https://fasttraxent.com/w/${link.code}`);
    } finally {
      process.env.NEXT_PUBLIC_SITE_URL = prev;
    }
  });

  it("carries NO capability in the target the guest's address bar ends up showing", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    expect(link.target).toBe(buildWaiverUrl({ center: "fort-myers", reservation: FM.reservation }));
    expect(link.target).not.toContain(link.code);
    expect(link.target).not.toMatch(/organizer|cap|capab/i);
    // Relative, so the redirect keeps the guest on whichever brand host they opened.
    expect(link.target.startsWith("/waiver")).toBe(true);
  });
});

describe("codes are bearer tokens", () => {
  it("are unguessable, url-safe and never sequential", async () => {
    const codes: string[] = [];
    for (let i = 0; i < 200; i++) {
      const link = await mintWaiverLink({
        center: "naples",
        reservation: { locationId: 332145, projectId: `6300000000454${2000 + i}` },
        capability: "register",
        origin: ORIGIN,
      });
      codes.push(link.code);
    }
    expect(new Set(codes).size).toBe(200);
    for (const c of codes) {
      expect(c).toMatch(WAIVER_LINK_CODE_RE);
      expect(c).toMatch(/^[A-Za-z0-9_-]{16}$/); // 12 random bytes, base64url
      expect(c).not.toContain("=");
    }
    // No two adjacent projectIds produce adjacent codes.
    const sorted = [...codes].sort();
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]).not.toBe(sorted[i - 1]);
  });

  it("are STORED random, not DERIVED from the reservation", async () => {
    // A derived (HMAC) code is unguessable only while the secret is; for a
    // capability that can delete guests, the code must not be computable at all.
    const first = await mintWaiverLink({ ...FM, capability: "organizer" });
    neon.rows.clear();
    cache.store.clear();
    const rebuilt = await mintWaiverLink({ ...FM, capability: "organizer" });
    expect(rebuilt.code).not.toBe(first.code);
  });

  it("masks a code for logging", () => {
    expect(maskCode("AbCdEfGhIjKlMnOp")).toBe("AbCd…");
    expect(maskCode("AbCdEfGhIjKlMnOp")).not.toContain("MnOp");
  });
});

describe("resolveWaiverLink", () => {
  it("returns the right capability, reservation and target", async () => {
    const admin = await mintWaiverLink({ ...FM, capability: "organizer" });
    const register = await mintWaiverLink({ ...FM, capability: "register" });

    const a = await resolveWaiverLink(admin.code);
    expect(a).not.toBeNull();
    expect(a!.capability).toBe("organizer");
    expect(a!.center).toBe("fort-myers");
    expect(a!.reservation).toEqual({ locationId: "467486", projectId: "51383608" });
    expect(a!.target).toBe("/waiver?c=fort-myers&loc=467486&pid=51383608");

    const r = await resolveWaiverLink(register.code);
    expect(r!.capability).toBe("register");
    expect(r!.target).toBe(a!.target); // same page — only the capability differs
  });

  it("returns null for an unknown code", async () => {
    await mintWaiverLink({ ...FM, capability: "organizer" });
    expect(await resolveWaiverLink("aaaaaaaaaaaaaaaa")).toBeNull();
  });

  it("rejects a malformed code without touching the database", async () => {
    neon.calls.length = 0;
    for (const bad of ["", "short", "abc", "!!!!!!!!!!!!!!!!", "a".repeat(65), "a a a a a a a a"]) {
      expect(await resolveWaiverLink(bad)).toBeNull();
    }
    expect(neon.calls).toHaveLength(0);
  });

  it("still resolves when REDIS IS DOWN — Neon is the source of truth", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.fail = true;
    cache.store.clear();
    const resolved = await resolveWaiverLink(link.code);
    expect(resolved?.capability).toBe("organizer");
    expect(resolved?.reservation.projectId).toBe("51383608");
    expect(statements(/^SELECT/i)).toHaveLength(1);
  });

  it("still resolves after the Redis key is evicted, with no TTL on the row", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "register" });
    cache.store.clear(); // eviction / 90-day expiry while the event is 5 months out
    expect((await resolveWaiverLink(link.code))?.code).toBe(link.code);
    // Nothing in the schema or the writes may expire a row.
    const written = neon.calls.map((c) => c.text).join("\n");
    expect(written).not.toMatch(/EXPIRE|INTERVAL '90|TTL/i);
  });

  it("goes to the row for the capability EVERY time, warm cache or not", async () => {
    // The redirect may be cached; the capability may not. Previously a warm cache
    // answered this call with zero SELECTs, which made a disposable 90-day Redis key
    // the authority on a guest-DELETE — see "a capability is only ever the row".
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    neon.calls.length = 0;
    expect((await resolveWaiverLink(link.code))?.capability).toBe("organizer");
    expect(statements(/^SELECT/i)).toHaveLength(1);
    expect((await resolveWaiverLink(link.code))?.capability).toBe("organizer");
    expect(statements(/^SELECT/i)).toHaveLength(2);
  });

  it("treats an unreadable / stale-shaped cache entry as a miss, not as truth", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    for (const junk of [
      "not json",
      JSON.stringify({ v: 99, c: "fort-myers", loc: "467486", pid: "51383608" }),
      // A v1 entry, the shape that used to carry `cap`. Still in Redis for up to 90
      // days after this deploy and must be discarded, never half-read.
      JSON.stringify({ v: 1, cap: "organizer", c: "fort-myers", loc: "467486", pid: "51383608" }),
    ]) {
      cache.store.set(`wvlink:${link.code}`, junk);
      expect((await resolveWaiverLinkTarget(link.code))?.target).toBe(link.target);
      expect((await resolveWaiverLink(link.code))?.capability).toBe("organizer");
    }
  });

  it("grants NOTHING when Neon cannot be read", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.store.clear();
    neon.fail = true;
    expect(await resolveWaiverLink(link.code)).toBeNull();
  });
});

describe("17-digit BMI ids", () => {
  const big = {
    center: "naples" as const,
    reservation: { locationId: 332160, projectId: BIG_PID },
    origin: ORIGIN,
  };

  it("survive minting as an exact string", async () => {
    const link = await mintWaiverLink({ ...big, capability: "organizer" });
    const insert = statements(/^INSERT INTO waiver_link_codes/i)[0]!;
    const stored = insert.values[4];
    expect(typeof stored).toBe("string");
    expect(stored).toBe(BIG_PID);
    expect(link.reservation.projectId).toBe(BIG_PID);
    expect(link.target).toContain(`pid=${BIG_PID}`);
    expect(link.target).not.toContain("6300000000454282e");
  });

  it("survive a resolve round trip", async () => {
    const link = await mintWaiverLink({ ...big, capability: "register" });
    cache.store.clear(); // force the Neon path too
    const resolved = await resolveWaiverLink(link.code);
    expect(resolved!.reservation.projectId).toBe(BIG_PID);
    expect(new URL(resolved!.target, "https://x").searchParams.get("pid")).toBe(BIG_PID);
  });

  it("never appear anywhere as a rounded float", async () => {
    await mintWaiverLink({ ...big, capability: "organizer" });
    const serialized = JSON.stringify(neon.calls);
    expect(serialized).toContain(BIG_PID);
    expect(serialized).not.toMatch(/e\+/);
    expect(serialized).not.toContain("63000000004542820");
  });
});

describe("reservation scope is mandatory", () => {
  it("refuses to mint a capability code that attaches to nothing", async () => {
    await expect(
      mintWaiverLink({
        center: "naples",
        reservation: { locationId: "", projectId: "" },
        capability: "organizer",
      }),
    ).rejects.toThrow(/both required/i);
    await expect(
      mintWaiverLink({
        center: "naples",
        reservation: { locationId: 332145, projectId: "" },
        capability: "organizer",
      }),
    ).rejects.toThrow(/both required/i);
    await expect(
      mintWaiverLink({
        center: "naples",
        reservation: { locationId: 0, projectId: "51383608" },
        capability: "register",
      }),
    ).rejects.toThrow(/both required/i);
    expect(neon.rows.size).toBe(0);
  });

  it("throws rather than mint a code it cannot make durable", async () => {
    neon.configured = false;
    await expect(mintWaiverLink({ ...FM, capability: "organizer" })).rejects.toThrow(
      /DATABASE_URL/,
    );
    neon.configured = true;
    neon.fail = true;
    await expect(mintWaiverLink({ ...FM, capability: "organizer" })).rejects.toThrow(/neon/i);
  });
});

describe("a center is never guessed", () => {
  it("keeps Naples out of Fort Myers", async () => {
    const naples = await mintWaiverLink({
      center: "naples",
      reservation: { locationId: 332145, projectId: "77001" },
      capability: "organizer",
      origin: ORIGIN,
    });
    expect(naples.target).toContain("c=naples");
    expect((await resolveWaiverLink(naples.code))!.target).not.toContain("fort-myers");
  });

  it("drops a center it does not recognise instead of persisting it for months", async () => {
    const link = await mintWaiverLink({
      // @ts-expect-error — a typo'd center would otherwise outlive the event.
      center: "ft-myers",
      reservation: FM.reservation,
      capability: "register",
      origin: ORIGIN,
    });
    expect(link.center).toBeNull();
    expect(link.target).not.toMatch(/[?&]c=/); // not "loc=" — the center param itself
    expect(link.target).toBe("/waiver?loc=467486&pid=51383608");
  });
});

describe("mintWaiverLinkOrLongUrl — a send never dies for a link", () => {
  it("upgrades to the short link when minting works", async () => {
    const sent = await mintWaiverLinkOrLongUrl({ ...FM, capability: "organizer" });
    expect(sent.short).toBe(true);
    expect(sent.code).not.toBeNull();
    expect(sent.url).toBe(`${ORIGIN}/w/${sent.code}`);
  });

  it("degrades to the long sign-only URL when Neon is down", async () => {
    neon.fail = true;
    const sent = await mintWaiverLinkOrLongUrl({ ...FM, capability: "organizer" });
    expect(sent.short).toBe(false);
    expect(sent.code).toBeNull();
    // A usable, correct, absolute link — just without the remove button.
    expect(sent.url).toBe(
      buildWaiverUrl(
        { center: "fort-myers", reservation: FM.reservation },
        { absolute: true, origin: ORIGIN },
      ),
    );
    expect(sent.url).toBe(`${ORIGIN}/waiver?c=fort-myers&loc=467486&pid=51383608`);
    // Degrading must never hand out a capability we have no durable record of.
    expect(sent.url).not.toContain("/w/");
    expect(sent.url).not.toMatch(/organizer|cap=/i);
  });

  it("degrades rather than throwing on a half-set reservation", async () => {
    const sent = await mintWaiverLinkOrLongUrl({
      center: "naples",
      reservation: { locationId: 332145, projectId: "" },
      capability: "organizer",
      origin: ORIGIN,
    });
    expect(sent.short).toBe(false);
    expect(sent.url).toBe(`${ORIGIN}/waiver?c=naples`);
  });

  it("still produces a short link when Redis is down", async () => {
    cache.fail = true;
    const sent = await mintWaiverLinkOrLongUrl({ ...FM, capability: "register" });
    expect(sent.short).toBe(true);
    expect(sent.url).toContain("/w/");
  });
});

describe("waiverLinkGrantsOrganizerFor — the authorization check", () => {
  it("grants only the organizer code, only for its own reservation", async () => {
    const admin = await mintWaiverLink({ ...FM, capability: "organizer" });
    const register = await mintWaiverLink({ ...FM, capability: "register" });
    expect(await waiverLinkGrantsOrganizerFor(admin.code, "51383608")).toBe(true);
    // The whole reason the capability is not a query param.
    expect(await waiverLinkGrantsOrganizerFor(register.code, "51383608")).toBe(false);
    expect(await waiverLinkGrantsOrganizerFor(admin.code, "99999999")).toBe(false);
  });

  it("does not confuse two adjacent 17-digit projectIds", async () => {
    const admin = await mintWaiverLink({
      center: "naples",
      reservation: { locationId: 332160, projectId: BIG_PID },
      capability: "organizer",
      origin: ORIGIN,
    });
    expect(await waiverLinkGrantsOrganizerFor(admin.code, BIG_PID)).toBe(true);
    expect(await waiverLinkGrantsOrganizerFor(admin.code, NEIGHBOUR_PID)).toBe(false);
  });

  it("denies on missing, malformed, unknown or unreadable input", async () => {
    const admin = await mintWaiverLink({ ...FM, capability: "organizer" });
    expect(await waiverLinkGrantsOrganizerFor(null, "51383608")).toBe(false);
    expect(await waiverLinkGrantsOrganizerFor(admin.code, null)).toBe(false);
    expect(await waiverLinkGrantsOrganizerFor(admin.code, "")).toBe(false);
    expect(await waiverLinkGrantsOrganizerFor("' OR 1=1 --", "51383608")).toBe(false);
    expect(await waiverLinkGrantsOrganizerFor("aaaaaaaaaaaaaaaa", "51383608")).toBe(false);
    cache.store.clear();
    neon.fail = true;
    expect(await waiverLinkGrantsOrganizerFor(admin.code, "51383608")).toBe(false);
  });
});

/**
 * ── A capability is only ever the stored row ───────────────────────────────────
 * The escalation these cases exist to prevent, and which this module SHIPPED with:
 * `resolveWaiverLink` answered from the `wvlink:{code}` Redis cache, and that cached
 * payload carried `cap`. So the authority on "may this person delete a guest from
 * someone else's booking" was a disposable, 90-day, never-invalidated key —
 *
 *   - a `wvlink:` entry saying `cap:"organizer"` turned a REGISTER code into an organizer
 *     code, in a store Neon never sees and `hits`/`last_seen_at` never records;
 *   - and it could not be REVOKED: correcting `capability` on the row changed
 *     nothing for up to 90 days, because the row was never read again.
 *
 * Both were live and both are asserted below. The rule these enforce: a capability
 * is READ FROM THE ROW, every time, and is never cached, defaulted, inferred from a
 * target, passed in, or echoed back from a request.
 */
describe("a capability is only ever the stored row", () => {
  /** Everything an attacker with Redis write access could put under a code's key. */
  const forgeries = (loc: string, pid: string) => [
    { v: 1, cap: "organizer", c: "fort-myers", loc, pid },
    { v: 2, cap: "organizer", c: "fort-myers", loc, pid },
    { v: 2, capability: "organizer", c: "fort-myers", loc, pid },
    { v: 2, cap: "ADMIN", admin: true, c: "fort-myers", loc, pid },
  ];

  it("a REGISTER code never yields admin, whatever the cache says", async () => {
    const reg = await mintWaiverLink({ ...FM, capability: "register" });
    for (const forged of forgeries("467486", "51383608")) {
      cache.store.set(`wvlink:${reg.code}`, JSON.stringify(forged));
      expect((await resolveWaiverLink(reg.code))?.capability).toBe("register");
      expect(await waiverLinkGrantsOrganizerFor(reg.code, "51383608")).toBe(false);
    }
  });

  it("a REGISTER code never yields admin by borrowing the organizer code's cache entry", async () => {
    const admin = await mintWaiverLink({ ...FM, capability: "organizer" });
    const reg = await mintWaiverLink({ ...FM, capability: "register" });
    // Copy the organizer code's own cached payload onto the register code's key, and
    // point it back at the organizer code for good measure.
    cache.store.set(`wvlink:${reg.code}`, cache.store.get(`wvlink:${admin.code}`)!);
    expect((await resolveWaiverLink(reg.code))?.capability).toBe("register");
    expect(await waiverLinkGrantsOrganizerFor(reg.code, "51383608")).toBe(false);
    // …and the organizer code is still admin: this is a scoping fix, not a blanket deny.
    expect(await waiverLinkGrantsOrganizerFor(admin.code, "51383608")).toBe(true);
  });

  it("NOTHING a caller passes in can raise a register code", async () => {
    const reg = await mintWaiverLink({ ...FM, capability: "register" });
    const inputs = [
      reg.code,
      `${reg.code}?admin=1`,
      `${reg.code}&cap=organizer`,
      `${reg.code}#organizer`,
      `${reg.code}/organizer`,
      reg.code.toUpperCase(),
      ` ${reg.code} `,
    ];
    for (const attempt of inputs) {
      expect(await waiverLinkGrantsOrganizerFor(attempt, "51383608")).toBe(false);
      const resolved = await resolveWaiverLink(attempt);
      // Either it is not a code at all, or it is the register code. Never admin.
      expect(resolved === null || resolved.capability === "register").toBe(true);
    }
  });

  it("REVOKES on the next request when the row changes — no stale yes anywhere", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    expect(await waiverLinkGrantsOrganizerFor(link.code, "51383608")).toBe(true);
    neon.rows.get(link.code)!.capability = "register"; // ops demotes the row
    expect(await waiverLinkGrantsOrganizerFor(link.code, "51383608")).toBe(false);
    expect((await resolveWaiverLink(link.code))?.capability).toBe("register");
    // And it comes back the moment the row does — the row, nothing else, decides.
    neon.rows.get(link.code)!.capability = "organizer";
    expect(await waiverLinkGrantsOrganizerFor(link.code, "51383608")).toBe(true);
  });

  it("denies rather than guessing when the row's capability is unrecognisable", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    for (const broken of ["Admin", "ADMIN", "", "owner", "admin "]) {
      neon.rows.get(link.code)!.capability = broken;
      expect(await resolveWaiverLink(link.code)).toBeNull();
      expect(await waiverLinkGrantsOrganizerFor(link.code, "51383608")).toBe(false);
    }
  });

  it("stores NO capability in Redis at all — there is nothing there to poison", async () => {
    await mintWaiverLink({ ...FM, capability: "organizer" });
    await mintWaiverLink({ ...FM, capability: "register" });
    expect(cache.store.size).toBe(2);
    for (const payload of cache.store.values()) {
      expect(payload).not.toMatch(/organizer|register|\bcap\b/i);
      // Only the redirect: version, center, and the two ids as strings.
      expect(Object.keys(JSON.parse(payload)).sort()).toEqual(["c", "loc", "pid", "v"]);
    }
  });

  it("cannot report a capability from the cache-first resolver — there is no field", async () => {
    const admin = await mintWaiverLink({ ...FM, capability: "organizer" });
    const target = await resolveWaiverLinkTarget(admin.code);
    expect(target).not.toBeNull();
    expect(Object.keys(target!).sort()).toEqual(["center", "code", "reservation", "target"]);
    expect("capability" in target!).toBe(false);
    // The admin and register redirects are byte-identical, so a forwarded link — or a
    // cached entry — reveals and confers nothing.
    const register = await mintWaiverLink({ ...FM, capability: "register" });
    expect((await resolveWaiverLinkTarget(register.code))?.target).toBe(target!.target);
  });

  it("scopes admin to the ROW's reservation, not to a poisoned target", async () => {
    const admin = await mintWaiverLink({ ...FM, capability: "organizer" });
    // Redirect the code at a different reservation via the cache…
    cache.store.set(
      `wvlink:${admin.code}`,
      JSON.stringify({ v: 2, c: "naples", loc: "332145", pid: NEIGHBOUR_PID }),
    );
    expect((await resolveWaiverLinkTarget(admin.code))?.reservation.projectId).toBe(NEIGHBOUR_PID);
    // …and it authorizes nothing there: the check compares the ROW's projectId.
    expect(await waiverLinkGrantsOrganizerFor(admin.code, NEIGHBOUR_PID)).toBe(false);
    expect(await waiverLinkGrantsOrganizerFor(admin.code, "51383608")).toBe(true);
  });

  it("refuses to hand out a capability the mint did not ask for", async () => {
    // Guards the UPSERT: if `waiver_link_codes_idem` were ever narrowed to
    // (location_id, project_id), ON CONFLICT would start RETURNing the reservation's
    // OTHER row and a `register` request would be answered with the ORGANIZER code — by
    // email, to whoever the booker forwards it to.
    const admin = await mintWaiverLink({ ...FM, capability: "organizer" });
    neon.upsertIgnoresCapability = true;

    await expect(mintWaiverLink({ ...FM, capability: "register" })).rejects.toThrow(
      /capability that was not asked for/i,
    );
    // …and the send path degrades to a sign-only long URL rather than shipping it.
    const sent = await mintWaiverLinkOrLongUrl({ ...FM, capability: "register" });
    expect(sent.short).toBe(false);
    expect(sent.capability).toBeNull();
    expect(sent.url).not.toContain("/w/");
    expect(sent.url).not.toContain(admin.code);
  });

  it("tells a sender which capability it actually got", async () => {
    // Until this field existed, the organizer link and the forwardable register link were
    // indistinguishable at the call site — one mix-up hands every guest the remove
    // button. It reports the ROW's value, never the requested one.
    const admin = await mintWaiverLinkOrLongUrl({ ...FM, capability: "organizer" });
    expect(admin.capability).toBe("organizer");
    const share = await mintWaiverLinkOrLongUrl({ ...FM, capability: "register" });
    expect(share.capability).toBe("register");
    expect(share.url).not.toBe(admin.url);
    neon.fail = true;
    const degraded = await mintWaiverLinkOrLongUrl({ ...FM, capability: "organizer" });
    expect(degraded.capability).toBeNull(); // no code minted = no capability granted
  });
});

describe("a code is a bearer token in the LOGS too", () => {
  it("never writes a full code to the console on any failure path", async () => {
    const errors: string[] = [];
    const spy = (...a: unknown[]) => errors.push(a.map(String).join(" "));
    const realError = console.error;
    const realWarn = console.warn;
    console.error = spy;
    console.warn = spy;
    try {
      const link = await mintWaiverLink({ ...FM, capability: "organizer" });
      cache.store.clear();
      neon.fail = true;
      await resolveWaiverLink(link.code); // resolve failure
      await recordWaiverLinkHit(link.code); // hit-write failure
      await mintWaiverLinkOrLongUrl({ ...FM, capability: "organizer" }); // mint failure
      neon.fail = false;
      neon.configured = false;
      await resolveWaiverLink(link.code); // unconfigured warn
      const logged = errors.join("\n");
      expect(logged.length).toBeGreaterThan(0);
      expect(logged).not.toContain(link.code);
      expect(logged).toContain(maskCode(link.code)); // correlatable, not usable
    } finally {
      console.error = realError;
      console.warn = realWarn;
    }
  });
});

describe("recordWaiverLinkHit", () => {
  it("counts a click in Neon, where it outlives a 90-day Redis TTL", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "register" });
    await recordWaiverLinkHit(link.code);
    await recordWaiverLinkHit(link.code);
    expect(neon.rows.get(link.code)!.hits).toBe(2);
  });

  it("never throws — an audit write may not cost a guest their redirect", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "register" });
    neon.fail = true;
    await expect(recordWaiverLinkHit(link.code)).resolves.toBeUndefined();
    neon.fail = false;
    neon.configured = false;
    await expect(recordWaiverLinkHit(link.code)).resolves.toBeUndefined();
    await expect(recordWaiverLinkHit("bogus")).resolves.toBeUndefined();
  });
});

/**
 * ── Durability: a link that IS in Neon always resolves ─────────────────────────
 * Two independent ways one could still read as dead, both fixed here:
 *
 *   1. Redis was allowed to END a lookup. A miss (eviction, the 90-day TTL, one of
 *      this Redis's OOM flushes) must fall THROUGH to the row, because the row is the
 *      only thing with no expiry and the event may be 5 months out.
 *   2. The read path bootstrapped the schema, which made a November click contingent
 *      on a CREATE TABLE succeeding.
 */
describe("durability — Neon is the truth on the way OUT, not just the way in", () => {
  it("resolves from NEON after the cache is gone, then rehydrates it", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.store.clear(); // eviction / TTL expiry, five months before the event
    neon.calls.length = 0;

    expect((await resolveWaiverLinkTarget(link.code))?.target).toBe(link.target);
    expect(statements(/^SELECT/i)).toHaveLength(1);
    // Rehydrated from the truth, so the next click is a cache hit again.
    expect(cache.store.has(`wvlink:${link.code}`)).toBe(true);
    neon.calls.length = 0;
    expect((await resolveWaiverLinkTarget(link.code))?.target).toBe(link.target);
    expect(statements(/^SELECT/i)).toHaveLength(0);
  });

  it("resolves with the cache gone AND every DDL statement failing", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.store.clear();
    _resetWaiverLinkSchemaCache(); // a cold lambda: nothing latched
    neon.failDdl = true; // e.g. the role lost CREATE, or a lock
    neon.calls.length = 0;

    expect((await resolveWaiverLink(link.code))?.capability).toBe("organizer");
    expect((await resolveWaiverLinkTarget(link.code))?.target).toBe(link.target);
    await expect(recordWaiverLinkHit(link.code)).resolves.toBeUndefined();
    expect(neon.rows.get(link.code)!.hits).toBe(1);
    // …because the read path issues no DDL at all, which is what makes the failure
    // above irrelevant to the guest.
    expect(statements(/^CREATE/i)).toHaveLength(0);
  });

  it("never tries to CREATE the table on a guest read, even when it is missing", async () => {
    neon.missingTable = true;
    _resetWaiverLinkSchemaCache();
    neon.calls.length = 0;

    expect(await resolveWaiverLink("aaaaaaaaaaaaaaaa")).toBeNull();
    expect(await resolveWaiverLinkTarget("aaaaaaaaaaaaaaaa")).toBeNull();
    expect(statements(/^SELECT/i)).toHaveLength(2);
    expect(statements(/^CREATE/i)).toHaveLength(0);
    // …and it does not pretend the missing table was an answer about the code — see
    // "the unknown / unavailable boundary" below.
    expect((await lookupWaiverLink("aaaaaaaaaaaaaaaa")).reason).toBe("unreadable");
  });

  it("separates 'no such code' from 'could not read' — a MISS is the only dead link", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.store.clear();

    // Neon MISS — a verdict. This is the one and only dead link. No `reason`, because
    // there is nothing to explain: the store answered.
    expect(await lookupWaiverLink("aaaaaaaaaaaaaaaa")).toEqual({
      status: "unknown",
      link: null,
      reason: null,
    });
    expect((await lookupWaiverLinkTarget("aaaaaaaaaaaaaaaa")).status).toBe("unknown");

    // Neon ERROR — no verdict. The link may be perfectly valid, so it is retryable and
    // must never be reported to the guest as invalid…
    neon.fail = true;
    expect(await lookupWaiverLink(link.code)).toEqual({
      status: "unavailable",
      link: null,
      reason: "unreadable",
    });
    expect((await lookupWaiverLinkTarget(link.code)).status).toBe("unavailable");
    // …while authorization still says no, because it was never verified.
    expect(await waiverLinkGrantsOrganizerFor(link.code, "51383608")).toBe(false);

    // A warm cache still serves the REDIRECT while the truth is unreadable.
    neon.fail = false;
    await resolveWaiverLinkTarget(link.code);
    neon.fail = true;
    expect((await lookupWaiverLinkTarget(link.code)).status).toBe("found");
  });

  it("treats a missing DATABASE_URL as unavailable, never as an unknown code", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.store.clear();
    neon.configured = false;
    expect((await lookupWaiverLink(link.code)).status).toBe("unavailable");
    expect(await resolveWaiverLink(link.code)).toBeNull();
  });
});

describe("the idempotency key cannot lose a race with its own DDL", () => {
  it("declares UNIQUE (location_id, project_id, capability) in the CREATE TABLE itself", async () => {
    await mintWaiverLink({ ...FM, capability: "organizer" });
    // One statement, one catalog write: there is no window where the table exists and
    // the constraint the UPSERT infers does not.
    expect(statements(/^CREATE TABLE/i)[0]!.text).toMatch(
      /UNIQUE \(location_id, project_id, capability\)/,
    );
  });

  it("writes only AFTER the schema exists, never before", async () => {
    neon.missingTable = true; // a real 42P01 until a CREATE runs
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    expect(link.code).toMatch(WAIVER_LINK_CODE_RE);
    const firstInsert = neon.calls.findIndex((c) => /^INSERT/i.test(c.text));
    const lastDdl = neon.calls.reduce((at, c, i) => (/^CREATE/i.test(c.text) ? i : at), -1);
    expect(lastDdl).toBeGreaterThan(-1);
    expect(firstInsert).toBeGreaterThan(lastDdl);
  });

  it("bootstraps ONCE for concurrent mints in one instance", async () => {
    // A boolean latch lets both callers issue DDL, and concurrent CREATE … IF NOT
    // EXISTS is exactly the catalog race in the next test.
    await Promise.all([
      mintWaiverLink({ ...FM, capability: "organizer" }),
      mintWaiverLink({ ...FM, capability: "register" }),
    ]);
    expect(statements(/^CREATE TABLE/i)).toHaveLength(1);
    expect(neon.rows.size).toBe(2);
  });

  it("survives LOSING the catalog race to another lambda", async () => {
    neon.failDdl = true;
    neon.ddlError = pgError('relation "waiver_link_codes_idem" already exists', "42P07");
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    // The object exists either way — that a peer created it first is not a failure.
    expect(link.code).toMatch(WAIVER_LINK_CODE_RE);
  });

  it("re-bootstraps and retries rather than minting a SECOND code", async () => {
    // An instance that latched a bootstrap from an older deploy, or a table predating
    // the inline UNIQUE: the write fails "schema not ready", not "conflict".
    const first = await mintWaiverLink({ ...FM, capability: "organizer" });
    neon.missingTable = true;
    neon.calls.length = 0;

    const again = await mintWaiverLink({ ...FM, capability: "organizer" });
    expect(again.code).toBe(first.code); // still ONE code per reservation
    expect(statements(/^CREATE TABLE/i)).toHaveLength(1);
    expect(statements(/^INSERT/i)).toHaveLength(2); // failed write -> bootstrap -> retry
  });

  it("does not re-bootstrap on a plain outage — only on a missing schema", async () => {
    await mintWaiverLink({ ...FM, capability: "organizer" });
    neon.fail = true;
    neon.calls.length = 0;
    await expect(mintWaiverLink({ ...FM, capability: "register" })).rejects.toThrow(/neon/i);
    expect(statements(/^INSERT/i)).toHaveLength(1); // one attempt, no retry
    expect(statements(/^CREATE/i)).toHaveLength(0);
  });
});

describe("a code is handed out ONLY when Neon stored it", () => {
  it("hands out nothing when the write cannot be confirmed", async () => {
    neon.fail = true;
    const sent = await mintWaiverLinkOrLongUrl({ ...FM, capability: "organizer" });
    expect(sent.code).toBeNull();
    expect(sent.short).toBe(false);
    expect(sent.url).not.toContain("/w/");
    expect(sent.failure).toBe("not-persisted");
    expect(isDurabilityFailure(sent.failure)).toBe(true);
    expect(neon.rows.size).toBe(0);
  });

  it("refuses a stored code that could never resolve", async () => {
    // A link that 404s in November is worse than no link in July: the guest cannot
    // even report it, because it looks like ours.
    neon.mangleCode = true;
    const err = await mintWaiverLink({ ...FM, capability: "organizer" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaiverLinkMintError);
    expect((err as WaiverLinkMintError).failure).toBe("unusable-row");

    const sent = await mintWaiverLinkOrLongUrl({ ...FM, capability: "organizer" });
    expect(sent.code).toBeNull();
    expect(sent.url).not.toContain("/w/");
    expect(sent.failure).toBe("unusable-row");
    // Proof it would have been dead: the code the row actually holds resolves to
    // nothing, because the resolver gates on the same shape the mint just enforced.
    expect(neon.rows.has("nope")).toBe(true);
    expect(await resolveWaiverLink("nope")).toBeNull();
  });

  it("emits the code the ROW holds, never the candidate it generated", async () => {
    const first = await mintWaiverLink({ ...FM, capability: "organizer" });
    const second = await mintWaiverLink({ ...FM, capability: "organizer" });
    const candidates = statements(/^INSERT/i).map((c) => c.values[0]);
    // The second mint generated a fresh candidate and threw it away: `RETURNING` gave
    // back the stored code, which is the one already in delivered mail.
    expect(candidates[1]).not.toBe(candidates[0]);
    expect(second.code).toBe(first.code);
    expect(second.code).toBe(candidates[0]);
    expect(await resolveWaiverLink(second.code)).not.toBeNull();
  });

  it("says WHICH degradation it was, so only the loud one is worth alerting on", async () => {
    // Nothing was written: expected, quiet, nothing to reconcile.
    const halfSet = await mintWaiverLinkOrLongUrl({
      center: "naples",
      reservation: { locationId: 332145, projectId: "" },
      capability: "organizer",
      origin: ORIGIN,
    });
    expect(halfSet.failure).toBe("invalid-input");
    expect(isDurabilityFailure(halfSet.failure)).toBe(false);

    neon.configured = false;
    const unconfigured = await mintWaiverLinkOrLongUrl({ ...FM, capability: "organizer" });
    expect(unconfigured.failure).toBe("not-configured");
    expect(isDurabilityFailure(unconfigured.failure)).toBe(false);

    // A write was attempted and cannot be accounted for: loud.
    neon.configured = true;
    neon.fail = true;
    const lost = await mintWaiverLinkOrLongUrl({ ...FM, capability: "organizer" });
    expect(lost.failure).toBe("not-persisted");
    expect(isDurabilityFailure(lost.failure)).toBe(true);

    // Success reports nothing at all.
    neon.fail = false;
    expect((await mintWaiverLinkOrLongUrl({ ...FM, capability: "organizer" })).failure).toBeNull();
  });
});

/** A browser-shaped GET. The `host` header is what middleware.ts switches brand on. */
function waiverLinkRequest(url: string, ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)") {
  return new NextRequest(url, { headers: { host: new URL(url).host, "user-agent": ua } });
}

/**
 * Open `/w/{code}` the way a guest does. Module scope, not describe scope: the
 * unknown/unavailable boundary is only half a contract if it is asserted at the library
 * and never at the surface the guest actually touches, so two describes need these.
 */
const open = (code: string, opts: { ua?: string; host?: string } = {}) =>
  resolveShortLinkRoute(
    waiverLinkRequest(`https://${opts.host ?? "headpinz.com"}/w/${code}`, opts.ua),
    { params: Promise.resolve({ code }) },
  );
const cookieOf = (res: NextResponse) => res.cookies.get(WAIVER_LINK_COOKIE);
const setCookieHeader = (res: NextResponse) => res.headers.get("set-cookie") || "";

/**
 * ── The link has to work on the host it was addressed to ──────────────────────
 * This module mints `https://headpinz.com/w/{code}` for a HeadPinz send. middleware.ts
 * rewrites every UNREGISTERED top-level path on that host into `/hp/*`, where no route
 * exists — so until `/w/` was added to `isSharedTopLevelRoute`, every HeadPinz waiver
 * link in every confirmation email and SMS was a 404, exactly as CLAUDE.md warns:
 * "NEVER add a new top-level page ... without updating isSharedTopLevelRoute —
 * HeadPinz visitors will 404 otherwise."
 *
 * The middleware cannot import WAIVER_LINK_PATH (it runs on the Edge; this module pulls
 * in node:crypto, ioredis and Neon), so the constant and the registration are pinned
 * together HERE: these tests build the path from WAIVER_LINK_PATH and a real minted
 * code, so changing either side alone goes red.
 */
describe("the minted link routes on BOTH brand hosts", () => {
  /** NextResponse.rewrite() reports its destination in this header; next() does not. */
  const rewriteOf = (res: Response) => res.headers.get("x-middleware-rewrite");

  it("is NOT /hp-rewritten on headpinz.com", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    expect(link.url).toBe(`https://headpinz.com${WAIVER_LINK_PATH}/${link.code}`);
    const res = await middleware(waiverLinkRequest(link.url));
    expect(rewriteOf(res)).toBeNull();
    expect(res.status).toBe(200); // next() — reaches app/w/[code]/route.ts
    expect(res.headers.get("location")).toBeNull(); // not redirected away either
  });

  it("passes straight through on fasttraxent.com", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "register", origin: FT_ORIGIN });
    const res = await middleware(waiverLinkRequest(link.url));
    expect(rewriteOf(res)).toBeNull();
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("CONTROL: the /hp rewrite it dodges is real, and /w/ does not over-match", async () => {
    // Proves the pin above is meaningful rather than vacuous, AND that the
    // registration is `startsWith("/w/")` and not `startsWith("/w")` — a bare "/w"
    // test would swallow every top-level path beginning with "w" (including /waiver
    // and /waiver-3) and silently un-brand it.
    for (const p of ["/whats-on", "/w", "/waiver-2026"]) {
      const res = await middleware(waiverLinkRequest(`https://headpinz.com${p}`));
      expect(rewriteOf(res)).toContain(`/hp${p}`);
    }
    // …while the waiver page itself keeps its own long-standing registration.
    expect(
      rewriteOf(await middleware(waiverLinkRequest("https://headpinz.com/waiver"))),
    ).toBeNull();
  });

  it("is a path the middleware actually inspects (so registration is load-bearing)", () => {
    const matcher = new RegExp(`^${middlewareConfig.matcher[0]}$`);
    expect(matcher.test(`${WAIVER_LINK_PATH}/AbCdEfGhIjKlMnOp`)).toBe(true);
  });
});

/**
 * ── app/w/[code]/route.ts — what the guest's click actually does ───────────────
 * Redirect, not render: a RELATIVE Location keeps the guest on whichever brand host
 * they opened, with no origin to reconstruct. The code travels in an HttpOnly cookie
 * because it is a bearer token — in the query string it would be in the address bar,
 * the history, a screenshot of the roster, and every outbound Referer.
 */
describe("/w/{code} resolver route", () => {
  it("sends the guest to the reservation's waiver page, host-relative", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    const res = await open(link.code);
    expect(res.status).toBe(302);
    // Relative — no host, so headpinz.com stays headpinz.com and fasttraxent.com stays
    // fasttraxent.com off ONE stored row.
    expect(res.headers.get("location")).toBe("/waiver?c=fort-myers&loc=467486&pid=51383608");
    expect(res.headers.get("location")).toBe(link.target);
    expect(res.headers.get("location")!.startsWith("/")).toBe(true);
  });

  it("never puts the bearer token in the address bar, and never caches it", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    const res = await open(link.code);
    expect(res.headers.get("location")).not.toContain(link.code);
    expect(res.headers.get("location")).not.toMatch(/organizer|cap/i);
    // A Set-Cookie carrying a capability may never be held by a shared cache.
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(cookieOf(res)?.value).toBe(link.code);
    expect(setCookieHeader(res)).toMatch(/httponly/i);
    expect(setCookieHeader(res)).toMatch(/samesite=lax/i);
    expect(setCookieHeader(res)).toMatch(/path=\//i);
    expect(setCookieHeader(res)).toContain(`Max-Age=${WAIVER_LINK_COOKIE_MAX_AGE}`);
  });

  it("hands over the arrival code WITHOUT deciding what it grants", async () => {
    // The route reads no capability at all. A forwarded register code is inert
    // because the authorization check goes to the row — not because /w/ filtered it.
    const register = await mintWaiverLink({ ...FM, capability: "register" });
    const res = await open(register.code);
    expect(cookieOf(res)?.value).toBe(register.code);
    expect(await waiverLinkGrantsOrganizerFor(cookieOf(res)!.value, "51383608")).toBe(false);
  });

  it("cannot inherit admin on a shared device: the last link opened wins", async () => {
    const admin = await mintWaiverLink({ ...FM, capability: "organizer" });
    const register = await mintWaiverLink({ ...FM, capability: "register" });
    // Booker signs via their organizer link on the in-center tablet…
    expect(cookieOf(await open(admin.code))?.value).toBe(admin.code);
    // …then the next guest opens the forwarded sign-only link on the same device.
    const second = await open(register.code);
    expect(cookieOf(second)?.value).toBe(register.code);
    expect(cookieOf(second)?.value).not.toBe(admin.code);
    expect(await waiverLinkGrantsOrganizerFor(cookieOf(second)!.value, "51383608")).toBe(false);
  });

  it("is never a dead end: an unknown code signs standalone and CLEARS the grant", async () => {
    const admin = await mintWaiverLink({ ...FM, capability: "organizer" });
    expect(cookieOf(await open(admin.code))?.value).toBe(admin.code);
    const res = await open("aaaaaaaaaaaaaaaa"); // well-formed, not ours
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/waiver");
    expect(cookieOf(res)?.value).toBe("");
    expect(setCookieHeader(res)).toContain("Max-Age=0");
  });

  it("rejects a malformed code without touching the database", async () => {
    neon.calls.length = 0;
    for (const bad of ["short", "!!!!!!!!!!!!!!!!", "a".repeat(65), "' OR 1=1 --"]) {
      const res = await open(bad);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/waiver");
      expect(cookieOf(res)?.value).toBe("");
    }
    expect(neon.calls).toHaveLength(0);
  });

  it("still resolves when Redis is down — a cache miss is not evidence about the link", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.fail = true;
    cache.store.clear();
    const res = await open(link.code);
    expect(res.headers.get("location")).toBe(link.target);
    expect(cookieOf(res)?.value).toBe(link.code);
  });

  /**
   * ── `unavailable` is NOT `unknown`, and the difference is the whole point ──────
   * These four cases replace one that asserted a Neon outage should 302 a guest to
   * standalone `/waiver` with `Max-Age=0` on the grant cookie. That was two silent
   * failures wearing a "degrade gracefully" costume:
   *
   *   1. the guest signs a waiver attached to NOTHING and believes they are done —
   *      nobody finds it at the counter, and they sign again;
   *   2. a dropped connection REVOKES the booker's admin grant. The row still says
   *      `organizer`; nothing revoked it. (Module rule: revoke a status only with the
   *      same reach that granted it — that reach is the row.)
   *
   * A dead link is the one thing a redirect-to-standalone is right for, and Neon
   * being unreachable is not evidence of one.
   */
  it("an UNREADABLE code is explained, never redirected to an unattached waiver", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.store.clear();
    neon.fail = true;
    const res = await open(link.code);
    expect(res.status).toBe(503); // not a 500 either — this is retryable and says so
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const body = await res.text();
    expect(body).toMatch(/try again/i);
    // Still a bearer token, and this is the page a stuck guest screenshots for staff.
    expect(body).not.toContain(link.code);
  });

  it("does NOT let a database blip revoke a grant nobody revoked", async () => {
    const admin = await mintWaiverLink({ ...FM, capability: "organizer" });
    expect(cookieOf(await open(admin.code))?.value).toBe(admin.code);

    cache.store.clear();
    neon.fail = true;
    const blip = await open(admin.code);
    // No Set-Cookie AT ALL — neither a set nor a clear. We learned nothing about this
    // code, so nothing about the device's grant may change.
    expect(setCookieHeader(blip)).toBe("");
    expect(cookieOf(blip)).toBeUndefined();

    // And recovery costs the booker nothing: the cookie the browser still holds works
    // the moment Neon answers again. No re-clicking the email, no re-send.
    neon.fail = false;
    expect(await waiverLinkGrantsOrganizerFor(admin.code, "51383608")).toBe(true);
  });

  it("recovers on the retry, so one dropped connection costs the guest nothing", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.store.clear();
    neon.failTimes = 1; // the first read drops; the second is fine
    const res = await open(link.code);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(link.target);
    expect(cookieOf(res)?.value).toBe(link.code);
  });

  it("retries an unreadable read ONCE, and never retries a verdict", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.store.clear();
    neon.fail = true;
    neon.calls.length = 0;
    await open(link.code);
    // Bounded: two attempts, not a loop against a database that is already failing.
    expect(statements(/^SELECT/i)).toHaveLength(2);

    // `unknown` is an ANSWER. Asking a second time cannot change it, and a dead link
    // must not cost twice the reads — these arrive in bulk when mail is forwarded.
    neon.fail = false;
    cache.store.clear();
    neon.calls.length = 0;
    const res = await open("aaaaaaaaaaaaaaaa");
    expect(statements(/^SELECT/i)).toHaveLength(1);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/waiver");
  });

  it("counts a human click and ignores a link-preview bot", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "register" });
    await open(link.code, { ua: "WhatsApp/2.23 facebookexternalhit/1.1" });
    expect(neon.rows.get(link.code)!.hits).toBe(0);
    await open(link.code);
    expect(neon.rows.get(link.code)!.hits).toBe(1);
  });
});

/**
 * ── UNKNOWN vs UNAVAILABLE — the error-classification boundary ─────────────────
 * `unknown` may be said only when the STORE ANSWERED and had no such code. Everything
 * else — a read that threw, a cache that stalled, a table that is not in the database we
 * asked, a row we cannot use — is the ABSENCE of that answer, and a guest holding a VALID
 * link must never be treated as though it were dead because of one.
 *
 * Two more ways a link that IS in Neon still failed the guest (the cache order and the
 * DDL placement above were the first two), both fixed here, both previously unasserted:
 *
 *   3. 42P01 — `waiver_link_codes` not in this database — was reported as `unknown`.
 *      Minting is the only thing that ever creates that table, so a code in an inbox is
 *      proof it existed when the code was minted: on a READ, 42P01 means the wrong
 *      database (an unmigrated Neon branch), a dropped/renamed table, or a moved
 *      search_path. Every outstanding link was told it was dead AND had its grant cookie
 *      cleared — terminally, never retried — off one catalog mistake.
 *   4. A row whose `capability` column was unrecognisable made the REDIRECT
 *      `unavailable`. Its ids and code were fine, so the target was perfectly derivable,
 *      yet `/w/{code}` served a permanent 503 reading "your link is still good, please
 *      try again" to a booker who could then never sign. A corrupt string does not heal
 *      on a retry, and the redirect never depended on the capability in the first place.
 *
 * The reason field is what makes the second half sayable: `unreadable` = we never got an
 * answer (retryable, never a dead link, never revokes a grant); `unusable-row` = we DID
 * read the truth and it cannot answer (the code exists, so never `unknown`; permanent, so
 * never "try again").
 */
describe("the unknown / unavailable boundary", () => {
  it("NEON DOWN with a live row is unavailable/unreadable — never unknown", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.store.clear();
    neon.fail = true;

    const cap = await lookupWaiverLink(link.code);
    expect(cap.status).toBe("unavailable");
    expect(cap.reason).toBe("unreadable");
    expect(cap.status).not.toBe("unknown");
    expect(isRetryableLookup(cap)).toBe(true);

    const tgt = await lookupWaiverLinkTarget(link.code);
    expect(tgt.status).toBe("unavailable");
    expect(tgt.reason).toBe("unreadable");

    // NON-VACUITY: the row was there the whole time, and the very same code resolves the
    // moment the fault clears — so "not unknown" above is about the classification, not
    // about a missing row, a bad code or a shape rejection.
    expect(neon.rows.has(link.code)).toBe(true);
    neon.fail = false;
    const recovered = await lookupWaiverLink(link.code);
    expect(recovered.status).toBe("found");
    expect(recovered.link!.capability).toBe("organizer");
  });

  it("the TABLE MISSING from this database is unreadable — the guest retries, the grant survives", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    // The grant exists on the device first, so the assertion that it survives is real.
    expect(cookieOf(await open(link.code))?.value).toBe(link.code);

    cache.store.clear();
    _resetWaiverLinkSchemaCache();
    neon.missingTable = true; // a real 42P01 on every non-DDL statement

    const cap = await lookupWaiverLink(link.code);
    expect(cap.status).toBe("unavailable"); // NOT "unknown" — this says nothing about the code
    expect(cap.reason).toBe("unreadable");
    expect((await lookupWaiverLinkTarget(link.code)).reason).toBe("unreadable");

    neon.calls.length = 0;
    const res = await open(link.code);
    expect(res.status).toBe(503); // asked to retry — not redirected to an unattached waiver
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("retry-after")).toBe("5");
    // No Set-Cookie at all: a catalog fault may not revoke what the row still grants.
    expect(setCookieHeader(res)).toBe("");
    expect(statements(/^SELECT/i)).toHaveLength(2); // retried once, bounded
    expect(statements(/^CREATE/i)).toHaveLength(0); // and still no DDL on a guest read

    // NON-VACUITY: restore the table and the SAME code resolves with the SAME grant — no
    // re-send, no re-click, nothing lost. Which is exactly what "unknown" threw away.
    neon.missingTable = false;
    expect(neon.rows.has(link.code)).toBe(true);
    const back = await open(link.code);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(link.target);
    expect(cookieOf(back)?.value).toBe(link.code);
    expect(await waiverLinkGrantsOrganizerFor(link.code, "51383608")).toBe(true);
  });

  it("a CACHE READ THAT STALLS with a live row still resolves, from the truth", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    // The key is WARM — the stall is the only fault. ioredis queues commands against an
    // unreachable server, so an unbounded GET would sit here instead of reading the row.
    expect(cache.store.has(`wvlink:${link.code}`)).toBe(true);
    cache.hang = true;
    neon.calls.length = 0;

    const tgt = await lookupWaiverLinkTarget(link.code);
    expect(tgt.status).toBe("found"); // not unknown, and not unavailable either
    expect(tgt.reason).toBeNull();
    expect(tgt.link!.target).toBe(link.target);
    // It came from Neon: a stalled cache read is a miss, and a miss only routes us on.
    expect(statements(/^SELECT/i)).toHaveLength(1);

    // …and the guest's click behaves identically: a stalled write cannot hold the redirect.
    const res = await open(link.code);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(link.target);
    expect(cookieOf(res)?.value).toBe(link.code);
    expect(await waiverLinkGrantsOrganizerFor(link.code, "51383608")).toBe(true);
  });

  it("a GENUINELY ABSENT code IS unknown — and only after the store answered", async () => {
    await mintWaiverLink({ ...FM, capability: "organizer" }); // a live table with rows in it
    cache.store.clear();
    const absent = "aaaaaaaaaaaaaaaa"; // well-formed, never minted
    expect(absent).toMatch(WAIVER_LINK_CODE_RE);
    expect(neon.rows.has(absent)).toBe(false);
    neon.calls.length = 0;

    const cap = await lookupWaiverLink(absent);
    expect(cap).toEqual({ status: "unknown", link: null, reason: null });
    expect(isRetryableLookup(cap)).toBe(false); // a verdict is not worth asking twice
    expect((await lookupWaiverLinkTarget(absent)).status).toBe("unknown");
    // A VERDICT, not a shape rejection: the store was actually asked before we said no.
    expect(statements(/^SELECT/i)).toHaveLength(2);

    const res = await open(absent);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/waiver"); // standalone signing, never a 404
    expect(cookieOf(res)?.value).toBe("");
  });

  it("a row with an UNRECOGNISED CAPABILITY keeps its redirect and grants nothing", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    // NON-VACUITY: it grants admin BEFORE the corruption, so everything below is about
    // the capability column and nothing else.
    expect(await waiverLinkGrantsOrganizerFor(link.code, "51383608")).toBe(true);
    cache.store.clear();
    neon.rows.get(link.code)!.capability = "Admin"; // ops typo / another vocabulary

    // The code EXISTS, so this is never `unknown`; there is no capability to report, so
    // it is never `found`; the row will read the same way in 200ms, so it is not retryable.
    const cap = await lookupWaiverLink(link.code);
    expect(cap.status).toBe("unavailable");
    expect(cap.reason).toBe("unusable-row");
    expect(isRetryableLookup(cap)).toBe(false);

    // …but WHERE to send the guest never depended on the capability. Cache cleared and
    // call log reset FIRST: the previous lookup rehydrated the key off the same row, and a
    // "found" served from that warm key would pass this even if the row path still failed.
    cache.store.clear();
    neon.calls.length = 0;
    const tgt = await lookupWaiverLinkTarget(link.code);
    expect(tgt.status).toBe("found");
    expect(tgt.reason).toBeNull();
    expect(tgt.link!.target).toBe(link.target);
    expect(statements(/^SELECT/i)).toHaveLength(1); // from the ROW, not from the cache
    expect("capability" in tgt.link!).toBe(false); // still no such field on this shape

    // The guest lands on their OWN reservation's waiver page — not a permanent 503 that
    // claims the link is still good, and not standalone signing either.
    cache.store.clear(); // force the route through the row, not a warm key
    neon.calls.length = 0;
    const res = await open(link.code);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(link.target);
    expect(cookieOf(res)?.value).toBe(link.code);
    expect(statements(/^SELECT/i)).toHaveLength(1); // read once — a corrupt row is not retried
    // And the cookie it carries is inert: a capability is only ever a recognised row value.
    expect(await waiverLinkGrantsOrganizerFor(link.code, "51383608")).toBe(false);
  });

  it("a row that points at NO RESERVATION is unusable-row — not unknown, not a 503 loop", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.store.clear();
    neon.rows.get(link.code)!.project_id = ""; // corrupted after the mint: nothing to attach to

    const cap = await lookupWaiverLink(link.code);
    expect(cap.status).toBe("unavailable"); // the code exists — never `unknown`
    expect(cap.reason).toBe("unusable-row");
    expect(isRetryableLookup(cap)).toBe(false);
    const tgt = await lookupWaiverLinkTarget(link.code);
    expect(tgt.status).toBe("unavailable");
    expect(tgt.reason).toBe("unusable-row");
    expect(tgt.link).toBeNull();

    // The guest signs standalone instead of reloading a 503 forever: a row attached to
    // nothing is worth what an unknown code is worth. Clearing the grant is legitimate
    // here because we READ the row — the same reach that granted it.
    cache.store.clear();
    neon.calls.length = 0;
    const res = await open(link.code);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/waiver");
    expect(cookieOf(res)?.value).toBe("");
    expect(statements(/^SELECT/i)).toHaveLength(1); // read once, never retried
  });

  it("CONTROL: the statuses are actually distinguishable, and exactly one is retryable", async () => {
    // The guard against a fix that just relabels everything: a blanket "always
    // unavailable" (or "always unknown") implementation fails every line below, which is
    // what makes the assertions in this block non-vacuous.
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.store.clear();

    const found = await lookupWaiverLink(link.code);
    const absent = await lookupWaiverLink("aaaaaaaaaaaaaaaa");
    neon.fail = true;
    const unreadable = await lookupWaiverLink(link.code);
    neon.fail = false;
    neon.rows.get(link.code)!.capability = "owner";
    const corrupt = await lookupWaiverLink(link.code);

    expect([found.status, absent.status, unreadable.status, corrupt.status]).toEqual([
      "found",
      "unknown",
      "unavailable",
      "unavailable",
    ]);
    expect([found.reason, absent.reason, unreadable.reason, corrupt.reason]).toEqual([
      null,
      null,
      "unreadable",
      "unusable-row",
    ]);
    expect([found, absent, unreadable, corrupt].map(isRetryableLookup)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it("CONTROL: the whole guest-facing matrix — no 404, no 500, and the right destination", async () => {
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    // Status AND destination: a 302 alone cannot tell "your reservation's waiver page"
    // from "sign standalone, we lost your booking", and that difference is the defect.
    const seen: [number, string | null][] = [];
    const record = async (code: string) => {
      const res = await open(code);
      seen.push([res.status, res.headers.get("location")]);
    };

    await record(link.code); // live
    await record("aaaaaaaaaaaaaaaa"); // absent
    await record("!!!"); // malformed — never reaches the store

    cache.store.clear();
    neon.fail = true;
    await record(link.code); // Neon down
    neon.fail = false;

    neon.missingTable = true;
    await record(link.code); // table not in this database
    neon.missingTable = false;

    cache.store.clear();
    neon.rows.get(link.code)!.capability = "owner";
    await record(link.code); // capability column corrupt

    cache.store.clear();
    neon.rows.get(link.code)!.capability = "organizer";
    neon.rows.get(link.code)!.project_id = "";
    await record(link.code); // row points nowhere

    // A read that never answered EXPLAINS itself (503, retryable, no destination); every
    // ANSWER, however bad, still puts the guest in front of a waiver they can sign — and a
    // link that IS in the store keeps its own reservation whenever the row still names one.
    expect(seen).toEqual([
      [302, link.target], // live
      [302, "/waiver"], // absent — standalone
      [302, "/waiver"], // malformed — standalone
      [503, null], // Neon down — explained, never redirected
      [503, null], // table missing — same: unreadable, not dead
      [302, link.target], // capability corrupt — STILL their own reservation
      [302, "/waiver"], // row points nowhere — standalone is all it is worth
    ]);
    expect(seen.filter(([s]) => s === 404 || (s >= 500 && s !== 503))).toEqual([]);
  });

  it("the convenience resolvers collapse both cases into null — so nothing may branch on it", async () => {
    // `resolveWaiverLink` / `resolveWaiverLinkTarget` cannot tell a dead link from an
    // outage, by construction. This pins the doc warning: guest-facing copy and cookie
    // clearing must come from a STATUS, which is what /w/{code} uses.
    const link = await mintWaiverLink({ ...FM, capability: "organizer" });
    cache.store.clear();
    neon.fail = true;
    const unreadable = await resolveWaiverLink(link.code);
    const unreadableTarget = await resolveWaiverLinkTarget(link.code);
    neon.fail = false;
    const gone = await resolveWaiverLink("aaaaaaaaaaaaaaaa");
    const goneTarget = await resolveWaiverLinkTarget("aaaaaaaaaaaaaaaa");
    expect([unreadable, unreadableTarget, gone, goneTarget]).toEqual([null, null, null, null]);

    // …while the status-bearing forms DO separate them under the identical conditions.
    neon.fail = true;
    expect((await lookupWaiverLink(link.code)).status).toBe("unavailable");
    neon.fail = false;
    expect((await lookupWaiverLink("aaaaaaaaaaaaaaaa")).status).toBe("unknown");
  });
});
