import Hero from "@/components/home/Hero";
import Attractions from "@/components/home/Attractions";
import GalleryStrip from "@/components/home/GalleryStrip";
import RacerJourney from "@/components/home/RacerJourney";
import GroupEvents from "@/components/home/GroupEvents";

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
