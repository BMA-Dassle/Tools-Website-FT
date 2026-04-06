import type { Metadata } from "next";
import HeadPinzNav from "@/components/headpinz/Nav";
import HeadPinzFooter from "@/components/headpinz/Footer";

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
  return (
    <>
      <HeadPinzNav />
      <div>{children}</div>
      <HeadPinzFooter />
    </>
  );
}
