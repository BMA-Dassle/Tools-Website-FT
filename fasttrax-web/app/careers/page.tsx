import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Careers at FastTrax | Now Hiring in Fort Myers FL",
  description:
    "Join the FastTrax team! We're hiring for positions at our Fort Myers entertainment center — track staff, kitchen, bar, guest services & more. Apply today!",
  keywords: [
    "FastTrax jobs",
    "FastTrax careers",
    "jobs Fort Myers",
    "entertainment jobs Fort Myers",
    "go kart jobs Fort Myers",
    "part time jobs Fort Myers",
    "now hiring Fort Myers",
    "FastTrax hiring",
    "hospitality jobs Fort Myers",
    "racing jobs Fort Myers",
  ],
  openGraph: {
    title: "Now Hiring at FastTrax | Fort Myers, FL",
    description:
      "Join our team at FastTrax Entertainment Center! Positions available in Fort Myers. Apply now.",
    type: "website",
    url: "https://fasttraxent.com/careers",
  },
  alternates: { canonical: "https://fasttraxent.com/careers" },
};

// Re-fetch at most once per hour
export const revalidate = 3600;

const red = "#e50000";
const bg = "#000418";
const APPLY_BASE = "https://bowlandheadpinzfasttrax.applytojob.com/apply";

// ─── JazzHR XML feed ─────────────────────────────────────────────────────────

interface Job {
  title: string;
  department: string;
  url: string;
  city: string;
  state: string;
  type: string;
}

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

