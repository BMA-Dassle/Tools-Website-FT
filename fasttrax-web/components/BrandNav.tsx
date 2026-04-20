"use client";

import { useState, useEffect } from "react";
import HeadPinzNav from "@/components/headpinz/Nav";

/**
 * Brand-aware nav for shared /book/* routes.
 * On headpinz.com → renders HeadPinzNav
 * On fasttraxent.com → renders nothing (root layout handles FastTrax Nav)
 */
export default function BrandNav() {
  // Start false so SSR + first client render match (avoids hydration mismatch),
  // then flip once we can read window.location on the client.
  const [isHP, setIsHP] = useState(false);

  useEffect(() => {
    if (window.location.hostname.includes("headpinz")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsHP(true);
    }
  }, []);

  if (!isHP) return null;
  return <HeadPinzNav />;
}
