import BrandNav from "@/components/BrandNav";
import { QueryProvider } from "~/context/QueryProvider";

export default function RacePackV2Layout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <BrandNav />
      <div className="min-h-screen pt-32 sm:pt-36">{children}</div>
    </QueryProvider>
  );
}
