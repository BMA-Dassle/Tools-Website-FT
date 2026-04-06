import type { Metadata } from "next";
import HeadPinzNav from "@/components/headpinz/Nav";
import HeadPinzFooter from "@/components/headpinz/Footer";

export const metadata: Metadata = {
  title: "Birthday Parties at HeadPinz Fort Myers | Bowling, Laser Tag & Arcade",
  description:
    "Throw the best birthday party at HeadPinz Fort Myers! Bronze, Silver & VIP packages with bowling, laser tag, gel blasters, arcade gaming, food & a dedicated party ambassador.",
  keywords: [
    "birthday party Fort Myers",
    "kids birthday party Fort Myers",
    "bowling birthday party Fort Myers",
    "birthday party venue Fort Myers",
    "laser tag birthday Fort Myers",
    "sweet 16 party Fort Myers",
    "HeadPinz birthday",
  ],
  openGraph: {
    title: "Birthday Parties at HeadPinz Fort Myers",
    description:
      "Bronze, Silver & VIP birthday packages with bowling, laser tag, gel blasters, arcade gaming & dedicated party ambassador.",
    type: "website",
    url: "https://headpinz.com/fort-myers/birthdays",
  },
  alternates: {
    canonical: "https://headpinz.com/fort-myers/birthdays",
  },
};

export default function BirthdaysLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <HeadPinzNav />
      <div>{children}</div>
      <HeadPinzFooter />
    </>
  );
}
