import BrandNav from "@/components/BrandNav";
import { QueryProvider } from "~/context/QueryProvider";

/**
 * v2 booking layout — wraps every per-activity /v2 page with:
 *   - QueryProvider so hooks can read server state (scoped tight so only
 *     /book/<attraction>/v2 pays the React Query cost).
 *   - BrandNav for HeadPinz-host visits (renders HeadPinzNav). FastTrax's
 *     global Nav is already in the root layout for FT hosts; BrandNav
 *     renders nothing in that case.
 *   - Top padding to clear the fixed Nav (Nav is `fixed top-0 z-50` and
 *     ~80px tall — mirror v1 race's `pt-[140px]` approach but slightly
 *     tighter since v2 doesn't ship a hero banner).
 */
export default function BookActivityV2Layout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <BrandNav />
      <div className="min-h-screen pt-32 sm:pt-36">{children}</div>
    </QueryProvider>
  );
}
