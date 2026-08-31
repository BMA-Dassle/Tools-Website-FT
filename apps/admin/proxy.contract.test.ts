import { describe, expect, it } from "vitest";

/**
 * The one assertion proxy.test.ts cannot make.
 *
 * That suite mocks `./auth` down to an identity function so it can drive the
 * routing with hand-built sessions — which also means it can say nothing about
 * the SHAPE of what the real `auth()` returns. It said nothing while the shell
 * answered every single request, sign-in route included, with
 *
 *   The Proxy file "/proxy" must export a function named `proxy` or a default
 *   function.
 *
 * So: no mocks in this file. It reproduces Next's own loader check
 * (`typeof (mod.proxy ?? mod.default) !== "function"` in
 * next/dist/build/templates/middleware.js) against the module Next loads.
 * Importing it is safe with no SSO env set: `NextAuth(fn)` never invokes `fn`
 * at module load, and the ADMIN_* reads all live inside the handler.
 */
describe("the proxy module Next actually loads", () => {
  it("has a callable default export", async () => {
    const mod = await import("./proxy");

    const handlerUserland = mod.default;
    expect(typeof handlerUserland, "Next refuses to load the proxy unless this is a function").toBe(
      "function",
    );
  });

  it("does not export a Promise where Next expects a handler", async () => {
    const mod = await import("./proxy");

    // A Promise is a truthy object with a `.then` — precisely the shape that
    // slipped through before.
    expect(mod.default).not.toBeInstanceOf(Promise);
  });

  it("exports the routing handler the rest of the suite drives", async () => {
    const mod = await import("./proxy");

    expect(typeof mod.handleAdminRouting).toBe("function");
  });
});
