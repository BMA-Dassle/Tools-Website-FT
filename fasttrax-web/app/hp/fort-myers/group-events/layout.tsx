import type { Metadata } from "next";

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

export default function GroupEventsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // FAQ JSON-LD is rendered by the page component (FAQJsonLd) to avoid
  // duplicate FAQPage schemas that trigger Google Search Console errors.
  // Nav + Footer provided by parent fort-myers/layout.tsx.
  return <>{children}</>;
}
