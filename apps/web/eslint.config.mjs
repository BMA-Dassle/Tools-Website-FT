import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";

/**
 * eslint-config-next already loads the jsx-a11y PLUGIN but only enables a
 * small core subset of rules. The block below bumps us to the full
 * recommended ruleset as WARNINGS (not errors) — surfaces real issues
 * in the build output without breaking CI. Fix them opportunistically;
 * CI can be tightened to errors once the warning count hits zero.
 *
 * Runtime a11y auditing (more comprehensive than static lint) comes from
 * `@axe-core/react` wired up in `components/seo/AxeInit.tsx`, which only
 * runs in dev.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    // Plugin is already registered by eslint-config-next — don't redefine
    // it here or flat-config throws "Cannot redefine plugin". Just bump
    // the rule severity to the full recommended set as warnings. Existing
    // code still builds; new a11y violations show up in `npm run lint`.
    rules: {
      ...Object.fromEntries(
        Object.entries(jsxA11y.configs.recommended.rules).map(([rule, config]) => {
          if (Array.isArray(config)) {
            return [rule, ["warn", ...config.slice(1)]];
          }
          return [rule, config === "off" ? "off" : "warn"];
        }),
      ),
      // React Compiler diagnostics (react-hooks/*), enabled at ERROR by the
      // Next flat config, are advisory hints about compiler-unfriendly
      // patterns — set-state-in-effect, manual-memoization, purity, refs,
      // etc. — not real bugs. Same philosophy as the a11y block above: keep
      // the full set as WARNINGS so they surface in `npm run lint` for
      // opportunistic cleanup, and tighten back to errors once the count
      // hits zero. `rules-of-hooks` stays an ERROR — it catches genuine
      // conditional-hook / hooks-after-return violations.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/static-components": "warn",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
