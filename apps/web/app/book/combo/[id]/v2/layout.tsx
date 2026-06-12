import BrandNav from "@/components/BrandNav";
import { QueryProvider } from "~/context/QueryProvider";

/**
 * Combo-special v2 booking layout — same shell as /book/[attraction]/v2:
 * QueryProvider + BrandNav (renders nothing on FastTrax; supplies the
 * HeadPinz nav for HeadPinz visitors, whose root chrome is gated off).
 */
export default function BookComboV2Layout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <BrandNav />
      <div className="min-h-screen pt-32 sm:pt-36">{children}</div>
    </QueryProvider>
  );
}
