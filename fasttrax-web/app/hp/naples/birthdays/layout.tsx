import type { Metadata } from "next";
import HeadPinzNav from "@/components/headpinz/Nav";
import HeadPinzFooter from "@/components/headpinz/Footer";

export const metadata: Metadata = {
  title: "Birthday Parties at HeadPinz Naples - Bowling, Laser Tag, Gel Blasters & Arcade",
  description:
    "Host the ultimate birthday party at HeadPinz Naples! Bronze, Silver & VIP packages with bowling, gel blasters, arcade gaming, food & a dedicated party ambassador. Ages 17 & under.",
  keywords: [
    "HeadPinz Naples birthday",
    "birthday party Naples FL",
    "kids birthday Naples",
    "bowling birthday party Naples",
    "laser tag birthday Naples",
    "gel blaster birthday Naples",
    "arcade birthday party Naples",
    "family entertainment Naples",
  ],
  openGraph: {
    title: "Birthday Parties at HeadPinz Naples",
    description:
      "Bronze, Silver & VIP birthday packages with bowling, gel blasters, arcade gaming & dedicated party ambassador at HeadPinz Naples.",
    type: "website",
    url: "https://headpinz.com/naples/birthdays",
  },
  alternates: {
    canonical: "https://headpinz.com/naples/birthdays",
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
