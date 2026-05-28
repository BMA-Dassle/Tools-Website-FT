import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArticleJsonLd, BreadcrumbJsonLd } from "@/components/seo/JsonLd";
import { HEADPINZ_OG_IMAGE } from "@/lib/seo";
import { getAllPosts, getPostBySlug, listPostSlugs } from "@/lib/blog/posts";
import { PostHero } from "@/components/blog/PostHero";
import { PostMdx } from "@/components/blog/PostMdx";
import { PostCard } from "@/components/blog/PostCard";

/**
 * Individual blog post — HeadPinz. Internal /hp/blog/[slug]; public URL is
 * headpinz.com/blog/[slug] via the middleware /hp rewrite. Statically
 * generated at build time, so disk reads stay out of the request path.
 */

const HEADPINZ_LOGO =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logos/headpinz-logo-9aUwk9v1Z8LcHZP5chi50PnSbDWpSg.png";

export async function generateStaticParams() {
  return listPostSlugs("headpinz").map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(slug, "headpinz");
  if (!post) return { title: "Not found" };

  const url = `https://headpinz.com/blog/${post.meta.slug}`;
  const image = post.meta.ogImage ?? post.meta.heroImage;

  return {
    title: post.meta.title,
    description: post.meta.description,
    alternates: { canonical: url },
    keywords: post.meta.keywords ?? post.meta.tags,
    openGraph: {
      title: post.meta.title,
      description: post.meta.description,
      url,
      siteName: "HeadPinz",
      type: "article",
      publishedTime: post.meta.publishedAt,
      modifiedTime: post.meta.updatedAt ?? post.meta.publishedAt,
      authors: [post.meta.author],
      tags: post.meta.tags,
      images: [
        {
          url: image,
          width: 1200,
          height: 630,
          alt: post.meta.heroImageAlt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: post.meta.title,
      description: post.meta.description,
      images: [image],
    },
  };
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPostBySlug(slug, "headpinz");
  if (!post) notFound();

  const url = `https://headpinz.com/blog/${post.meta.slug}`;
  const related = getAllPosts("headpinz")
    .filter((p) => p.meta.slug !== post.meta.slug)
    .slice(0, 3);

  return (
    <article className="min-h-screen bg-[#0a1628] text-white">
      <ArticleJsonLd
        url={url}
        headline={post.meta.title}
        description={post.meta.description}
        image={post.meta.ogImage ?? post.meta.heroImage}
        datePublished={post.meta.publishedAt}
        dateModified={post.meta.updatedAt}
        authorName={post.meta.author}
        publisherName="HeadPinz"
        publisherLogo={HEADPINZ_LOGO}
      />
      <BreadcrumbJsonLd
        items={[
          { name: "HeadPinz", url: "https://headpinz.com" },
          { name: "Family Fun Guide", url: "https://headpinz.com/blog" },
          { name: post.meta.title, url },
        ]}
      />

      <PostHero
        title={post.meta.title}
        eyebrow={post.meta.eyebrow}
        publishedAt={post.meta.publishedAt}
        readMinutes={post.meta.readMinutes}
        author={post.meta.author}
        heroImage={post.meta.heroImage}
        heroImageAlt={post.meta.heroImageAlt}
      />

      <section style={{ padding: "20px clamp(16px, 4vw, 32px) 40px" }}>
        <div className="max-w-3xl mx-auto">
          <PostMdx source={post.body} />
        </div>
      </section>

      {/* Tags */}
      {post.meta.tags.length > 0 && (
        <section style={{ padding: "20px clamp(16px, 4vw, 32px) 20px" }}>
          <div className="max-w-3xl mx-auto flex flex-wrap gap-2">
            {post.meta.tags.map((tag) => (
              <span
                key={tag}
                className="font-body text-white/70 rounded-full"
                style={{
                  fontSize: "12px",
                  letterSpacing: "0.4px",
                  padding: "6px 14px",
                  border: "1px solid rgba(255,255,255,0.15)",
                  backgroundColor: "rgba(255,255,255,0.04)",
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* CTA */}
      <section
        style={{
          padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)",
          backgroundColor: "rgba(18,48,117,0.18)",
          marginTop: "40px",
        }}
        className="text-center"
      >
        <div className="max-w-2xl mx-auto">
          <h2
            className="font-heading font-black uppercase italic text-white"
            style={{
              fontSize: "clamp(28px, 5vw, 44px)",
              lineHeight: 1.05,
              letterSpacing: "-0.4px",
              marginBottom: "20px",
            }}
          >
            Plan Your Visit to HeadPinz Fort Myers
          </h2>
          <p
            className="font-body text-white/75 mx-auto"
            style={{ fontSize: "16px", lineHeight: 1.6, marginBottom: "32px", maxWidth: "42ch" }}
          >
            Book a lane, grab the squad for laser tag, or lock in a birthday party — we&apos;ll
            handle the fun.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href="/book/bowling?location=9172"
              className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105"
              style={{ backgroundColor: "#fd5b56", color: "#ffffff" }}
            >
              Book a lane
            </Link>
            <Link
              href="/fort-myers/attractions"
              className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105 text-white"
              style={{ border: "1px solid rgba(255,255,255,0.25)" }}
            >
              See all attractions
            </Link>
          </div>
        </div>
      </section>

      {related.length > 0 && (
        <section style={{ padding: "60px clamp(16px, 4vw, 32px)" }}>
          <div className="max-w-6xl mx-auto">
            <h2
              className="font-heading font-black uppercase italic text-white text-center"
              style={{
                fontSize: "clamp(22px, 4vw, 32px)",
                lineHeight: 1.05,
                letterSpacing: "-0.3px",
                marginBottom: "28px",
              }}
            >
              More from the guide
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {related.map((p) => (
                <PostCard key={p.meta.slug} meta={p.meta} basePath="/blog" />
              ))}
            </div>
          </div>
        </section>
      )}
    </article>
  );
}
