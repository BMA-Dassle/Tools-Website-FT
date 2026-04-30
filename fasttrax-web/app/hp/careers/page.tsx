import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Careers at HeadPinz | Now Hiring in Fort Myers & Naples FL",
  description:
    "Join the HeadPinz team! We're hiring for positions at our Fort Myers and Naples entertainment centers — front desk, kitchen, bar, events staff & more. Apply today!",
  keywords: [
    "HeadPinz jobs",
    "HeadPinz careers",
    "jobs Fort Myers",
    "jobs Naples FL",
    "entertainment jobs Fort Myers",
    "bowling alley jobs",
    "part time jobs Fort Myers",
    "hospitality jobs Naples",
    "HeadPinz hiring",
    "now hiring Fort Myers",
  ],
  openGraph: {
    title: "Now Hiring at HeadPinz | Fort Myers & Naples",
    description:
      "Join our team at HeadPinz! Positions available at Fort Myers and Naples locations. Apply now.",
    type: "website",
    url: "https://headpinz.com/careers",
  },
  alternates: { canonical: "https://headpinz.com/careers" },
};

const coral = "#fd5b56";
const purple = "#123075";
const bg = "#0a1628";

const positions = [
  {
    title: "Front Desk / Guest Services",
    type: "Full-time & Part-time",
    locations: ["Fort Myers", "Naples"],
    desc: "Greet guests, manage lane reservations, process payments, and ensure every visit starts with a great experience.",
  },
  {
    title: "Bartender / Bar Back",
    type: "Full-time & Part-time",
    locations: ["Fort Myers", "Naples"],
    desc: "Craft cocktails and serve guests at Nemo's Sports Bistro. Must be 21+ with TIPS certification or willingness to obtain.",
  },
  {
    title: "Kitchen Staff / Line Cook",
    type: "Full-time & Part-time",
    locations: ["Fort Myers", "Naples"],
    desc: "Prep and execute menu items at Nemo's Sports Bistro. Experience preferred but willing to train the right candidate.",
  },
  {
    title: "Events Coordinator",
    type: "Full-time",
    locations: ["Fort Myers"],
    desc: "Plan and execute corporate events, birthday parties, and group bookings. Strong communication and organization skills required.",
  },
  {
    title: "Attractions Attendant",
    type: "Part-time",
    locations: ["Fort Myers", "Naples"],
    desc: "Operate laser tag, gel blasters, NeoVerse, and arcade areas. Keep guests safe and having fun.",
  },
];

export default function CareersPage() {
  return (
    <main style={{ background: bg, minHeight: "100vh", color: "#fff", paddingBottom: "80px" }}>
      {/* Hero */}
      <section style={{ padding: "80px 24px 60px", textAlign: "center", maxWidth: "800px", margin: "0 auto" }}>
        <p style={{ color: coral, fontFamily: "var(--font-outfit)", fontWeight: 700, fontSize: "14px", letterSpacing: "3px", textTransform: "uppercase", marginBottom: "16px" }}>
          Now Hiring
        </p>
        <h1 style={{ fontFamily: "var(--font-outfit)", fontWeight: 900, fontSize: "clamp(2.5rem, 6vw, 4rem)", lineHeight: 1.1, marginBottom: "20px" }}>
          Join the HeadPinz Team
        </h1>
        <p style={{ fontFamily: "var(--font-dmsans)", fontSize: "1.1rem", color: "rgba(255,255,255,0.75)", lineHeight: 1.7, marginBottom: "36px" }}>
          We&apos;re building the best entertainment team in Southwest Florida. If you love people,
          thrive in a fast-paced environment, and want to come to work somewhere genuinely fun —
          we want to hear from you. Positions available at both our Fort Myers and Naples locations.
        </p>
        <a
          href="https://www.indeed.com/cmp/headpinz"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex", alignItems: "center",
            background: coral, color: "#fff",
            fontFamily: "var(--font-outfit)", fontWeight: 700,
            fontSize: "15px", letterSpacing: "1px", textTransform: "uppercase",
            padding: "16px 36px", borderRadius: "555px",
            textDecoration: "none", transition: "opacity 0.2s",
          }}
        >
          Apply on Indeed
        </a>
      </section>

      {/* Open positions */}
      <section style={{ maxWidth: "900px", margin: "0 auto", padding: "0 24px" }}>
        <h2 style={{ fontFamily: "var(--font-outfit)", fontWeight: 800, fontSize: "1.6rem", marginBottom: "32px", textAlign: "center" }}>
          Open Positions
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {positions.map((pos) => (
            <div key={pos.title} style={{
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "16px", padding: "24px 28px",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "8px", marginBottom: "10px" }}>
                <h3 style={{ fontFamily: "var(--font-outfit)", fontWeight: 700, fontSize: "1.1rem", margin: 0 }}>{pos.title}</h3>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <span style={{ background: "rgba(253,91,86,0.15)", color: coral, borderRadius: "555px", padding: "4px 12px", fontSize: "12px", fontFamily: "var(--font-dmsans)", fontWeight: 600 }}>
                    {pos.type}
                  </span>
                  {pos.locations.map((loc) => (
                    <span key={loc} style={{ background: "rgba(18,48,117,0.4)", color: "#93b4ff", borderRadius: "555px", padding: "4px 12px", fontSize: "12px", fontFamily: "var(--font-dmsans)", fontWeight: 600 }}>
                      {loc}
                    </span>
                  ))}
                </div>
              </div>
              <p style={{ fontFamily: "var(--font-dmsans)", color: "rgba(255,255,255,0.65)", fontSize: "0.95rem", lineHeight: 1.6, margin: 0 }}>
                {pos.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section style={{ maxWidth: "700px", margin: "64px auto 0", padding: "0 24px", textAlign: "center" }}>
        <div style={{
          background: `linear-gradient(135deg, ${purple} 0%, #1a3fa0 100%)`,
          borderRadius: "24px", padding: "48px 36px",
        }}>
          <h2 style={{ fontFamily: "var(--font-outfit)", fontWeight: 800, fontSize: "1.8rem", marginBottom: "16px" }}>
            Don&apos;t see your role?
          </h2>
          <p style={{ fontFamily: "var(--font-dmsans)", color: "rgba(255,255,255,0.8)", fontSize: "1rem", lineHeight: 1.7, marginBottom: "28px" }}>
            We&apos;re always looking for great people. Send your résumé and a quick intro to{" "}
            <a href="mailto:careers@headpinz.com" style={{ color: coral, textDecoration: "underline" }}>
              careers@headpinz.com
            </a>{" "}
            and tell us how you&apos;d fit in.
          </p>
          <div style={{ display: "flex", gap: "16px", justifyContent: "center", flexWrap: "wrap" }}>
            <a
              href="https://www.indeed.com/cmp/headpinz"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background: coral, color: "#fff",
                fontFamily: "var(--font-outfit)", fontWeight: 700, fontSize: "14px",
                letterSpacing: "1px", textTransform: "uppercase",
                padding: "14px 28px", borderRadius: "555px", textDecoration: "none",
              }}
            >
              View All on Indeed
            </a>
            <Link
              href="/fort-myers"
              style={{
                background: "rgba(255,255,255,0.12)", color: "#fff",
                fontFamily: "var(--font-outfit)", fontWeight: 700, fontSize: "14px",
                letterSpacing: "1px", textTransform: "uppercase",
                padding: "14px 28px", borderRadius: "555px", textDecoration: "none",
              }}
            >
              Back to HeadPinz
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
