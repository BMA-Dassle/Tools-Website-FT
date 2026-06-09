import BrandNav from "@/components/BrandNav";
import { QueryProvider } from "~/context/QueryProvider";

export default function BookV2LandingLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      {/* HeadPinz nav (renders nothing on FastTrax — the root layout supplies
          the FastTrax Nav, which is gated to !isHeadPinz). Without this, HeadPinz
          visitors get NO nav on /book/v2. */}
      <BrandNav />
      <div className="min-h-screen pt-32 sm:pt-36">{children}</div>
    </QueryProvider>
  );
}
