import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "League Standings | FastTrax Entertainment",
  description:
    "Racing league standings, driver rankings, and session results at FastTrax Fort Myers. Track points, lap times, and race positions across the league season.",
  keywords: [
    "go kart league Fort Myers",
    "FastTrax league standings",
    "kart racing league",
    "indoor kart racing league",
    "FastTrax racing points",
    "go kart championship",
  ],
  openGraph: {
    title: "League Standings | FastTrax Entertainment",
    description:
      "Racing league standings, driver rankings, and session results at FastTrax Fort Myers.",
    type: "website",
    url: "https://fasttraxent.com/leagues",
  },
  alternates: {
    canonical: "https://fasttraxent.com/leagues",
  },
};

export default function LeaguesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
