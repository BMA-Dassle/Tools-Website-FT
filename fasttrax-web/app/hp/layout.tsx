import type { Metadata } from "next";
import { Dela_Gothic_One, Varela_Round, Outfit } from "next/font/google";
import HeadPinzNav from "@/components/headpinz/Nav";
import HeadPinzFooter from "@/components/headpinz/Footer";

const delaGothicOne = Dela_Gothic_One({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-hp-display",
  display: "swap",
});

const varelaRound = Varela_Round({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-hp-body",
  display: "swap",
});

const outfit = Outfit({
  weight: ["700", "800", "900"],
  subsets: ["latin"],
  variable: "--font-hp-hero",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://headpinz.com"),
  title: {
    default: "HeadPinz - Bowling, Laser Tag, Arcade & More | Fort Myers & Naples",
    template: "%s | HeadPinz",
  },
  description:
    "Premier bowling, laser tag, gel blaster arena, arcade games & dining at HeadPinz. Two locations in Fort Myers and Naples, FL. Where Fun Comes Together.",
  openGraph: {
    title: "HeadPinz - Where Fun Comes Together",
    description:
      "Premier bowling, laser tag, gel blasters, arcade & dining. Fort Myers and Naples locations.",
    type: "website",
    siteName: "HeadPinz",
    url: "https://headpinz.com",
    locale: "en_US",
  },
};

export default function HeadPinzLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={`${delaGothicOne.variable} ${varelaRound.variable} ${outfit.variable}`}>
      <HeadPinzNav />
      <div className="pt-16 lg:pt-20">{children}</div>
      <HeadPinzFooter />
    </div>
  );
}
