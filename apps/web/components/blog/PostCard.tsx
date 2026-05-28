import Link from "next/link";
import Image from "next/image";
import type { PostFrontmatter } from "@/lib/blog/posts";

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function PostCard({ meta, basePath }: { meta: PostFrontmatter; basePath: string }) {
  return (
    <Link
      href={`${basePath}/${meta.slug}`}
      className="rounded-2xl overflow-hidden transition-transform hover:scale-[1.01] block"
      style={{ backgroundColor: "#0f1d36", border: "1px solid rgba(255,255,255,0.08)" }}
    >
      <div style={{ aspectRatio: "16 / 9", position: "relative" }}>
        <Image
          src={meta.heroImage}
          alt={meta.heroImageAlt}
          fill
          sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 33vw"
          style={{ objectFit: "cover" }}
        />
      </div>
      <div style={{ padding: "24px" }}>
        {meta.eyebrow && (
          <div
            className="uppercase font-bold mb-3"
            style={{ color: "#fd5b56", fontSize: "11px", letterSpacing: "2px" }}
          >
            {meta.eyebrow}
          </div>
        )}
        <h2
          className="font-heading font-black uppercase text-white"
          style={{
            fontSize: "20px",
            lineHeight: 1.15,
            letterSpacing: "-0.3px",
            marginBottom: "12px",
          }}
        >
          {meta.title}
        </h2>
        <p
          className="font-body text-white/70"
          style={{
            fontSize: "14px",
            lineHeight: 1.6,
            marginBottom: "16px",
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: 3,
            overflow: "hidden",
          }}
        >
          {meta.description}
        </p>
        <div
          className="font-body text-white/55"
          style={{ fontSize: "12px", letterSpacing: "0.5px" }}
        >
          <time dateTime={meta.publishedAt}>{formatDate(meta.publishedAt)}</time>
          <span aria-hidden> · </span>
          <span>{meta.readMinutes} min read</span>
        </div>
      </div>
    </Link>
  );
}
