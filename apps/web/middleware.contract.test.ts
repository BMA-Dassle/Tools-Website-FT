import { describe, expect, it } from "vitest";
import * as mod from "./middleware";

/**
 * THE EXPORT SHAPE. Not a style check — a bug that shipped twice in one day.
 *
 * Next's middleware/proxy loader does `typeof handler !== "function"` and hard
 * fails with "The Proxy file must export a function" for anything else. The way
 * to get "anything else" is to wrap the handler in Auth.js's `auth()`:
 * `auth.ts` passes a config FACTORY to `NextAuth` (so the config reads the
 * RUNTIME env rather than whatever was set at import), and for a function config
 * next-auth's `initAuth` returns an ASYNC wrapper — so `auth(handler)` is a
 * Promise of a handler, not a handler. Every request 500s, with an error
 * message that points at the file rather than at the wrapper.
 *
 * That is why `middleware.ts` decodes the session cookie itself
 * (`~/features/sso/session`) instead of importing the wrapper. This test is the
 * pin that stops the "helpful" refactor back to `export default auth(...)`.
 */
describe("middleware export contract", () => {
  it("exports `middleware` as a FUNCTION, not a Promise", () => {
    expect(typeof mod.middleware).toBe("function");
    expect(mod.middleware).not.toBeInstanceOf(Promise);
  });

  it("exports a default that is a function too, if it exports one at all", () => {
    // Next accepts either name. Whichever this file uses must still be callable.
    const dflt = (mod as { default?: unknown }).default;
    if (dflt !== undefined) expect(typeof dflt).toBe("function");
  });

  it("exports a `config` object with a matcher", () => {
    expect(mod.config).toBeTypeOf("object");
    expect(mod.config.matcher).toBeDefined();
  });

  it("does not pull Auth.js's request handler into the edge bundle", async () => {
    // The middleware answers every guest page view. Importing `~/auth` there
    // would (a) run Auth.js config validation on all of them, so one missing
    // env var 500s the storefront rather than 404ing the admin tools, and (b)
    // reintroduce the Promise-shaped export above.
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./middleware.ts", import.meta.url), "utf8"),
    );
    expect(src).not.toMatch(/from ["']@\/auth["']/);
    expect(src).not.toMatch(/from ["']~\/\.\.\/auth["']/);
    expect(src).not.toMatch(/\bexport default auth\(/);
  });
});
