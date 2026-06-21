"use client";

import { useEffect, useState } from "react";
import type { BrandKey } from "~/features/account/types";

/**
 * Host brand (which door the customer walked through) — drives chrome accent +
 * Web Payments SDK default location. SSR-safe: starts "fasttrax" to match the
 * server render, flips after mount. Distinct from each subscription's own brand.
 */
export function useBrand(): BrandKey {
  const [brand, setBrand] = useState<BrandKey>("fasttrax");
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hostname.includes("headpinz")) {
      // Hydration-safe brand flip (same pattern as components/BrandNav.tsx).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBrand("headpinz");
    }
  }, []);
  return brand;
}
