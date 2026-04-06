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

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "How far in advance should I book a group event?",
      acceptedAnswer: { "@type": "Answer", text: "We recommend 2-3 weeks for smaller groups and 4-6 weeks for large events or facility buyouts." },
    },
    {
      "@type": "Question",
      name: "What is the minimum group size?",
      acceptedAnswer: { "@type": "Answer", text: "Group event packages are available for groups of 10 or more. Buffet catering requires a minimum of 25 people." },
    },
    {
      "@type": "Question",
      name: "Can we bring outside food?",
      acceptedAnswer: { "@type": "Answer", text: "All food and beverage is provided by Nemo's Sports Bistro. Custom catering packages are available for groups of any size." },
    },
    {
      "@type": "Question",
      name: "Do you accommodate dietary restrictions?",
      acceptedAnswer: { "@type": "Answer", text: "Yes. Our catering team can accommodate vegetarian, vegan, gluten-free, and common allergies." },
    },
    {
      "@type": "Question",
      name: "What about non-bowlers in our group?",
      acceptedAnswer: { "@type": "Answer", text: "We offer laser tag, gel blasters, arcade games, HyperBowling, and a full-service restaurant and bar." },
    },
  ],
};

export default function GroupEventsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <HeadPinzNav />
      <div>{children}</div>
      <HeadPinzFooter />
    </>
  );
}
