import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Have-A-Ball Bowling League | HeadPinz Fort Myers — 12 Weeks + Free Ball",
  description:
    "Join the Have-A-Ball league at HeadPinz Fort Myers. Starts May 26 at 6:30 PM. 12-week season, $20/week, doubles or trios, and every bowler takes home a new ball at the end.",
  keywords: [
    "Have-A-Ball league",
    "bowling league Fort Myers",
    "HeadPinz league",
    "doubles bowling league",
    "trios bowling league",
    "beginner bowling league Fort Myers",
    "free bowling ball league",
  ],
  openGraph: {
    title: "Have-A-Ball League at HeadPinz Fort Myers",
    description:
      "12-week bowling league with a new ball for every bowler. $20/week billed weekly. Starts May 26 at 6:30 PM.",
    type: "website",
    url: "https://headpinz.com/fort-myers/have-a-ball",
  },
  alternates: { canonical: "https://headpinz.com/fort-myers/have-a-ball" },
};

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "When does the Have-A-Ball league start?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "The Have-A-Ball league at HeadPinz Fort Myers starts Monday, May 26, 2026 at 6:30 PM. The season runs 12 consecutive weeks.",
      },
    },
    {
      "@type": "Question",
      name: "How much does the Have-A-Ball league cost?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "$20 per person per week for 12 weeks. That's $14.50 lineage and $5.50 into the prize fund. Your card is charged $20 automatically each week. Total: $240 per bowler over the full season.",
      },
    },
    {
      "@type": "Question",
      name: "Do I get a bowling ball?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes — every bowler takes home a new bowling ball at the end of the season. Choose from the Brunswick T-Zone or Columbia White Dot, each available in four colors. Ball selection happens after the league starts.",
      },
    },
    {
      "@type": "Question",
      name: "Can I sign up with a team?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. Everyone registers individually, but you can enter a team name or who you're bowling with so we can group you. Format is doubles or trios — we prefer trios.",
      },
    },
    {
      "@type": "Question",
      name: "Do I need to be an experienced bowler?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Not at all. Have-A-Ball is designed for bowlers of every skill level, including first-timers. Bring your friends and have a ball.",
      },
    },
  ],
};

export default function HaveABallLayout({ children }: { children: React.ReactNode }) {
  // Nav + Footer come from parent /hp/fort-myers/layout.tsx
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <div>{children}</div>
    </>
  );
}
