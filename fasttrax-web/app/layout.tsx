import type { Metadata } from "next";
import { Anton, Poppins, Plus_Jakarta_Sans } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import MobileBookBar from "@/components/MobileBookBar";

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
  title: "FastTrax – Florida's Largest Indoor Racing Destination",
  description:
    "63,000 sq. ft. of high-powered electric karting, elite gaming, and trackside dining in Fort Myers, FL. Book your race now.",
  openGraph: {
    title: "FastTrax – Indoor Racing Fort Myers",
    description: "Florida's Largest Indoor Racing Destination",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${anton.variable} ${poppins.variable} ${jakarta.variable}`}>
      <body className="bg-[#000418] text-white font-[var(--font-poppins)] antialiased">
        <Nav />
        <main>{children}</main>
        <Footer />
        <MobileBookBar />
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
