import BrandNav from "@/components/BrandNav";
import { QueryProvider } from "~/context/QueryProvider";

/**
 * Layout for the public game-card reload flow. Scopes the React Query provider
 * to this subtree (mirrors the account layout). Brand chrome is host-aware.
 */
export default function ReloadLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <BrandNav />
      <div className="min-h-screen px-4 pt-32 pb-16 sm:pt-36">{children}</div>
    </QueryProvider>
  );
}
