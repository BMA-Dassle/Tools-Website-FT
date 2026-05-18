import BrandNav from "@/components/BrandNav";
import { QueryProvider } from "~/context/QueryProvider";

/**
 * KBF v2 layout — its own QueryProvider scope (mirrors the [attraction]/v2
 * layout). KBF lives outside the [attraction] dynamic segment because it has
 * a distinct SEO surface, legal/COPPA story, and brand pinning (HeadPinz only).
 *
 * Adds BrandNav + top spacing for the fixed Nav, matching the [attraction]
 * sibling layout — keeps wizard chrome consistent across all v2 booking
 * entry points.
 */
export default function KbfV2Layout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <BrandNav />
      <div className="min-h-screen pt-32 sm:pt-36">{children}</div>
    </QueryProvider>
  );
}
