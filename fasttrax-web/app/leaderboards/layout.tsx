import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Live Race Leaderboards & Lap Records – FastTrax Fort Myers",
  description:
    "Real-time race timing, lap records, Hall of Fame standings & ProSkill rankings. Track your performance on Blue, Red & Mega tracks at FastTrax Fort Myers. See who holds the fastest laps.",
  keywords: [
    "go kart leaderboard Fort Myers",
    "FastTrax lap times",
    "indoor kart racing records",
    "fastest lap times Fort Myers",
    "go kart standings",
    "live race timing",
    "FastTrax leaderboards",
    "go kart hall of fame",
    "kart racing rankings",
    "ProSkill rankings FastTrax",
  ],
  openGraph: {
    title: "Live Leaderboards & Lap Records – FastTrax Fort Myers",
    description:
      "Real-time race timing, lap records & Hall of Fame standings. Track your performance at FastTrax Fort Myers.",
    type: "website",
    url: "https://fasttraxent.com/leaderboards",
  },
  alternates: {
    canonical: "https://fasttraxent.com/leaderboards",
  },
};

export default function LeaderboardsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
