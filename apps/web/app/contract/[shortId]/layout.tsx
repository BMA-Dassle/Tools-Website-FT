import { headers } from "next/headers";
import Nav from "@/components/Nav";
import HeadPinzNav from "@/components/headpinz/Nav";

export default async function ContractLayout({ children }: { children: React.ReactNode }) {
  const hdrs = await headers();
  const brand = hdrs.get("x-brand") === "headpinz" ? "headpinz" : "fasttrax";

  return (
    <div
      className={`min-h-screen ${brand === "headpinz" ? "brand-headpinz bg-[#0a1628]" : "brand-fasttrax bg-[#000418]"} text-white`}
    >
      <style>{`
        .mobile-book-now, [data-mobile-cta], .fixed.bottom-0 { display: none !important; }
        @media (max-width: 768px) { nav .book-now-sticky, footer { display: none !important; } }
      `}</style>
      {brand === "headpinz" ? <HeadPinzNav /> : <Nav />}
      {children}
    </div>
  );
}
