import Link from "next/link";

// Exact data from live site — 3 cards (Birthday Parties hidden on desktop in live site, but visible)
const events = [
  {
    title: "CORPORATE EVENTS",
    desc: "Team building that actually builds teams",
    titleColor: "rgb(228,28,29)",
    border: "rgb(228,28,29)",
  },
  {
    title: "BIRTHDAY PARTIES",
    desc: "Make it a celebration they'll never forget",
    titleColor: "rgb(134,82,255)",
    border: "rgb(134,82,255)",
  },
  {
    title: "PRIVATE EVENTS",
    desc: "Exclusive access to the entire facility",
    titleColor: "rgb(0,74,173)",
    border: "rgb(0,74,173)",
  },
];

export default function GroupEvents() {
  return (
    <section className="bg-[#000418]" style={{ padding: "120px 0" }}>
      <div className="max-w-7xl mx-auto px-8 text-center">

        {/* Heading */}
        <h2
          className="font-heading font-black uppercase text-white leading-[0.9] mb-6"
          style={{ fontSize: "clamp(2.5rem, 7vw, 72px)" }}
        >
          EVENTS FOR 14 TO 1,000+ GUESTS
        </h2>

        {/* Subtext */}
        <p
          className="mx-auto mb-12"
          style={{
            color: "rgba(245,236,238,0.898)",
            fontSize: "20px",
            fontFamily: "var(--font-body)",
            lineHeight: "1.6",
            maxWidth: "700px",
          }}
        >
          Whether it&apos;s racing, bowling, or a full-campus takeover, we have the largest entertainment
          capacity in Southwest Florida. We handle the details; you take the trophy.
        </p>

        {/* Cards — 3 col */}
        <div className="flex flex-col sm:flex-row gap-6 justify-center mb-12">
          {events.map((e) => (
            <div
              key={e.title}
              className="flex-1"
              style={{ maxWidth: "445px" }}
            >
              <div
                className="h-full"
                style={{
                  backgroundColor: "rgba(7,16,39,0.6)",
                  border: `1.78px dashed ${e.border}`,
                  borderRadius: "44px",
                  padding: "44px 16px",
                }}
              >
                <h3
                  className="font-heading uppercase mb-3"
                  style={{ color: e.titleColor, fontSize: "24px" }}
                >
                  {e.title}
                </h3>
                <p style={{ color: "rgba(245,236,238,0.698)", fontSize: "16px", fontFamily: "var(--font-body)" }}>
                  {e.desc}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* CTA */}
        <Link
          href="/group-events"
          className="inline-block font-body font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
          style={{
            backgroundColor: "rgb(0,74,173)",
            borderRadius: "555px",
            padding: "16px 48px",
            fontSize: "14px",
          }}
        >
          PLAN YOUR GROUP EVENT
        </Link>

      </div>
    </section>
  );
}
