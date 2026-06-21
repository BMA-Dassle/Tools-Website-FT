import BrandNav from "@/components/BrandNav";
import { QueryProvider } from "~/context/QueryProvider";

/**
 * Layout for the centralized customer account area. Scopes the React Query
 * provider to this subtree and renders the HeadPinz nav (no-op on FastTrax,
 * where the root layout supplies the nav). Mirrors app/book/v2/layout.tsx.
 */
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <BrandNav />
      <div className="min-h-screen pt-32 sm:pt-36">{children}</div>
    </QueryProvider>
  );
}
