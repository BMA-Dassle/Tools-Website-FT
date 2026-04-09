"use client";

import { useState, useEffect } from "react";
import HeadPinzNav from "@/components/headpinz/Nav";

/**
 * Brand-aware nav for shared /book/* routes.
 * On headpinz.com → renders HeadPinzNav
 * On fasttraxent.com → renders nothing (root layout handles FastTrax Nav)
 */
export default function BrandNav() {
  const [isHP, setIsHP] = useState(false);

  useEffect(() => {
    setIsHP(window.location.hostname.includes("headpinz"));
  }, []);

  if (!isHP) return null;
  return <HeadPinzNav />;
}
