import type { Metadata } from "next";
import HeadPinzMobileBookBar from "@/components/headpinz/MobileBookBar";

const OG_IMAGE =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp";

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
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "HeadPinz Entertainment - Bowling lanes with cosmic glow effects",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "HeadPinz - Where Fun Comes Together",
    description:
      "Premier bowling, laser tag, gel blasters, arcade & dining. Fort Myers & Naples.",
    images: [OG_IMAGE],
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
  verification: {},
};

export default function HeadPinzLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Minimal layout — just fonts. Nav/Footer rendered by individual pages or nested layouts.
  return (
    <div>
      {children}
      <HeadPinzMobileBookBar />
    </div>
  );
}
