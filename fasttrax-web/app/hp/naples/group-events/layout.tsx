import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Group Events & Private Parties at HeadPinz Naples - Bowling, Laser Tag & Catering",
  description:
    "Plan your corporate event, team building, or private party at HeadPinz Naples. Classic & VIP bowling, laser tag, gel blasters, arcade, buffet catering & full bar. 10 to 500+ guests.",
  keywords: [
    "HeadPinz Naples group events",
    "corporate events Naples FL",
    "team building Naples",
    "private party Naples",
    "bowling party Naples",
    "laser tag event Naples",
    "catering Naples entertainment",
    "venue rental Naples FL",
  ],
  openGraph: {
    title: "Group Events & Private Parties at HeadPinz Naples",
    description:
      "Classic & VIP bowling, laser tag, gel blasters, arcade, buffet catering & full bar for groups of 10 to 500+ at HeadPinz Naples.",
    type: "website",
    url: "https://headpinz.com/naples/group-events",
  },
  alternates: {
    canonical: "https://headpinz.com/naples/group-events",
  },
};

export default function GroupEventsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // FAQ JSON-LD is rendered by the page component (FAQJsonLd) to avoid
  // duplicate FAQPage schemas that trigger Google Search Console errors.
  // Nav + Footer provided by parent naples/layout.tsx.
  return <>{children}</>;
}
