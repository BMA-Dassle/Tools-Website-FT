"use client";

/**
 * Hidden staff entry: 5 taps within 3s anywhere inside this zone → a staff
 * surface (owner 2026-07-19: "make admin 5 taps anywhere up there"). Invisible
 * + aria-hidden + tabIndex -1 so a guest never sees or focuses it; overlays a
 * NON-interactive top region only (never a real button). Default = a full-width
 * strip pinned to the top of the nearest positioned ancestor.
 *
 * `target` picks WHICH staff door the gesture opens. The two zones must never
 * overlap on screen, or one gesture would count taps for both: the attract
 * screen puts admin top-LEFT and staff top-RIGHT.
 */
import { useRef } from "react";
import { useRouter } from "next/navigation";

export function AdminTapZone({
  className,
  target = "/kiosk/admin",
}: {
  className?: string;
  target?: "/kiosk/admin" | "/kiosk/staff";
}) {
  const router = useRouter();
  const taps = useRef<number[]>([]);
  const hit = () => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < 3000), now];
    if (taps.current.length >= 5) {
      taps.current = [];
      router.push(target);
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
