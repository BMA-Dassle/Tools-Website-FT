import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/seo/JsonLd";
import { HEADPINZ_OG, HEADPINZ_OG_IMAGE } from "@/lib/seo";
import { getAllPosts } from "@/lib/blog/posts";
import { PostCard } from "@/components/blog/PostCard";

/**
 * HeadPinz blog index. Internal URL is /hp/blog; the middleware rewrite makes
 * the public URL headpinz.com/blog. FastTrax has no blog yet — when one is
 * added, mirror this route at apps/web/app/blog/ (and update the sitemap +
 * SHARED_TOP_LEVEL_ROUTES if it should serve from both hosts).
 */

const CANONICAL = "https://headpinz.com/blog";

export const metadata: Metadata = {
  title: "Family Fun Guide — Tips, Guides & Things to Do in SWFL",
  description:
    "The HeadPinz family fun guide — indoor activities, birthday party ideas, league info, and things-to-do guides for Fort Myers and Naples families.",
  alternates: { canonical: CANONICAL },
  keywords: [
    "things to do Fort Myers",
    "things to do Naples",
    "family fun Fort Myers",
    "family fun Naples",
    "indoor activities Fort Myers",
    "kids activities Fort Myers",
    "HeadPinz blog",
    "Southwest Florida family guide",
  ],
  openGraph: {
    title: "HeadPinz Family Fun Guide",
    description:
      "Indoor activities, birthday ideas, league info, and things-to-do guides for Fort Myers and Naples families.",
    url: CANONICAL,
    siteName: "HeadPinz",
    type: "website",
    images: [...HEADPINZ_OG],
  },
  twitter: {
    card: "summary_large_image",
    title: "HeadPinz Family Fun Guide",
    description: "Indoor activities, birthday ideas, and things-to-do guides for SWFL families.",
    images: [HEADPINZ_OG_IMAGE],
  },
};

export default function BlogIndexPage() {
  const posts = getAllPosts("headpinz");

  return (
    <div className="min-h-screen bg-[#0a1628] text-white">
      <BreadcrumbJsonLd
        items={[
          { name: "HeadPinz", url: "https://headpinz.com" },
          { name: "Family Fun Guide", url: CANONICAL },
        ]}
      />

      <section style={{ padding: "clamp(80px, 14vw, 160px) clamp(16px, 4vw, 32px) 40px" }}>
        <div className="max-w-4xl mx-auto text-center">
          <div
            className="uppercase font-bold mb-4"
            style={{ color: "#fd5b56", fontSize: "12px", letterSpacing: "3px" }}
          >
            HeadPinz · Family Fun Guide
          </div>
          <h1
            className="font-heading font-black uppercase italic text-white"
            style={{
              fontSize: "clamp(32px, 7vw, 68px)",
              lineHeight: 1.05,
              letterSpacing: "-0.8px",
              marginBottom: "16px",
            }}
          >
            The HeadPinz Family Fun Guide
          </h1>
          <p
            className="font-body text-white/80 mx-auto"
            style={{ fontSize: "clamp(16px, 2.2vw, 22px)", lineHeight: 1.5, maxWidth: "52ch" }}
          >
            Indoor activities, birthday ideas, league info, and Southwest Florida family guides —
            written by the folks who run HeadPinz Fort Myers and Naples.
          </p>
        </div>
      </section>

      <section style={{ padding: "20px clamp(16px, 4vw, 32px) 60px" }}>
        <div className="max-w-6xl mx-auto">
          {posts.length === 0 ? (
            <p
              className="font-body text-white/65 text-center"
              style={{ fontSize: "16px", padding: "60px 0" }}
            >
              New posts are coming soon. In the meantime, explore{" "}
              <Link
                href="/fort-myers/attractions"
                style={{ color: "#fd5b56", textDecoration: "underline" }}
              >
                our attractions
              </Link>{" "}
              or{" "}
              <Link
                href="/things-to-do-fort-myers"
                style={{ color: "#fd5b56", textDecoration: "underline" }}
              >
                things to do in Fort Myers
              </Link>
              .
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {posts.map((p) => (
                <PostCard key={p.meta.slug} meta={p.meta} basePath="/blog" />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
