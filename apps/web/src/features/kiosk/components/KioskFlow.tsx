"use client";

/**
 * Kiosk booking flow orchestrator.
 *
 * STAGE 1 PLACEHOLDER — the category chooser, step registry, and wizard land
 * in the flow-core stage. This shell exists so /kiosk/flow routes and the
 * attract screen's deep links have a stable target from the first commit.
 */
import Link from "next/link";
import { useKioskConfig } from "../KioskConfigContext";
import { BrandedLoader } from "./BrandedLoader";

export function KioskFlow({ goto }: { goto: string | null }) {
  const { config } = useKioskConfig();
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-12 bg-[#000418] px-10 text-center">
      <BrandedLoader
        brand={config?.brand ?? "fasttrax"}
        label="Booking flow is on its way"
        sublabel={
          goto ? `Deep link requested: ${goto}` : "Category chooser lands in the next stage"
        }
      />
      <Link
        href="/kiosk"
        className="font-heading rounded-full border-2 border-white/15 px-10 py-4 text-[2.4vh] font-bold uppercase tracking-widest text-white/60"
      >
        Start over
      </Link>
    </div>
  );
}
