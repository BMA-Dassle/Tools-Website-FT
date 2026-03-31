import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Group Events & Team Building – FastTrax",
  description:
    "Host unforgettable corporate events, birthday parties & team outings at FastTrax. Groups of 14 to 1,000+ with VIP amenities and catering.",
  openGraph: {
    title: "Group Events & Team Building – FastTrax",
    description:
      "Host unforgettable corporate events, birthday parties & team outings at FastTrax. Groups of 14 to 1,000+ with VIP amenities and catering.",
  },
};

export default function GroupEventsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
