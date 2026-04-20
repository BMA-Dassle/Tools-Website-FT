import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/seo/JsonLd";

/**
 * Things to Do in Fort Myers — HeadPinz-side hub page. FastTrax has its
 * own /things-to-do-fort-myers with a karting focus; this is the bowling/
 * entertainment-center angle served at headpinz.com/things-to-do-fort-myers.
 */

export const metadata: Metadata = {
  title: "Things to Do in Fort Myers | Bowling & Entertainment Guide",
  description:
    "Things to do in Fort Myers — bowling, laser tag, gel blasters, arcade, and more. HeadPinz Fort Myers is 24 lanes of indoor entertainment on Global Parkway.",
  alternates: { canonical: "https://headpinz.com/things-to-do-fort-myers" },
  keywords: [
    "things to do Fort Myers",
    "things to do in Fort Myers today",
    "fun things to do Fort Myers",
    "Fort Myers entertainment",
    "indoor activities Fort Myers",
    "bowling Fort Myers",
    "laser tag Fort Myers",
    "family fun Fort Myers",
    "rainy day Fort Myers",
  ],
  openGraph: {
    title: "Things to Do in Fort Myers | HeadPinz Guide",
    description:
      "Indoor entertainment guide for Fort Myers — bowling, laser tag, gel blasters, arcade, and more.",
    url: "https://headpinz.com/things-to-do-fort-myers",
    siteName: "HeadPinz",
    type: "article",
  },
};

const activities = [
  { title: "Bowling", body: "24 bowling lanes with VIP sections and HyperBowling interactive projection-mapped lanes. For casual groups and leagues.", href: "/book/bowling?location=9172" },
  { title: "NEXUS laser tag", body: "Multi-level laser tag arena. Group outings, birthdays, corporate team building.", href: "/fort-myers/attractions" },
  { title: "Gel blaster arena", body: "Low-impact tactical play, eye protection provided. Alternative to paintball and laser tag.", href: "/book/gel-blaster" },
  { title: "Arcade games", body: "40+ modern arcade games with ticket redemption. All ages.", href: "/fort-myers/attractions" },
  { title: "HyperBowling & NeoVerse", body: "Projection-mapped interactive bowling lanes turn every frame into a game.", href: "/fort-myers/attractions" },
  { title: "Go-kart racing (at FastTrax)", body: "FastTrax is the sister center in the same complex — indoor electric kart racing on multi-level tracks.", href: "https://fasttraxent.com/racing" },
  { title: "Nemo's Sports Bistro", body: "Full-service restaurant with craft cocktails, bar menu, trackside patio.", href: "/menu" },
];

const byOccasion = [
  { heading: "Rainy day?", body: "HeadPinz and FastTrax share Global Parkway complex — both fully indoor. Rain doesn't stop play.", href: "/fort-myers/attractions" },
  { heading: "Kids birthday party?", body: "Bronze, Silver, and VIP packages include lanes, arcade cards, laser tag, and food for 10-60 guests.", href: "/fort-myers/birthdays" },
  { heading: "Corporate team building?", body: "Group events bundle lanes, private rooms, buffet catering, and laser tag or gel blasters.", href: "/fort-myers/group-events" },
  { heading: "Date night?", body: "Bowl a round, hit the arcade, grab cocktails and dinner at Nemo's. Full evening in one stop.", href: "/book/bowling?location=9172" },
  { heading: "Family with young kids?", body: "Indoor, climate-controlled, all ages. HyperBowling keeps small kids engaged even without strong bowling skills.", href: "/fort-myers/attractions" },
  { heading: "Leagues?", body: "Adult and youth bowling leagues run year-round.", href: "/fort-myers" },
];

const otherVenues = [
  { name: "FastTrax (same complex)", desc: "Sister center with indoor electric kart racing, duckpin bowling, and shuffleboard. Walk between buildings.", href: "https://fasttraxent.com" },
  { name: "810 Bowling alternative", desc: "Compare our bowling + attractions bundle to traditional bowling alleys.", href: "/alternatives/810-bowling" },
  { name: "Bowlero alternative", desc: "Locally owned with premium lanes and more attractions.", href: "/alternatives/bowlero" },
  { name: "Gator Lanes alternative", desc: "Modern interactive bowling vs. traditional alleys.", href: "/alternatives/gator-lanes" },
  { name: "Hi-5 alternative", desc: "Family entertainment center comparison.", href: "/alternatives/high-five" },
  { name: "See all alternatives", desc: "Side-by-side comparisons with 4 SWFL entertainment venues.", href: "/alternatives" },
];

