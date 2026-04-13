import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Birthday Parties at HeadPinz Fort Myers | Bowling, Laser Tag & Arcade",
  description:
    "Throw the best birthday party at HeadPinz Fort Myers! Bronze, Silver & VIP packages with bowling, laser tag, gel blasters, arcade gaming, food & a dedicated party ambassador.",
  keywords: [
    "birthday party Fort Myers",
    "kids birthday party Fort Myers",
    "bowling birthday party Fort Myers",
    "birthday party venue Fort Myers",
    "laser tag birthday Fort Myers",
    "sweet 16 party Fort Myers",
    "HeadPinz birthday",
  ],
  openGraph: {
    title: "Birthday Parties at HeadPinz Fort Myers",
    description:
      "Bronze, Silver & VIP birthday packages with bowling, laser tag, gel blasters, arcade gaming & dedicated party ambassador.",
    type: "website",
    url: "https://headpinz.com/fort-myers/birthdays",
  },
  alternates: {
    canonical: "https://headpinz.com/fort-myers/birthdays",
  },
};

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "What ages are birthday parties for?",
      acceptedAnswer: { "@type": "Answer", text: "Our birthday party packages are designed for guests ages 17 and under." },
    },
    {
      "@type": "Question",
      name: "How many guests per lane?",
      acceptedAnswer: { "@type": "Answer", text: "Each lane accommodates up to 6 guests. You can reserve 2, 4, or 6 lanes depending on your party size." },
    },
    {
      "@type": "Question",
      name: "Can adults attend?",
      acceptedAnswer: { "@type": "Answer", text: "Absolutely! Adults are welcome to attend as guests." },
    },
    {
      "@type": "Question",
      name: "What food is included?",
      acceptedAnswer: { "@type": "Answer", text: "Every package includes one food choice: pizza + soda, hot dog + fries + soda, or chicken tenders + fries + soda." },
    },
    {
      "@type": "Question",
      name: "How far in advance should I book?",
      acceptedAnswer: { "@type": "Answer", text: "We recommend booking at least 2 weeks in advance. Popular dates and weekends fill up quickly." },
    },
    {
      "@type": "Question",
      name: "Can I bring my own cake?",
      acceptedAnswer: { "@type": "Answer", text: "Yes! You're welcome to bring your own birthday cake or cupcakes. We'll provide the plates and utensils." },
    },
  ],
};

export default function BirthdaysLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Nav + Footer provided by parent fort-myers/layout.tsx
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
