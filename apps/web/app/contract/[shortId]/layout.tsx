import { headers } from "next/headers";

export default async function ContractLayout({ children }: { children: React.ReactNode }) {
  const hdrs = await headers();
  const brand = hdrs.get("x-brand") === "headpinz" ? "headpinz" : "fasttrax";

  return (
    <div
      className={`min-h-screen ${brand === "headpinz" ? "brand-headpinz bg-[#0a1628]" : "brand-fasttrax bg-[#000418]"} text-white`}
    >
      {children}
    </div>
  );
}
