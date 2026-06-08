"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { peekBookingSession } from "~/features/booking/hooks";

interface SessionSnapshot {
  itemCount: number;
  returnHref: string;
}

// peekBookingSession unwraps the versioned storage envelope, so this reads the
// real `items`/`appliedPromo` regardless of how persistence is wrapped (reading
// the raw shape here is what hid the floating cart when the envelope landed).
function readSnapshot(): SessionSnapshot | null {
  const session = peekBookingSession();
  if (!session || session.items.length === 0) return null;

  const first = session.items[0];
  let slug: string;
  if (first.kind === "attraction" && first.slug) slug = first.slug;
  else if (first.kind === "race") slug = "race";
  else if (first.kind === "bowling") slug = "bowling";
  else if (first.kind === "kbf") slug = "kbf";
  else slug = "race";

  const code = session.appliedPromo?.code;
  const href = code ? `/book/${slug}/v2?code=${encodeURIComponent(code)}` : `/book/${slug}/v2`;

  return { itemCount: session.items.length, returnHref: href };
}

export function MiniCartV2() {
  const pathname = usePathname();
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);

  useEffect(() => {
    function load() {
      setSnapshot(readSnapshot());
    }
    load();
    const interval = setInterval(load, 800);
    window.addEventListener("storage", load);
    return () => {
      clearInterval(interval);
      window.removeEventListener("storage", load);
    };
  }, []);

  // Show on the v2 landing page; hide inside v2 wizard pages and non-booking pages
  const isV2Landing = pathname === "/book/v2";
  if (!isV2Landing) return null;
  if (!snapshot) return null;

  return (
    <div className="fixed bottom-20 right-4 z-40 md:bottom-8 md:right-24">
      <Link
        href={snapshot.returnHref}
        className="relative flex h-14 w-14 items-center justify-center rounded-full bg-[#00E2E5] text-[#000418] shadow-lg shadow-[#00E2E5]/30 transition-colors hover:bg-white"
      >
        <svg
          className="h-6 w-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z"
          />
        </svg>
        <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
          {snapshot.itemCount}
        </span>
      </Link>
    </div>
  );
}
