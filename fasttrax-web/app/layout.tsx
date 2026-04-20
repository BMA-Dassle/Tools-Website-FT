import type { Metadata } from "next";
import { Exo_2, Barlow, Outfit, DM_Sans } from "next/font/google";
import Script from "next/script";
import { headers } from "next/headers";
import "./globals.css";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import MobileBookBar from "@/components/MobileBookBar";
import ChatWidgetManager from "@/components/ChatWidgetManager";
import { LocalBusinessJsonLd, HeadPinzOrganizationJsonLd } from "@/components/seo/JsonLd";
import AxeInit from "@/components/seo/AxeInit";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import MiniCart from "@/components/booking/MiniCart";

/* FastTrax fonts */
const exo2 = Exo_2({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--font-exo2",
  display: "swap",
});

const barlow = Barlow({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-barlow",
  display: "swap",
});

/* HeadPinz fonts */
const outfit = Outfit({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--font-outfit",
  display: "swap",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-dmsans",
  display: "swap",
});

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

/**
 * Host-aware default metadata. Both fasttraxent.com and headpinz.com are
 * served by this same Next.js app, and nested layouts (app/hp/layout.tsx)
 * override the brand-specific bits for most pages — but the root default
 * still applies to:
 *   - the 404 / not-found page
 *   - any route that isn't nested under /hp/*
 *   - metadata fallbacks when a nested layout doesn't override a field
 *
 * Without host detection here, a HeadPinz 404 would serve FastTrax OG
 * tags to Google / Facebook scrapers — bad SEO.
 *
 * Site-verification tokens come from env vars so they can rotate without
 * a code change:
 *   GOOGLE_SITE_VERIFICATION_FT / GOOGLE_SITE_VERIFICATION_HP
 *   BING_SITE_VERIFICATION_FT   / BING_SITE_VERIFICATION_HP
 */
export async function generateMetadata(): Promise<Metadata> {
  const hdrs = await headers();
  const host = (hdrs.get("host") || "").toLowerCase();
  const isHeadPinz = host.includes("headpinz.com");

  // Verification tokens — same field name for both brands, different values.
  const googleToken = isHeadPinz
    ? process.env.GOOGLE_SITE_VERIFICATION_HP
    : process.env.GOOGLE_SITE_VERIFICATION_FT;
  const bingToken = isHeadPinz
    ? process.env.BING_SITE_VERIFICATION_HP
    : process.env.BING_SITE_VERIFICATION_FT;

  const verification: Metadata["verification"] = {};
  if (googleToken) verification.google = googleToken;
  if (bingToken) verification.other = { "msvalidate.01": bingToken };

  const robots = {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large" as const,
      "max-snippet": -1,
    },
  };

  if (isHeadPinz) {
    return {
      metadataBase: new URL("https://headpinz.com"),
      title: {
        default: "HeadPinz — Bowling, Laser Tag, Gel Blasters, Arcade & Dining | Fort Myers & Naples",
        template: "%s | HeadPinz",
      },
      description:
        "Premier bowling, laser tag, gel blaster arena, arcade games & dining at HeadPinz. Two Southwest Florida locations — Fort Myers and Naples. Birthday parties, corporate events, leagues & more. Where Fun Comes Together.",
      keywords: [
        "HeadPinz",
        "bowling Fort Myers",
        "bowling Naples",
        "laser tag Fort Myers",
        "laser tag Naples",
        "gel blasters Fort Myers",
        "gel blasters Naples",
        "arcade Fort Myers",
        "arcade Naples",
        "birthday party Fort Myers",
        "birthday party Naples",
        "family entertainment Southwest Florida",
        "SWFL entertainment",
        "things to do Fort Myers",
        "things to do Naples",
        "corporate events Fort Myers",
        "group events Naples",
        "kids bowl free",
      ],
      openGraph: {
        title: "HeadPinz — Where Fun Comes Together",
        description:
          "Premier bowling, laser tag, gel blasters, arcade & dining. Two Southwest Florida locations: Fort Myers and Naples. Book your next event.",
        type: "website",
        siteName: "HeadPinz",
        url: "https://headpinz.com",
        locale: "en_US",
      },
      twitter: {
        card: "summary_large_image",
        title: "HeadPinz — Where Fun Comes Together",
        description:
          "Premier bowling, laser tag, gel blasters, arcade & dining. Fort Myers & Naples, FL.",
      },
      robots,
      alternates: { canonical: "https://headpinz.com" },
      verification,
    };
  }

  // Default — FastTrax
  return {
    metadataBase: new URL("https://fasttraxent.com"),
    title: {
      default: "FastTrax – Florida's Largest Indoor Go-Kart Racing & Entertainment | Fort Myers",
      template: "%s | FastTrax Entertainment",
    },
    description:
      "63,000 sq ft of high-performance electric go-kart racing, arcade gaming, duckpin bowling, shuffleboard & trackside dining at Nemo's Trackside. Fort Myers' #1 indoor entertainment destination. Better than Dave & Buster's, Topgolf & outdoor go-karts. Open late — rain or shine.",
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
    robots,
    alternates: { canonical: "https://fasttraxent.com" },
    verification,
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const hdrs = await headers();
  const isHeadPinz = hdrs.get("x-brand") === "headpinz";

  return (
    <html lang="en" className={`${exo2.variable} ${barlow.variable} ${outfit.variable} ${dmSans.variable}`}>
      <head>
        {isHeadPinz ? <HeadPinzOrganizationJsonLd /> : <LocalBusinessJsonLd />}
      </head>
      <body className={`${isHeadPinz ? "brand-headpinz bg-[#0a1628]" : "brand-fasttrax bg-[#000418]"} text-white font-body antialiased`}>
        {!isHeadPinz && <Nav />}
        <MiniCart />
        <main>{children}</main>
        {!isHeadPinz && <Footer />}
        {!isHeadPinz && <MobileBookBar />}
        {!isHeadPinz && <ChatWidgetManager />}
        <SpeedInsights />
        <Analytics />
        <AxeInit />
        {!isHeadPinz && (
          <>
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
          </>
        )}
      </body>
    </html>
  );
}
