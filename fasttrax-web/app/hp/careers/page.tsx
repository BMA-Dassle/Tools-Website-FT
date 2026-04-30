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

// Re-fetch at most once per hour
export const revalidate = 3600;

const coral = "#fd5b56";
const purple = "#123075";
const bg = "#0a1628";
const APPLY_BASE = "https://bowlandheadpinzfasttrax.applytojob.com/apply";

// ─── JazzHR XML feed types ────────────────────────────────────────────────────

interface Job {
  title: string;
  department: string;
  url: string;
  city: string;
  state: string;
  type: string;
}

// Strip CDATA wrappers if present
function parseCDATA(s: string): string {
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (!match) return "";
  return parseCDATA(match[1].trim());
}

async function fetchJobs(): Promise<Job[]> {
  try {
    const res = await fetch(
      "https://app.jazz.co/feeds/export/jobs/bowlandheadpinzfasttrax",
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const blocks = [...xml.matchAll(/<job>([\s\S]*?)<\/job>/g)];
    return blocks
      .map((m) => ({
        title: extractTag(m[1], "title"),
        department: extractTag(m[1], "department"),
        url: extractTag(m[1], "url").replace(/^http:/, "https:"),
        city: extractTag(m[1], "city"),
        state: extractTag(m[1], "state"),
        type: extractTag(m[1], "type"),
      }))
      .filter((j) => j.title && j.url);
  } catch {
    return [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function typeColor(type: string) {
  if (type.toLowerCase().includes("full")) return { bg: "rgba(18,48,117,0.5)", color: "#93b4ff" };
  return { bg: "rgba(253,91,86,0.15)", color: coral };
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default async function CareersPage() {
  const jobs = await fetchJobs();
  const hasJobs = jobs.length > 0;

  return (
    <main style={{ background: bg, minHeight: "100vh", color: "#fff", paddingBottom: "80px" }}>

      {/* Hero */}
      <section style={{ paddingTop: "clamp(120px, 18vw, 180px)", paddingBottom: "60px", paddingLeft: "24px", paddingRight: "24px", textAlign: "center", maxWidth: "800px", margin: "0 auto" }}>
        <p style={{ color: coral, fontFamily: "var(--font-outfit)", fontWeight: 700, fontSize: "14px", letterSpacing: "3px", textTransform: "uppercase", marginBottom: "16px" }}>
          Now Hiring
        </p>
        <h1 style={{ fontFamily: "var(--font-outfit)", fontWeight: 900, fontSize: "clamp(2.5rem, 6vw, 4rem)", lineHeight: 1.1, marginBottom: "20px" }}>
          Join the HeadPinz Team
        </h1>
        <p style={{ fontFamily: "var(--font-dmsans)", fontSize: "1.1rem", color: "rgba(255,255,255,0.75)", lineHeight: 1.7, marginBottom: "36px" }}>
          We&apos;re building the best entertainment team in Southwest Florida. If you love people,
          thrive in a fast-paced environment, and want to come to work somewhere genuinely fun —
          we want to hear from you. Positions available at our Fort Myers and Naples locations.
        </p>
        <a
          href={APPLY_BASE}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex", alignItems: "center",
            background: coral, color: "#fff",
            fontFamily: "var(--font-outfit)", fontWeight: 700,
            fontSize: "15px", letterSpacing: "1px", textTransform: "uppercase",
            padding: "16px 36px", borderRadius: "555px",
            textDecoration: "none",
          }}
        >
          View All Open Positions &amp; Apply
        </a>
      </section>

      {/* Open positions */}
      <section style={{ maxWidth: "900px", margin: "0 auto", padding: "0 24px" }}>
        <h2 style={{ fontFamily: "var(--font-outfit)", fontWeight: 800, fontSize: "1.6rem", marginBottom: "8px", textAlign: "center" }}>
          Open Positions
        </h2>
        <p style={{ fontFamily: "var(--font-dmsans)", color: "rgba(255,255,255,0.45)", fontSize: "0.8rem", textAlign: "center", marginBottom: "32px" }}>
          Updated live from our hiring portal
        </p>

        {hasJobs ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {jobs.map((job, i) => {
              const tc = typeColor(job.type);
              const location = [job.city, job.state].filter(Boolean).join(", ");
              return (
                <a
                  key={`${job.url}-${i}`}
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <div style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "16px", padding: "22px 26px",
                    transition: "border-color 0.2s, background 0.2s",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = "rgba(253,91,86,0.5)";
                    (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.07)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.1)";
                    (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)";
                  }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px", marginBottom: "10px" }}>
                      <h3 style={{ fontFamily: "var(--font-outfit)", fontWeight: 700, fontSize: "1.1rem", margin: 0 }}>
                        {job.title}
                      </h3>
                      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                        {job.type && (
                          <span style={{ background: tc.bg, color: tc.color, borderRadius: "555px", padding: "4px 12px", fontSize: "12px", fontFamily: "var(--font-dmsans)", fontWeight: 600, whiteSpace: "nowrap" }}>
                            {job.type}
                          </span>
                        )}
                        {location && (
                          <span style={{ background: "rgba(18,48,117,0.4)", color: "#93b4ff", borderRadius: "555px", padding: "4px 12px", fontSize: "12px", fontFamily: "var(--font-dmsans)", fontWeight: 600, whiteSpace: "nowrap" }}>
                            {location}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                      {job.department && (
                        <p style={{ fontFamily: "var(--font-dmsans)", color: "rgba(255,255,255,0.5)", fontSize: "0.85rem", margin: 0 }}>
                          {job.department}
                        </p>
                      )}
                      <span style={{ color: coral, fontFamily: "var(--font-outfit)", fontWeight: 700, fontSize: "13px", letterSpacing: "0.5px" }}>
                        Apply →
                      </span>
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: "48px 24px", background: "rgba(255,255,255,0.03)", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.08)" }}>
            <p style={{ fontFamily: "var(--font-dmsans)", color: "rgba(255,255,255,0.6)", fontSize: "1rem", marginBottom: "20px" }}>
              View our current openings on our hiring portal.
            </p>
            <a
              href={APPLY_BASE}
              target="_blank"
              rel="noopener noreferrer"
              style={{ background: coral, color: "#fff", fontFamily: "var(--font-outfit)", fontWeight: 700, fontSize: "14px", letterSpacing: "1px", textTransform: "uppercase", padding: "14px 28px", borderRadius: "555px", textDecoration: "none" }}
            >
              See Open Positions
            </a>
          </div>
        )}
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
            We&apos;re always looking for great people. Submit your application through our careers portal and we&apos;ll be in touch.
          </p>
          <div style={{ display: "flex", gap: "16px", justifyContent: "center", flexWrap: "wrap" }}>
            <a
              href={APPLY_BASE}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background: coral, color: "#fff",
                fontFamily: "var(--font-outfit)", fontWeight: 700, fontSize: "14px",
                letterSpacing: "1px", textTransform: "uppercase",
                padding: "14px 28px", borderRadius: "555px", textDecoration: "none",
              }}
            >
              Apply Now
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
