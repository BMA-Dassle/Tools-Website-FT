import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encode } from "@auth/core/jwt";
import {
  REQUIRED_ROLE,
  SECURE_SESSION_COOKIE,
  SESSION_COOKIE,
  hasSsoAccess,
  readCookieValue,
  readSsoSession,
  sessionCookieNames,
} from "./session";

/**
 * The middleware's session reader, against cookies Auth.js itself wrote.
 *
 * `encode` here is the exact function `auth.ts` uses to write the session
 * cookie; `readSsoSession` is what the edge gate uses to read it. Those two are
 * the only pair in the SSO path that could drift silently — nothing else
 * connects them, because the middleware deliberately does not import the
 * Auth.js wrapper (see the header of `session.ts`). So they are tested
 * together, end to end, with no mocks anywhere.
 */

const SECRET = "session-test-secret";

function cookies(map: Record<string, string>) {
  return { get: (name: string) => (name in map ? { value: map[name] } : undefined) };
}

function request(map: Record<string, string>, protocol = "http:") {
  return { cookies: cookies(map), nextUrl: { protocol } };
}

async function token(payload: Record<string, unknown>, salt: string, secret = SECRET) {
  return encode({ token: payload, secret, salt, maxAge: 8 * 60 * 60 });
}

beforeEach(() => {
  process.env.AUTH_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.AUTH_SECRET;
});

describe("readSsoSession", () => {
  it("reads back a cookie Auth.js's own encode produced", async () => {
    const t = await token(
      { email: "eric@headpinz.com", name: "Eric Osborn", roles: ["access"] },
      SESSION_COOKIE,
    );
    expect(await readSsoSession(request({ [SESSION_COOKIE]: t }))).toEqual({
      email: "eric@headpinz.com",
      name: "Eric Osborn",
      roles: ["access"],
    });
  });

  it("reads the __Secure- name on https — the NAME is the HKDF salt", async () => {
    // A name/salt mismatch does not error, it silently never matches. Both
    // directions are checked because production is https and dev is http.
    const secure = await token({ roles: ["access"] }, SECURE_SESSION_COOKIE);
    expect(await readSsoSession(request({ [SECURE_SESSION_COOKIE]: secure }, "https:"))).toEqual({
      email: undefined,
      name: undefined,
      roles: ["access"],
    });

    const plain = await token({ roles: ["access"] }, SESSION_COOKIE);
    expect(await readSsoSession(request({ [SESSION_COOKIE]: plain }, "https:"))).toMatchObject({
      roles: ["access"],
    });
  });

  it("does not accept a cookie salted with the OTHER name", async () => {
    // Same secret, wrong salt → a different key → no session. Proves the salt
    // is actually in play rather than being cosmetic.
    const wrongSalt = await token({ roles: ["access"] }, "authjs.some-other-cookie");
    expect(await readSsoSession(request({ [SESSION_COOKIE]: wrongSalt }))).toBeNull();
  });

  it("reassembles a chunked cookie", async () => {
    const t = await token({ email: "long@headpinz.com", roles: ["access"] }, SESSION_COOKIE);
    const mid = Math.floor(t.length / 2);
    const chunked = {
      [`${SESSION_COOKIE}.0`]: t.slice(0, mid),
      [`${SESSION_COOKIE}.1`]: t.slice(mid),
    };
    expect(await readSsoSession(request(chunked))).toMatchObject({ roles: ["access"] });
  });

  it("returns null — never throws — for every unreadable case", async () => {
    const good = await token({ roles: ["access"] }, SESSION_COOKIE);

    expect(await readSsoSession(request({}))).toBeNull();
    expect(await readSsoSession(request({ [SESSION_COOKIE]: "not-a-jwt" }))).toBeNull();
    expect(
      await readSsoSession(request({ [SESSION_COOKIE]: `${good.slice(0, -3)}aaa` })),
    ).toBeNull();

    const otherSecret = await token({ roles: ["access"] }, SESSION_COOKIE, "a-retired-secret");
    expect(await readSsoSession(request({ [SESSION_COOKIE]: otherSecret }))).toBeNull();

    delete process.env.AUTH_SECRET;
    expect(await readSsoSession(request({ [SESSION_COOKIE]: good }))).toBeNull();
  });

  it("drops non-string roles rather than trusting the payload's shape", async () => {
    const t = await token({ roles: ["access", 7, null, "marketing"], email: 42 }, SESSION_COOKIE);
    expect(await readSsoSession(request({ [SESSION_COOKIE]: t }))).toEqual({
      email: undefined,
      name: undefined,
      roles: ["access", "marketing"],
    });
  });

  it("rejects an expired session — the 8h cap is enforced by decode, not by us", async () => {
    const expired = await encode({
      token: { roles: ["access"] },
      secret: SECRET,
      salt: SESSION_COOKIE,
      maxAge: -60,
    });
    expect(await readSsoSession(request({ [SESSION_COOKIE]: expired }))).toBeNull();
  });
});

describe("sessionCookieNames", () => {
  it("prefers the prefixed name on https and the plain one on http", () => {
    expect(sessionCookieNames("https:")[0]).toBe(SECURE_SESSION_COOKIE);
    expect(sessionCookieNames("http:")[0]).toBe(SESSION_COOKIE);
    // Both are always tried: a request can reach the edge through a proxy that
    // disagrees with the cookie the browser actually holds.
    expect(sessionCookieNames("https:")).toHaveLength(2);
    expect(sessionCookieNames("http:")).toHaveLength(2);
  });
});

describe("readCookieValue", () => {
  it("prefers the whole cookie, falls back to chunks, and returns null for neither", () => {
    expect(readCookieValue(cookies({ x: "whole" }), "x")).toBe("whole");
    expect(readCookieValue(cookies({ "x.0": "a", "x.1": "b" }), "x")).toBe("ab");
    expect(readCookieValue(cookies({}), "x")).toBeNull();
    // A gap ends the run — chunk 2 without chunk 1 is a broken cookie, not "ac".
    expect(readCookieValue(cookies({ "x.0": "a", "x.2": "c" }), "x")).toBe("a");
  });
});

describe("hasSsoAccess — the ONE authorization rule", () => {
  it("is exactly `roles includes access`", () => {
    expect(REQUIRED_ROLE).toBe("access");
    expect(hasSsoAccess({ roles: ["access"] })).toBe(true);
    expect(hasSsoAccess({ roles: ["marketing", "access"] })).toBe(true);
    expect(hasSsoAccess({ roles: ["marketing"] })).toBe(false);
    expect(hasSsoAccess({ roles: [] })).toBe(false);
    expect(hasSsoAccess({})).toBe(false);
    expect(hasSsoAccess(null)).toBe(false);
    expect(hasSsoAccess(undefined)).toBe(false);
  });

  it("does not accept the un-stripped Entra form", () => {
    // The gateway filters roles to this client and strips the prefix before we
    // ever see them. If that ever changes, this fails loudly instead of the
    // gate quietly refusing everyone.
    expect(hasSsoAccess({ roles: ["fasttrax-admin.access"] })).toBe(false);
  });
});
