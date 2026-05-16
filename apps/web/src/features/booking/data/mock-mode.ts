/**
 * Vendor stub-mode toggle.
 *
 * Each booking adapter calls `isMockMode("bmi" | "conq" | ...)` to decide
 * whether to return fixture data or hit the real vendor. Driven by env vars:
 *
 *   LOCAL_BMI_MOCK=1
 *   LOCAL_CONQ_MOCK=1
 *   LOCAL_SQUARE_MOCK=1
 *   LOCAL_PANDORA_MOCK=1
 *   LOCAL_KBF_MOCK=1
 *
 * Default behavior:
 * - Production (NODE_ENV === "production"): ALWAYS real. The env var is
 *   ignored even if set, to prevent a stray env from neutering a deploy.
 * - Local / preview: real when the env var is unset OR "0" / "false";
 *   mocked when it's "1" / "true".
 *
 * Add a new vendor by extending the Vendor union below. The flag name is
 * derived as `LOCAL_<VENDOR_UPPER>_MOCK`.
 */
export type Vendor = "bmi" | "conq" | "square" | "pandora" | "kbf";

export function isMockMode(vendor: Vendor): boolean {
  // Hard guard: prod is never mocked, regardless of env state.
  if (process.env.NODE_ENV === "production") return false;
  const flag = process.env[`LOCAL_${vendor.toUpperCase()}_MOCK`];
  return flag === "1" || flag === "true";
}
