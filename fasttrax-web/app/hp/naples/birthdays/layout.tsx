import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Birthday Parties at HeadPinz Naples - Bowling, Laser Tag, Gel Blasters & Arcade",
  description:
    "Host the ultimate birthday party at HeadPinz Naples! Bronze, Silver & VIP packages with bowling, gel blasters, arcade gaming, food & a dedicated party ambassador. Ages 17 & under.",
  keywords: [
    "HeadPinz Naples birthday",
    "birthday party Naples FL",
    "kids birthday Naples",
    "bowling birthday party Naples",
    "laser tag birthday Naples",
    "gel blaster birthday Naples",
    "arcade birthday party Naples",
    "family entertainment Naples",
  ],
  openGraph: {
    title: "Birthday Parties at HeadPinz Naples",
    description:
      "Bronze, Silver & VIP birthday packages with bowling, gel blasters, arcade gaming & dedicated party ambassador at HeadPinz Naples.",
    type: "website",
    url: "https://headpinz.com/naples/birthdays",
  },
  alternates: {
    canonical: "https://headpinz.com/naples/birthdays",
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
  // Nav + Footer provided by parent naples/layout.tsx
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
