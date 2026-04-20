import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/seo/JsonLd";

/**
 * Things to Do in Fort Myers — FastTrax-side hub page targeting the
 * high-volume "things to do in Fort Myers" / "fun things to do Fort Myers"
 * local-intent queries. Internal linking to all our attraction and
 * alternative pages signals topical authority on SWFL entertainment.
 */

export const metadata: Metadata = {
  title: "Things to Do in Fort Myers | Indoor Entertainment Guide",
  description:
    "Your guide to things to do in Fort Myers — indoor electric kart racing, bowling, arcade, laser tag, mini golf, and more. Rain-or-shine entertainment in Southwest Florida.",
  alternates: { canonical: "https://fasttraxent.com/things-to-do-fort-myers" },
  keywords: [
    "things to do Fort Myers",
    "things to do in Fort Myers today",
    "fun things to do Fort Myers",
    "Fort Myers entertainment",
    "indoor activities Fort Myers",
    "rainy day Fort Myers",
    "Fort Myers attractions",
    "things to do SWFL",
    "family fun Fort Myers",
    "date night Fort Myers",
  ],
  openGraph: {
    title: "Things to Do in Fort Myers | FastTrax Guide",
    description:
      "Indoor entertainment guide for Fort Myers — karting, bowling, arcade, laser tag, and more.",
    url: "https://fasttraxent.com/things-to-do-fort-myers",
    siteName: "FastTrax Entertainment",
    type: "article",
  },
};

const activities = [
  { title: "Indoor electric kart racing", body: "Florida's largest indoor electric kart track runs year-round in climate control. Adult, Junior, and Mini classes welcome ages 3+.", href: "/racing" },
  { title: "Duckpin bowling", body: "Smaller balls, shorter lanes, more strikes. Beginner-friendly bowling for groups and families.", href: "/book/duck-pin" },
  { title: "Shuffleboard", body: "Old-school, new-school fun. Great for small groups and casual competition.", href: "/book/shuffly" },
  { title: "Gel blaster arena", body: "Low-impact tactical play — eye protection provided. Alternative to paintball and laser tag.", href: "/book/gel-blaster" },
  { title: "Laser tag (at HeadPinz)", body: "NEXUS laser tag arena in the same complex as FastTrax. Combine racing + laser tag in one trip.", href: "https://headpinz.com/fort-myers/attractions" },
  { title: "Arcade + redemption", body: "50+ modern arcade games with ticket redemption. All-ages friendly.", href: "/attractions" },
  { title: "Nemo's Trackside dining", body: "Wood-fired pizza, craft cocktails, and full bar. Sit-down dining with a view of the track.", href: "/menu" },
];

const byOccasion = [
  { heading: "Rainy day?", body: "FastTrax and HeadPinz are fully indoor — rain, thunderstorms, and Florida humidity don't stop play.", href: "/racing" },
  { heading: "Kids birthday party?", body: "Mini karts for ages 3-6, bowling packages, arcade, laser tag. Packages available for 10-60+ guests.", href: "/group-events" },
  { heading: "Corporate team building?", body: "Private race heats, bundled food and drink, full facility buyouts for 60+ employees.", href: "/group-events" },
  { heading: "Date night?", body: "Races, cocktails at Nemo's, arcade, and dessert. Typical evening runs 1.5-2 hours.", href: "/racing" },
  { heading: "Family with young kids?", body: "Mini karts start at age 3. Indoor setting means no sun exposure, no heat, no mosquitoes.", href: "/attractions" },
  { heading: "Guys or girls night out?", body: "Full bar, cocktails, craft beer. Bowl a round, race a few heats, hit the arcade.", href: "/menu" },
];

const otherVenues = [
  { name: "HeadPinz Fort Myers", desc: "Sister center — 24 bowling lanes, NEXUS laser tag, gel blasters, arcade, Nemo's Sports Bistro.", href: "https://headpinz.com/fort-myers" },
  { name: "PopStroke alternative", desc: "If you're comparing outdoor putting to indoor entertainment.", href: "/alternatives/pop-stroke" },
  { name: "Topgolf alternative", desc: "If you're looking for something other than a driving range.", href: "/alternatives/topgolf" },
  { name: "Dave & Buster's alternative", desc: "Same arcade-and-dining vibe plus indoor karting.", href: "/alternatives/dave-and-busters" },
  { name: "Gator Mike's alternative", desc: "Indoor option for days the outdoor weather isn't cooperating.", href: "/alternatives/gator-mikes" },
  { name: "See all alternatives", desc: "Side-by-side comparisons with 7 SWFL entertainment venues.", href: "/alternatives" },
];

export default function ThingsToDoFortMyersPage() {
  return (
    <div className="min-h-screen bg-[#000418] text-white">
      <BreadcrumbJsonLd
        items={[
          { name: "FastTrax", url: "https://fasttraxent.com" },
          { name: "Things to Do in Fort Myers", url: "https://fasttraxent.com/things-to-do-fort-myers" },
        ]}
      />

      {/* Hero */}
      <section style={{ padding: "clamp(80px, 14vw, 160px) clamp(16px, 4vw, 32px) 40px" }}>
        <div className="max-w-4xl mx-auto text-center">
          <div className="uppercase font-bold mb-4" style={{ color: "#00E2E5", fontSize: "12px", letterSpacing: "3px" }}>
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
            Fort Myers has a great mix of indoor entertainment, outdoor parks, dining, and nightlife.
            Here's a locals-eye guide to what you can do — with a focus on the indoor, rain-or-shine,
            works-for-any-group options that keep Southwest Florida fun even when the weather isn't.
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
            Indoor attractions at FastTrax + HeadPinz
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {activities.map((a) => (
              <Link
                key={a.title}
                href={a.href}
                className="rounded-2xl p-6 transition-transform hover:scale-[1.02]"
                style={{ backgroundColor: "#071027", border: "1px solid rgba(0,226,229,0.25)" }}
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
                style={{ backgroundColor: "#071027", border: "1px solid rgba(255,255,255,0.08)" }}
              >
                <div className="uppercase font-bold mb-2" style={{ color: "#00E2E5", fontSize: "11px", letterSpacing: "2px" }}>
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

      {/* Comparison + other venues */}
      <section style={{ padding: "60px clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-5xl mx-auto">
          <h2
            className="font-heading font-black uppercase italic text-white text-center"
            style={{ fontSize: "clamp(24px, 4.5vw, 40px)", lineHeight: 1.05, letterSpacing: "-0.4px", marginBottom: "12px" }}
          >
            Comparing Fort Myers entertainment venues
          </h2>
          <p className="font-body text-white/60 text-center mx-auto mb-8" style={{ fontSize: "14px", maxWidth: "50ch" }}>
            A lot of venues in SWFL do one part of the entertainment stack really well. Here's how we compare.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {otherVenues.map((v) => (
              <Link
                key={v.name}
                href={v.href}
                className="rounded-2xl p-6 transition-transform hover:scale-[1.02]"
                style={{ backgroundColor: "#071027", border: "1px solid rgba(255,255,255,0.08)" }}
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
            Ready to do something fun?
          </h2>
          <p className="font-body text-white/70 mx-auto" style={{ fontSize: "16px", lineHeight: 1.6, marginBottom: "32px", maxWidth: "42ch" }}>
            Book a heat, a lane, or a group event — rain-or-shine, year-round, just off Global Parkway.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href="/book/race" className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105" style={{ backgroundColor: "#00E2E5", color: "#000418" }}>
              Book a heat
            </Link>
            <Link href="/group-events" className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105 text-white" style={{ border: "1px solid rgba(255,255,255,0.25)" }}>
              Group event packages
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
