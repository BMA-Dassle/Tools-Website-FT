import type { Metadata } from "next";
import HeadPinzNav from "@/components/headpinz/Nav";

export const metadata: Metadata = {
  title: "Book Bowling - Reserve Lanes Online | HeadPinz",
  description:
    "Reserve bowling lanes online at HeadPinz Fort Myers or Naples. Choose your date, lane type, and package. VIP lanes with NeoVerse and HyperBowling available.",
  keywords: [
    "book bowling Fort Myers",
    "reserve bowling lanes",
    "bowling reservation",
    "book bowling Naples",
    "VIP bowling reservation",
    "online bowling booking",
  ],
  openGraph: {
    title: "Book Bowling - HeadPinz",
    description:
      "Reserve bowling lanes online. Choose date, lane type, and package. VIP lanes with NeoVerse and HyperBowling.",
    type: "website",
    url: "https://headpinz.com/book/bowling",
  },
  alternates: {
    canonical: "https://headpinz.com/book/bowling",
  },
  robots: { index: false },
};

export default function BowlingBookLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <HeadPinzNav />
      <div>{children}</div>
    </>
  );
}
