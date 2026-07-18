"use client";

/**
 * Hidden staff entry: 5 taps within 3s anywhere inside this zone → /kiosk/admin
 * (owner 2026-07-19: "make admin 5 taps anywhere up there"). Invisible +
 * aria-hidden + tabIndex -1 so a guest never sees or focuses it; overlays a
 * NON-interactive top region only (never a real button). Default = a full-width
 * strip pinned to the top of the nearest positioned ancestor.
 */
import { useRef } from "react";
import { useRouter } from "next/navigation";

export function AdminTapZone({ className }: { className?: string }) {
  const router = useRouter();
  const taps = useRef<number[]>([]);
  const hit = () => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < 3000), now];
    if (taps.current.length >= 5) {
      taps.current = [];
      router.push("/kiosk/admin");
    }
  };
  return (
    <button
      type="button"
      aria-hidden="true"
      tabIndex={-1}
      onClick={hit}
      className={className ?? "absolute inset-x-0 top-0 z-20 h-[220px] w-full opacity-0"}
    />
  );
}
