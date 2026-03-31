import type { Metadata } from "next";
import { Anton, Poppins, Plus_Jakarta_Sans } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import MobileBookBar from "@/components/MobileBookBar";
import DesktopChatButton from "@/components/DesktopChatButton";
import { LocalBusinessJsonLd } from "@/components/seo/JsonLd";

const anton = Anton({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-anton",
  display: "swap",
});

const poppins = Poppins({
  weight: ["300", "400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-poppins",
  display: "swap",
});

const jakarta = Plus_Jakarta_Sans({
  weight: ["600", "700"],
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://fasttraxent.com"),
  title: {
    default: "FastTrax – Florida's Largest Indoor Go-Kart Racing & Entertainment | Fort Myers",
    template: "%s | FastTrax Entertainment",
  },
  description:
    "63,000 sq ft of high-performance electric go-kart racing, arcade gaming, duckpin bowling, shuffleboard & trackside dining at Nemo's Brickyard Bistro. Fort Myers' #1 indoor entertainment destination. Better than Dave & Buster's, Topgolf & outdoor go-karts. Open late — rain or shine.",
  keywords: [
    "FastTrax Fort Myers",
    "indoor go kart racing Fort Myers",
    "things to do Fort Myers",
    "things to do in Fort Myers today",
    "fun things to do Fort Myers",
    "Fort Myers entertainment",
    "family fun Fort Myers",
    "indoor entertainment Fort Myers",
    "go karts near me",
    "arcade Fort Myers",
    "duckpin bowling Fort Myers",
    "date night Fort Myers",
    "rainy day activities Fort Myers",
    "Dave and Busters Fort Myers",
    "Topgolf alternative Fort Myers",
    "GameTime Fort Myers",
    "810 bowling alternative",
    "Gator Mikes alternative",
    "best arcade Fort Myers",
    "things to do SWFL",
    "Fort Myers attractions",
    "indoor activities Fort Myers",
    "birthday party Fort Myers",
    "corporate events Fort Myers",
    "nightlife Fort Myers",
    "what to do tonight Fort Myers",
    "Fort Myers fun for kids",
    "SWFL entertainment",
  ],
  openGraph: {
    title: "FastTrax – Indoor Go-Kart Racing & Entertainment | Fort Myers, FL",
    description:
      "Florida's largest indoor multi-level electric kart track + arcade, bowling, dining & more. 63,000 sq ft of entertainment in Fort Myers. Book now.",
    type: "website",
    siteName: "FastTrax Entertainment",
    url: "https://fasttraxent.com",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "FastTrax – Florida's Largest Indoor Racing Destination",
    description:
      "High-performance electric go-kart racing, arcade, bowling & trackside dining in Fort Myers. Book your heat now.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  alternates: {
    canonical: "https://fasttraxent.com",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${anton.variable} ${poppins.variable} ${jakarta.variable}`}>
      <head>
        <LocalBusinessJsonLd />
      </head>
      <body className="bg-[#000418] text-white font-[var(--font-poppins)] antialiased">
        <Nav />
        <main>{children}</main>
        <Footer />
        <MobileBookBar />
        <DesktopChatButton />
        {/* 3CX Live Chat Widget */}
        <div
          dangerouslySetInnerHTML={{
            __html: '<call-us-selector phonesystem-url="https://bma.3cx.us" party="LiveChat728061" enable-poweredby="false"></call-us-selector>',
          }}
        />
        <Script
          src="https://downloads-global.3cx.com/downloads/livechatandtalk/v1/callus.js"
          id="tcx-callus-js"
          strategy="lazyOnload"
        />
      </body>
    </html>
  );
}
