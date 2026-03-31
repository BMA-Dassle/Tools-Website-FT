import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Racing & Qualifications – FastTrax",
  description:
    "Experience Florida's premier multi-level indoor karting track. Adult, Junior & Mini karts with 3 speed tiers. Book your heat at FastTrax Fort Myers.",
  openGraph: {
    title: "Racing & Qualifications – FastTrax",
    description:
      "Experience Florida's premier multi-level indoor karting track. Adult, Junior & Mini karts with 3 speed tiers. Book your heat at FastTrax Fort Myers.",
  },
};

export default function RacingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
