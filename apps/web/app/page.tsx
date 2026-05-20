import type { Metadata } from "next";
import Hero from "@/components/home/Hero";
import Attractions from "@/components/home/Attractions";
import GalleryStrip from "@/components/home/GalleryStrip";
import RacerJourney from "@/components/home/RacerJourney";
import GroupEvents from "@/components/home/GroupEvents";
import { fasttraxOpenGraph, fasttraxTwitter } from "@/lib/seo";

export const metadata: Metadata = {
  title: "FastTrax – Florida's Largest Indoor Go-Kart Racing & Entertainment | Fort Myers",
  description:
    "63,000 sq ft of high-powered electric go-kart racing, arcade games, duckpin bowling & trackside dining at Nemo's. Fort Myers' #1 indoor entertainment destination — book your heat online.",
  openGraph: fasttraxOpenGraph({
    title: "FastTrax – Florida's Largest Indoor Racing Destination",
    description:
      "Multi-level electric go-kart racing, 50+ arcade games, duckpin bowling & trackside dining. 63,000 sq ft in Fort Myers, FL. Book your race now.",
    url: "https://fasttraxent.com",
  }),
  twitter: fasttraxTwitter({
    title: "FastTrax – Florida's Largest Indoor Racing Destination",
    description:
      "High-performance electric go-kart racing, arcade, bowling & trackside dining in Fort Myers, FL.",
  }),
  alternates: { canonical: "https://fasttraxent.com" },
};

export default function HomePage() {
  return (
    <>
      <Hero />
      <Attractions />
      <GalleryStrip />
      <RacerJourney />
      <GroupEvents />
    </>
  );
}
