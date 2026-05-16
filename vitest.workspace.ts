import { defineWorkspace } from "vitest/config";

// Lists every workspace package whose tests Vitest should run.
// Add new entries as packages gain test suites.
export default defineWorkspace([
  "apps/web",
  // "packages/*",   // enable once packages/* exist (PR4+)
  // "apps/*",       // enable once we have more than one app
]);
