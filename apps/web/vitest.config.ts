import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@/": `${path.resolve(__dirname, ".")}/`,
      "~/": `${path.resolve(__dirname, "src")}/`,
      "@ft/db": path.resolve(__dirname, "../../packages/db/src/index.ts"),
      // `import "server-only"` is a BUILD-time guard: it turns "someone
      // imported a server module into a client component" from a puzzling
      // runtime failure into a clear build error. It has no runtime behaviour,
      // and Vitest cannot resolve the bare specifier — so point it at a no-op
      // here rather than dropping the guard from the source.
      "server-only": path.resolve(__dirname, "test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**"],
    passWithNoTests: true,
    server: {
      // next-auth's ESM does a bare `import "next/server"`. Externalised, Node
      // resolves that as a FILE path and throws "Cannot find module
      // .../next/server"; inlined, Vite resolves it through the `next`
      // package's exports map the way the bundler does at runtime. Required by
      // `auth.config.test.ts`, the only suite that imports the real `./auth`.
      // (Same fix, same reason, as apps/admin/vitest.config.ts.)
      deps: { inline: ["next-auth", "@auth/core"] },
    },
  },
});
