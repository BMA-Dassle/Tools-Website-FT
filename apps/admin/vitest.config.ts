import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**"],
    passWithNoTests: true,
    server: {
      // next-auth's ESM does a bare `import "next/server"`. Externalised, Node
      // resolves that as a FILE path and throws "Cannot find module .../next/server";
      // inlined, Vite resolves it through the `next` package's exports map the
      // way the bundler does at runtime. Required for auth.test.ts, which is the
      // only suite that imports the real ./auth rather than mocking it.
      deps: { inline: ["next-auth", "@auth/core"] },
    },
  },
});
