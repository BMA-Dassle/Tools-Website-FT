import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@/": `${path.resolve(__dirname, ".")}/`,
      "~/": `${path.resolve(__dirname, "src")}/`,
      "@ft/db": path.resolve(__dirname, "../../packages/db/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**"],
    passWithNoTests: true,
  },
});
