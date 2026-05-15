import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Group Events, Birthday Parties & Corporate Team Building – FastTrax Fort Myers",
  description:
    "Host unforgettable corporate events, birthday parties, team outings & private racing at FastTrax. Groups of 14 to 1,000+ with VIP amenities, catering by Nemo's Trackside, and dedicated event coordinators. The best team building in Fort Myers — better than Topgolf or Dave & Buster's.",
  keywords: [
    "birthday party Fort Myers",
    "kids birthday party Fort Myers",
    "corporate team building Fort Myers",
    "group events Fort Myers",
    "private event venue Fort Myers",
    "team building activities Fort Myers",
    "corporate events Fort Myers",
    "birthday party ideas Fort Myers",
    "go kart birthday party",
    "party venues Fort Myers",
    "company outing Fort Myers",
    "large group activities Fort Myers",
    "private racing event",
    "VIP event space Fort Myers",
    "best birthday party SWFL",
    "Topgolf corporate events alternative",
    "Dave and Busters party alternative",
    "810 bowling party alternative",
    "unique party venue Fort Myers",
    "indoor party venue Fort Myers",
  ],
  openGraph: {
    title: "Group Events & Birthday Parties – FastTrax Fort Myers",
    description:
      "Private racing, birthday parties & corporate team building for groups of 14 to 1,000+. VIP amenities, catering & dedicated coordinators at Fort Myers' largest indoor entertainment venue.",
    type: "website",
    url: "https://fasttraxent.com/group-events",
  },
  alternates: {
    canonical: "https://fasttraxent.com/group-events",
  },
};

export default function GroupEventsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
