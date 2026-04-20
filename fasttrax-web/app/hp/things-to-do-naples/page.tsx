import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/seo/JsonLd";

/**
 * Things to Do in Naples — HeadPinz-side hub page targeting the high-
 * volume "things to do in Naples" / "fun things to do Naples" local-
 * intent queries.
 *
 * Internal URL: /hp/things-to-do-naples (dev)
 * Public URL:   https://headpinz.com/things-to-do-naples
 *               (middleware rewrites / → /hp prefix)
 */

export const metadata: Metadata = {
  title: "Things to Do in Naples FL | Indoor Entertainment Guide",
  description:
    "Your guide to things to do in Naples, FL — bowling, laser tag, gel blasters, arcade, and more. Rain-or-shine indoor entertainment at HeadPinz Naples.",
  alternates: { canonical: "https://headpinz.com/things-to-do-naples" },
  keywords: [
    "things to do Naples FL",
    "things to do in Naples",
    "fun things to do Naples",
    "Naples entertainment",
    "indoor activities Naples",
    "rainy day Naples",
    "Naples attractions",
    "family fun Naples",
    "bowling Naples",
    "laser tag Naples",
  ],
  openGraph: {
    title: "Things to Do in Naples FL | HeadPinz Guide",
    description:
      "Indoor entertainment guide for Naples — bowling, laser tag, gel blasters, arcade, and more.",
    url: "https://headpinz.com/things-to-do-naples",
    siteName: "HeadPinz",
    type: "article",
  },
};

const activities = [
  { title: "Bowling", body: "32 bowling lanes, including VIP sections and HyperBowling interactive projection-mapped lanes. Good for any age.", href: "/book/bowling?location=3148" },
  { title: "NEXUS laser tag", body: "Multi-level laser tag arena. Kids and adult groups both fit.", href: "/naples/attractions" },
  { title: "Gel blaster arena", body: "Low-impact tactical play with eye protection provided. Alternative to paintball.", href: "/book/gel-blaster?location=naples" },
  { title: "Arcade games", body: "40+ modern arcade games with ticket redemption. All-ages friendly.", href: "/naples/attractions" },
  { title: "HyperBowling & NeoVerse", body: "Interactive projection-mapped lanes turn every frame into a mini-game. Great for kids and mixed-ability groups.", href: "/naples/attractions" },
  { title: "Nemo's Sports Bistro", body: "Full-service restaurant with craft cocktails, bar menu, and a seasonal menu.", href: "/menu" },
];

const byOccasion = [
  { heading: "Rainy day?", body: "HeadPinz Naples is fully indoor. Rain, thunderstorms, and humidity don't stop play.", href: "/naples/attractions" },
  { heading: "Kids birthday party?", body: "Bronze, Silver, and VIP packages include lanes, arcade cards, laser tag, and food. For 10-60 guests.", href: "/naples/birthdays" },
  { heading: "Corporate team building?", body: "Group events with lanes, private rooms, buffet catering, and optional laser tag.", href: "/naples/group-events" },
  { heading: "Date night?", body: "Bowl a round, hit the arcade, and grab cocktails and dinner at Nemo's. A full evening in one stop.", href: "/book/bowling?location=3148" },
  { heading: "Family with young kids?", body: "Indoor, climate-controlled, and all ages welcome. HyperBowling keeps kids engaged even if they're not strong bowlers.", href: "/naples/attractions" },
  { heading: "Guys or girls night out?", body: "VIP lanes, full bar, craft cocktails, arcade. The adult-friendly corner of HeadPinz.", href: "/book/bowling?location=3148" },
];

const otherVenues = [
  { name: "HeadPinz Fort Myers", desc: "Sister center with the same attractions + 24 lanes. If you're driving north.", href: "/fort-myers" },
  { name: "Hi-5 alternative", desc: "If you're comparing family entertainment centers in SWFL.", href: "/alternatives/high-five" },
  { name: "Gator Lanes alternative", desc: "Modern bowling with interactive tech vs. traditional alleys.", href: "/alternatives/gator-lanes" },
  { name: "810 Bowling alternative", desc: "Bowling + more under one roof.", href: "/alternatives/810-bowling" },
  { name: "Bowlero alternative", desc: "Locally owned with premium lanes and more attractions.", href: "/alternatives/bowlero" },
  { name: "See all alternatives", desc: "Side-by-side comparisons with 4 SWFL entertainment venues.", href: "/alternatives" },
];

export default function ThingsToDoNaplesPage() {
  return (
    <div className="min-h-screen bg-[#0a1628] text-white">
      <BreadcrumbJsonLd
        items={[
          { name: "HeadPinz", url: "https://headpinz.com" },
          { name: "Things to Do in Naples", url: "https://headpinz.com/things-to-do-naples" },
        ]}
      />

      {/* Hero */}
      <section style={{ padding: "clamp(80px, 14vw, 160px) clamp(16px, 4vw, 32px) 40px" }}>
        <div className="max-w-4xl mx-auto text-center">
          <div className="uppercase font-bold mb-4" style={{ color: "#fd5b56", fontSize: "12px", letterSpacing: "3px" }}>
            Naples FL Entertainment Guide
          </div>
          <h1
            className="font-heading font-black uppercase italic text-white"
            style={{ fontSize: "clamp(32px, 7vw, 68px)", lineHeight: 1.05, letterSpacing: "-0.8px", marginBottom: "16px" }}
          >
            Things to do in Naples, FL
          </h1>
          <p
            className="font-body text-white/80 mx-auto"
            style={{ fontSize: "clamp(16px, 2.2vw, 22px)", lineHeight: 1.5, maxWidth: "52ch" }}
          >
            Naples is known for its beaches, dining, and outdoor life — but when you want indoor
            entertainment that works rain or shine, here's what's on the list. HeadPinz Naples is
            our hometown spot on Radio Lane, and below we've added a few alternative comparisons
            to help you decide what fits your group best.
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
            Indoor attractions at HeadPinz Naples
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
            Naples things to do by occasion
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

      {/* Alternatives / other venues */}
      <section style={{ padding: "60px clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-5xl mx-auto">
          <h2
            className="font-heading font-black uppercase italic text-white text-center"
            style={{ fontSize: "clamp(24px, 4.5vw, 40px)", lineHeight: 1.05, letterSpacing: "-0.4px", marginBottom: "12px" }}
          >
            Comparing Naples entertainment venues
          </h2>
          <p className="font-body text-white/60 text-center mx-auto mb-8" style={{ fontSize: "14px", maxWidth: "50ch" }}>
            Here's how HeadPinz stacks up against other SWFL venues — pick what fits your group best.
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
            Pick your activity
          </h2>
          <p className="font-body text-white/70 mx-auto" style={{ fontSize: "16px", lineHeight: 1.6, marginBottom: "32px", maxWidth: "42ch" }}>
            Book a lane, laser tag, or group event at HeadPinz Naples on Radio Lane. Rain-or-shine, any day of the week.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href="/book/bowling?location=3148" className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105" style={{ backgroundColor: "#fd5b56", color: "#ffffff" }}>
              Book a lane
            </Link>
            <Link href="/naples/group-events" className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105 text-white" style={{ border: "1px solid rgba(255,255,255,0.25)" }}>
              Group event packages
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
