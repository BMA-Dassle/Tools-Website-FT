import BrandNav from "@/components/BrandNav";
import { QueryProvider } from "~/context/QueryProvider";

/**
 * v2 promo landing layout — wraps `/book/v2` with the React Query
 * provider + BrandNav + top spacing for the fixed Nav, mirroring the
 * per-activity `/book/[attraction]/v2` layout.
 */
export default function BookV2LandingLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <BrandNav />
      <div className="min-h-screen pt-32 sm:pt-36">{children}</div>
    </QueryProvider>
  );
}
