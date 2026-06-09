import BrandNav from "@/components/BrandNav";
import { QueryProvider } from "~/context/QueryProvider";

/**
 * v2 booking layout — wraps per-activity /v2 pages with QueryProvider.
 * The FastTrax Nav comes from the root layout, but that's gated to !isHeadPinz
 * (showChrome), so HeadPinz visitors need BrandNav here to get the HeadPinz nav.
 * BrandNav renders nothing on FastTrax, so there's no double nav.
 */
export default function BookActivityV2Layout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <BrandNav />
      <div className="min-h-screen pt-32 sm:pt-36">{children}</div>
    </QueryProvider>
  );
}
