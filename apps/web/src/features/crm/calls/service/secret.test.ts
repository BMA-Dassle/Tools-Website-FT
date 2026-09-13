import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  THREECX_SECRET_ENV,
  offeredSecret,
  threecxSecretConfigured,
  threecxSecretOk,
  threecxUnauthorized,
} from "./secret";

/**
 * The two public `/api/crm/3cx/*` routes must FAIL CLOSED.
 *
 * This is the whole reason the file exists: `VOX_MO_TOKEN` guards the Vox
 * inbound webhook and fails OPEN when unset (`app/api/sms-webhook/vox/inbound/
 * route.ts`), which silently publishes that endpoint. The first test below is
 * the one that must never be allowed to regress.
 */

function req(opts: { header?: string; query?: string } = {}) {
  const url = new URL(
    `https://headpinz.com/api/crm/3cx/journal${opts.query ? `?k=${opts.query}` : ""}`,
  );
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "x-crm-3cx-secret" ? (opts.header ?? null) : null,
    },
    nextUrl: { searchParams: url.searchParams },
    url: url.toString(),
  };
}

const saved = process.env[THREECX_SECRET_ENV];

beforeEach(() => {
  delete process.env[THREECX_SECRET_ENV];
});

afterEach(() => {
  if (saved === undefined) delete process.env[THREECX_SECRET_ENV];
  else process.env[THREECX_SECRET_ENV] = saved;
});

describe("threecxSecretOk", () => {
  it("REFUSES everything when CRM_3CX_SECRET is unset — never fails open", () => {
    expect(threecxSecretConfigured()).toBe(false);
    expect(threecxSecretOk(req())).toBe(false);
    expect(threecxSecretOk(req({ header: "anything" }))).toBe(false);
    expect(threecxSecretOk(req({ query: "anything" }))).toBe(false);
    // The empty string is "unset", not "the secret is empty".
    process.env[THREECX_SECRET_ENV] = "   ";
    expect(threecxSecretConfigured()).toBe(false);
    expect(threecxSecretOk(req({ header: "   " }))).toBe(false);
  });

  it("accepts the header", () => {
    process.env[THREECX_SECRET_ENV] = "s3cret-value-32-chars-or-more-ok";
    expect(threecxSecretOk(req({ header: "s3cret-value-32-chars-or-more-ok" }))).toBe(true);
  });

  it("accepts ?k= too, because the PBX template may not send headers", () => {
    process.env[THREECX_SECRET_ENV] = "s3cret-value-32-chars-or-more-ok";
    expect(threecxSecretOk(req({ query: "s3cret-value-32-chars-or-more-ok" }))).toBe(true);
  });

  it("refuses a wrong secret, and one that is merely a prefix", () => {
    process.env[THREECX_SECRET_ENV] = "s3cret-value-32-chars-or-more-ok";
    expect(threecxSecretOk(req({ header: "wrong" }))).toBe(false);
    expect(threecxSecretOk(req({ header: "s3cret-value-32-chars-or-more-o" }))).toBe(false);
    expect(threecxSecretOk(req({ header: "s3cret-value-32-chars-or-more-okX" }))).toBe(false);
  });

  it("prefers the header when both are present", () => {
    process.env[THREECX_SECRET_ENV] = "right";
    expect(offeredSecret(req({ header: "right", query: "wrong" }))).toBe("right");
  });
});

describe("threecxUnauthorized", () => {
  it("is a 401 with a JSON envelope that says nothing about which half failed", async () => {
    const res = threecxUnauthorized();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });
});
