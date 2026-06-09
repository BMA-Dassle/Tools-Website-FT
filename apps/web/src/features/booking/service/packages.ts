/**
 * v2 package service — re-exports from the shared `lib/packages.ts` registry.
 *
 * The package definitions, types, and pricing helpers live in
 * `apps/web/lib/packages.ts` (shared between v1 and v2). This file
 * provides a v2-feature-path import so components under
 * `~/features/booking` don't reach into `@/lib/packages` directly.
 */
export {
  type PackageDefinition,
  type PackageId,
  type PackageRaceComponent,
  type PackageTrackOption,
  type EligibilityContext,
  getPackage,
  getPackageIgnoreFlag,
  eligiblePackages,
  packagePerRacerPrice,
  packageBundleTotal,
  packageRetailTotal,
  packageSavings,
  packageHeatGapMinutes,
  primaryTrack,
  LICENSE_PRICE,
  POV_PRICE,
  POV_CHECKIN_PRICE,
  APPETIZER_RETAIL_VALUE,
} from "@/lib/packages";
