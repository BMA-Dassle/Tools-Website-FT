import type { Metadata } from "next";
import HeadPinzNav from "@/components/headpinz/Nav";
import HeadPinzFooter from "@/components/headpinz/Footer";

export const metadata: Metadata = {
  title: "Group Events & Corporate Team Building | HeadPinz Fort Myers",
  description:
    "Plan corporate team building, private parties, or group events at HeadPinz Fort Myers. Bowling, laser tag, gel blasters, arcade & catering for 10 to 500+ guests.",
  keywords: [
    "group events Fort Myers",
    "corporate team building Fort Myers",
    "corporate events Fort Myers",
    "team building activities Fort Myers",
    "private event venue Fort Myers",
    "company outing Fort Myers",
    "event space Fort Myers",
    "large group activities Fort Myers",
  ],
  openGraph: {
    title: "Group Events & Corporate Team Building | HeadPinz Fort Myers",
    description:
      "Bowling, laser tag, gel blasters, arcade & full catering for groups of 10 to 500+ at HeadPinz Fort Myers.",
    type: "website",
    url: "https://headpinz.com/fort-myers/group-events",
  },
  alternates: {
    canonical: "https://headpinz.com/fort-myers/group-events",
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
      name: "Is a deposit required?",
      acceptedAnswer: { "@type": "Answer", text: "Yes, a deposit is required to secure your date. Deposit amount and payment terms will be included in your custom quote." },
    },
    {
      "@type": "Question",
      name: "What about non-bowlers in our group?",
      acceptedAnswer: { "@type": "Answer", text: "We offer laser tag, gel blasters, arcade games, HyperBowling, and a full-service restaurant and bar." },
    },
    {
      "@type": "Question",
      name: "Do you have a corporate meeting room?",
      acceptedAnswer: { "@type": "Answer", text: "Yes! Our meeting room is available for $100/hour with A/V equipment included." },
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