function typeColor(type: string) {
  if (type.toLowerCase().includes("full"))
    return { bg: "rgba(229,0,0,0.15)", color: red };
  return { bg: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.7)" };
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default async function CareersPage() {
  const jobs = await fetchJobs();
  const hasJobs = jobs.length > 0;

  return (
    <main style={{ background: bg, minHeight: "100vh", color: "#fff", paddingBottom: "80px" }}>
      <style>{`.ft-career-link:hover .ft-career-card{border-color:rgba(229,0,0,0.5)!important;background:rgba(255,255,255,0.05)!important}`}</style>

      {/* Hero */}
      <section style={{
        paddingTop: "clamp(120px, 18vw, 180px)",
        paddingBottom: "60px",
        paddingLeft: "24px",
        paddingRight: "24px",
        textAlign: "center",
        maxWidth: "800px",
        margin: "0 auto",
      }}>
        <p style={{
          color: red,
          fontFamily: "var(--font-exo2)",
          fontWeight: 800,
          fontSize: "13px",
          letterSpacing: "4px",
          textTransform: "uppercase",
          marginBottom: "16px",
        }}>
          Now Hiring
        </p>
        <h1 style={{
          fontFamily: "var(--font-exo2)",
          fontWeight: 900,
          fontSize: "clamp(2.5rem, 6vw, 4rem)",
          lineHeight: 1.05,
          textTransform: "uppercase",
          marginBottom: "20px",
        }}>
          Join the FastTrax Team
        </h1>
        <p style={{
          fontFamily: "var(--font-barlow)",
          fontSize: "1.1rem",
          color: "rgba(255,255,255,0.7)",
          lineHeight: 1.7,
          marginBottom: "36px",
        }}>
          We&apos;re building the crew behind Fort Myers&apos; most exciting entertainment
          destination. If you thrive in a fast-paced, high-energy environment and want
          to love where you work — we want to hear from you.
        </p>
        <a
          href={APPLY_BASE}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            background: red,
            color: "#fff",
            fontFamily: "var(--font-exo2)",
            fontWeight: 800,
            fontSize: "14px",
            letterSpacing: "2px",
            textTransform: "uppercase",
            padding: "16px 36px",
            borderRadius: "4px",
            textDecoration: "none",
            boxShadow: "0 0 24px rgba(229,0,0,0.4)",
          }}
        >
          View All Open Positions &amp; Apply
        </a>
      </section>

      {/* Open positions */}
      <section style={{ maxWidth: "900px", margin: "0 auto", padding: "0 24px" }}>
        <h2 style={{
          fontFamily: "var(--font-exo2)",
          fontWeight: 800,
          fontSize: "1.5rem",
          textTransform: "uppercase",
          letterSpacing: "2px",
          marginBottom: "8px",
          textAlign: "center",
        }}>
          Open Positions
        </h2>
        <p style={{
          fontFamily: "var(--font-barlow)",
          color: "rgba(255,255,255,0.35)",
          fontSize: "0.8rem",
          textAlign: "center",
          marginBottom: "32px",
        }}>
          Updated live from our hiring portal
        </p>

        {hasJobs ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {jobs.map((job, i) => {
              const tc = typeColor(job.type);
              const location = [job.city, job.state].filter(Boolean).join(", ");
              return (
                <a
                  key={`${job.url}-${i}`}
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${job.title} at ${job.department} — apply on hiring portal`}
                  className="ft-career-link"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <div
                    className="ft-career-card"
                    style={{
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: "6px",
                      padding: "20px 24px",
                      transition: "border-color 0.2s, background 0.2s",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px", marginBottom: "10px" }}>
                      <h3 style={{ fontFamily: "var(--font-exo2)", fontWeight: 700, fontSize: "1.05rem", margin: 0, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                        {job.title}
                      </h3>
                      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                        {job.type && (
                          <span style={{ background: tc.bg, color: tc.color, borderRadius: "3px", padding: "3px 10px", fontSize: "11px", fontFamily: "var(--font-barlow)", fontWeight: 600, whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                            {job.type}
                          </span>
                        )}
                        {location && (
                          <span style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.6)", borderRadius: "3px", padding: "3px 10px", fontSize: "11px", fontFamily: "var(--font-barlow)", fontWeight: 600, whiteSpace: "nowrap" }}>
                            {location}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                      {job.department && (
                        <p style={{ fontFamily: "var(--font-barlow)", color: "rgba(255,255,255,0.4)", fontSize: "0.85rem", margin: 0 }}>
                          {job.department}
                        </p>
                      )}
                      <span style={{ color: red, fontFamily: "var(--font-exo2)", fontWeight: 700, fontSize: "12px", letterSpacing: "1px", textTransform: "uppercase" }}>
                        Apply →
                      </span>
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: "48px 24px", background: "rgba(255,255,255,0.02)", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.06)" }}>
            <p style={{ fontFamily: "var(--font-barlow)", color: "rgba(255,255,255,0.5)", fontSize: "1rem", marginBottom: "20px" }}>
              View our current openings on our hiring portal.
            </p>
            <a
              href={APPLY_BASE}
              target="_blank"
              rel="noopener noreferrer"
              style={{ background: red, color: "#fff", fontFamily: "var(--font-exo2)", fontWeight: 800, fontSize: "13px", letterSpacing: "2px", textTransform: "uppercase", padding: "14px 28px", borderRadius: "4px", textDecoration: "none" }}
            >
              See Open Positions
            </a>
          </div>
        )}
      </section>

      {/* CTA */}
      <section style={{ maxWidth: "700px", margin: "64px auto 0", padding: "0 24px", textAlign: "center" }}>
        <div style={{
          background: "linear-gradient(135deg, #0d0d2b 0%, #1a0000 100%)",
          border: "1px solid rgba(229,0,0,0.2)",
          borderRadius: "8px",
          padding: "48px 36px",
        }}>
          <h2 style={{ fontFamily: "var(--font-exo2)", fontWeight: 900, fontSize: "1.7rem", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "16px" }}>
            Don&apos;t see your role?
          </h2>
          <p style={{ fontFamily: "var(--font-barlow)", color: "rgba(255,255,255,0.7)", fontSize: "1rem", lineHeight: 1.7, marginBottom: "28px" }}>
            We&apos;re always looking for great people. Submit your application through our
            careers portal and we&apos;ll be in touch.
          </p>
          <div style={{ display: "flex", gap: "16px", justifyContent: "center", flexWrap: "wrap" }}>
            <a
              href={APPLY_BASE}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background: red,
                color: "#fff",
                fontFamily: "var(--font-exo2)",
                fontWeight: 800,
                fontSize: "13px",
                letterSpacing: "2px",
                textTransform: "uppercase",
                padding: "14px 28px",
                borderRadius: "4px",
                textDecoration: "none",
                boxShadow: "0 0 16px rgba(229,0,0,0.35)",
              }}
            >
              Apply Now
            </a>
            <Link
              href="/racing"
              style={{
                background: "rgba(255,255,255,0.07)",
                color: "#fff",
                fontFamily: "var(--font-exo2)",
                fontWeight: 700,
                fontSize: "13px",
                letterSpacing: "2px",
                textTransform: "uppercase",
                padding: "14px 28px",
                borderRadius: "4px",
                textDecoration: "none",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            >
              Back to FastTrax
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
