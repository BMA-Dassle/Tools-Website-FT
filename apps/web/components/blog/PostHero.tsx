import Image from "next/image";

interface PostHeroProps {
  title: string;
  eyebrow?: string;
  publishedAt: string;
  readMinutes: number;
  author: string;
  heroImage: string;
  heroImageAlt: string;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function PostHero({
  title,
  eyebrow,
  publishedAt,
  readMinutes,
  author,
  heroImage,
  heroImageAlt,
}: PostHeroProps) {
  return (
    <section style={{ padding: "clamp(80px, 14vw, 140px) clamp(16px, 4vw, 32px) 32px" }}>
      <div className="max-w-4xl mx-auto">
        {eyebrow && (
          <div
            className="uppercase font-bold mb-4"
            style={{ color: "#fd5b56", fontSize: "12px", letterSpacing: "3px" }}
          >
            {eyebrow}
          </div>
        )}
        <h1
          className="font-heading font-black uppercase italic text-white"
          style={{
            fontSize: "clamp(32px, 6.4vw, 60px)",
            lineHeight: 1.05,
            letterSpacing: "-0.8px",
            marginBottom: "20px",
          }}
        >
          {title}
        </h1>
        <div
          className="font-body text-white/65 flex flex-wrap items-center gap-x-4 gap-y-1"
          style={{ fontSize: "13px", letterSpacing: "0.5px" }}
        >
          <span>{author}</span>
          <span aria-hidden>·</span>
          <time dateTime={publishedAt}>{formatDate(publishedAt)}</time>
          <span aria-hidden>·</span>
          <span>{readMinutes} min read</span>
        </div>
      </div>

      <div
        className="max-w-5xl mx-auto"
        style={{
          marginTop: "40px",
          borderRadius: "24px",
          overflow: "hidden",
          aspectRatio: "16 / 9",
          position: "relative",
        }}
      >
        <Image
          src={heroImage}
          alt={heroImageAlt}
          fill
          priority
          sizes="(max-width: 1024px) 100vw, 1024px"
          style={{ objectFit: "cover" }}
        />
      </div>
    </section>
  );
}
