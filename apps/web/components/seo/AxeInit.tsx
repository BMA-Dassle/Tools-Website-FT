"use client";

import { useEffect } from "react";

/**
 * Dev-only accessibility runtime auditor.
 *
 * Mounts axe-core against React in development builds and logs WCAG
 * violations to the browser console as you navigate the site. Catches
 * issues that static lint can't — color contrast, actual DOM structure,
 * runtime-generated content.
 *
 * Zero production impact:
 *   - `process.env.NODE_ENV === 'development'` gate skips the import + init
 *     entirely when bundled for prod
 *   - Next.js dead-code eliminates the whole branch at build time
 *   - `@axe-core/react` is a devDependency, not in the prod bundle
 *
 * Output format in browser console:
 *   [Axe] <violation>: <element> (<WCAG rule link>)
 *
 * See https://github.com/dequelabs/axe-core-npm/tree/develop/packages/react
 */
export default function AxeInit() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    if (typeof window === "undefined") return;

    // Dynamic import — only pulled into the bundle on dev.
    (async () => {
      try {
        const [{ default: axe }, React, ReactDOM] = await Promise.all([
          import("@axe-core/react"),
          import("react"),
          import("react-dom"),
        ]);
        // 1000 ms debounce between scans, plenty of quiet time between
        // SPA transitions.
        axe(React, ReactDOM, 1000);
      } catch (err) {
        // Don't break dev experience if axe fails to load for any reason.
        console.warn("[AxeInit] failed to initialize axe-core:", err);
      }
    })();
  }, []);

  return null;
}
