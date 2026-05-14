"use client";

import { useState, useEffect } from "react";
import HeadPinzNav from "@/components/headpinz/Nav";

/**
 * Brand-aware nav for shared /book/* routes.
 * On headpinz.com → renders HeadPinzNav
 * On fasttraxent.com → renders nothing (root layout handles FastTrax Nav)
 *
 * Preview / localhost: checks the `dev-brand` cookie set by middleware
 * when the user navigates through /hp/* routes. This persists through
 * shared /book/* checkout routes so the nav stays consistent.
 */
export default function BrandNav() {
  // Start false so SSR + first client render match (avoids hydration mismatch),
  // then flip once we can read window.location on the client.
  const [isHP, setIsHP] = useState(false);

  useEffect(() => {
    // Production: hostname is headpinz.com
    // Preview/localhost: dev-brand cookie set by middleware on /hp/* routes
    const isHeadPinzDomain = window.location.hostname.includes("headpinz.com");
    const hasDevBrandCookie = document.cookie.split(";").some(c => c.trim().startsWith("dev-brand=headpinz"));
    if (isHeadPinzDomain || hasDevBrandCookie) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsHP(true);
    }
  }, []);

  if (!isHP) return null;
  return <HeadPinzNav />;
}
