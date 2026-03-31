import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Live Leaderboards & Standings – FastTrax",
  description:
    "Real-time race timing, lap records & Hall of Fame standings. Track your performance at FastTrax Fort Myers.",
  openGraph: {
    title: "Live Leaderboards & Standings – FastTrax",
    description:
      "Real-time race timing, lap records & Hall of Fame standings. Track your performance at FastTrax Fort Myers.",
  },
};

export default function LeaderboardsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
