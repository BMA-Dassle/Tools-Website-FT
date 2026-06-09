import BrandNav from "@/components/BrandNav";
import { QueryProvider } from "~/context/QueryProvider";

export default function KbfV2Layout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      {/* HeadPinz nav (null on FastTrax — root layout supplies that one). */}
      <BrandNav />
      <div className="min-h-screen pt-32 sm:pt-36">{children}</div>
    </QueryProvider>
  );
}