export default function ThingsToDoFortMyersHpPage() {
  return (
    <div className="min-h-screen bg-[#0a1628] text-white">
      <BreadcrumbJsonLd
        items={[
          { name: "HeadPinz", url: "https://headpinz.com" },
          { name: "Things to Do in Fort Myers", url: "https://headpinz.com/things-to-do-fort-myers" },
        ]}
      />

      {/* Hero */}
      <section style={{ padding: "clamp(80px, 14vw, 160px) clamp(16px, 4vw, 32px) 40px" }}>
        <div className="max-w-4xl mx-auto text-center">
          <div className="uppercase font-bold mb-4" style={{ color: "#fd5b56", fontSize: "12px", letterSpacing: "3px" }}>
            Fort Myers Entertainment Guide
          </div>
          <h1
            className="font-heading font-black uppercase italic text-white"
            style={{ fontSize: "clamp(32px, 7vw, 68px)", lineHeight: 1.05, letterSpacing: "-0.8px", marginBottom: "16px" }}
          >
            Things to do in Fort Myers
          </h1>
          <p
            className="font-body text-white/80 mx-auto"
            style={{ fontSize: "clamp(16px, 2.2vw, 22px)", lineHeight: 1.5, maxWidth: "52ch" }}
          >
            Fort Myers has great entertainment for any weather. Here&apos;s a guide to indoor, rain-or-shine
            attractions — starting with HeadPinz and FastTrax on Global Parkway, and including
            comparisons with other SWFL venues so you can pick what fits your group best.
          </p>
        </div>
      </section>

      {/* Activities grid */}
      <section style={{ padding: "40px clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-5xl mx-auto">
          <h2
            className="font-heading font-black uppercase italic text-white text-center"
            style={{ fontSize: "clamp(24px, 4.5vw, 40px)", lineHeight: 1.05, letterSpacing: "-0.4px", marginBottom: "32px" }}
          >
            Indoor attractions on Global Parkway
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {activities.map((a) => (
              <Link
                key={a.title}
                href={a.href}
                className="rounded-2xl p-6 transition-transform hover:scale-[1.02]"
                style={{ backgroundColor: "#0f1d36", border: "1px solid rgba(253,91,86,0.25)" }}
              >
                <h3 className="font-heading font-black uppercase text-white mb-2" style={{ fontSize: "18px", letterSpacing: "-0.2px" }}>
                  {a.title}
                </h3>
                <p className="font-body text-white/75" style={{ fontSize: "14px", lineHeight: 1.6 }}>
                  {a.body}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* By occasion */}
      <section style={{ padding: "60px clamp(16px, 4vw, 32px)", backgroundColor: "rgba(18,48,117,0.15)" }}>
        <div className="max-w-5xl mx-auto">
          <h2
            className="font-heading font-black uppercase italic text-white text-center"
            style={{ fontSize: "clamp(24px, 4.5vw, 40px)", lineHeight: 1.05, letterSpacing: "-0.4px", marginBottom: "32px" }}
          >
            Fort Myers things to do by occasion
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {byOccasion.map((o) => (
              <Link
                key={o.heading}
                href={o.href}
                className="rounded-2xl p-6 transition-transform hover:scale-[1.01]"
                style={{ backgroundColor: "#0f1d36", border: "1px solid rgba(255,255,255,0.08)" }}
              >
                <div className="uppercase font-bold mb-2" style={{ color: "#fd5b56", fontSize: "11px", letterSpacing: "2px" }}>
                  {o.heading}
                </div>
                <p className="font-body text-white/80" style={{ fontSize: "15px", lineHeight: 1.55 }}>
                  {o.body}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Other venues */}
      <section style={{ padding: "60px clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-5xl mx-auto">
          <h2
            className="font-heading font-black uppercase italic text-white text-center"
            style={{ fontSize: "clamp(24px, 4.5vw, 40px)", lineHeight: 1.05, letterSpacing: "-0.4px", marginBottom: "12px" }}
          >
            Comparing Fort Myers entertainment venues
          </h2>
          <p className="font-body text-white/60 text-center mx-auto mb-8" style={{ fontSize: "14px", maxWidth: "50ch" }}>
            Different venues do different things well. Here&apos;s how HeadPinz stacks up.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {otherVenues.map((v) => (
              <Link
                key={v.name}
                href={v.href}
                className="rounded-2xl p-6 transition-transform hover:scale-[1.02]"
                style={{ backgroundColor: "#0f1d36", border: "1px solid rgba(255,255,255,0.08)" }}
              >
                <h3 className="font-heading font-black uppercase text-white mb-2" style={{ fontSize: "16px", letterSpacing: "-0.2px" }}>
                  {v.name}
                </h3>
                <p className="font-body text-white/65" style={{ fontSize: "13px", lineHeight: 1.5 }}>
                  {v.desc}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }} className="text-center">
        <div className="max-w-2xl mx-auto">
          <h2
            className="font-heading font-black uppercase italic text-white"
            style={{ fontSize: "clamp(28px, 5vw, 44px)", lineHeight: 1.05, letterSpacing: "-0.4px", marginBottom: "20px" }}
          >
            Ready to have some fun?
          </h2>
          <p className="font-body text-white/70 mx-auto" style={{ fontSize: "16px", lineHeight: 1.6, marginBottom: "32px", maxWidth: "42ch" }}>
            Book a lane, laser tag, or group event at HeadPinz Fort Myers on Global Parkway.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href="/book/bowling?location=9172" className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105" style={{ backgroundColor: "#fd5b56", color: "#ffffff" }}>
              Book a lane
            </Link>
            <Link href="/fort-myers/group-events" className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105 text-white" style={{ border: "1px solid rgba(255,255,255,0.25)" }}>
              Group event packages
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
