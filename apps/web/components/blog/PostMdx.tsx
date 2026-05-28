import Link from "next/link";
import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown renderer for blog post bodies.
 *
 * Posts use plain Markdown (no embedded React components yet), so we render
 * with react-markdown — RSC-native, React 19/Next 16 compatible. If we ever
 * need to embed components inside post bodies, swap this for an MDX pipeline
 * that compiles at build time (next-mdx-remote@6 + RSC was unstable as of
 * 2026-05 — its rendered tree triggered "React Element from..." at request
 * time on Vercel even when local builds passed).
 *
 * remark-gfm adds GitHub-flavored markdown (tables, strikethrough, autolinks,
 * task lists) so authors can write more expressive content without thinking
 * about the dialect.
 */

function Heading2({ children, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className="font-heading font-black uppercase italic text-white"
      style={{
        fontSize: "clamp(24px, 4.5vw, 38px)",
        lineHeight: 1.1,
        letterSpacing: "-0.4px",
        marginTop: "56px",
        marginBottom: "20px",
      }}
      {...props}
    >
      <span
        style={{
          display: "inline-block",
          borderBottom: "3px solid #fd5b56",
          paddingBottom: "6px",
        }}
      >
        {children}
      </span>
    </h2>
  );
}

function Heading3({ children, ...props }: ComponentProps<"h3">) {
  return (
    <h3
      className="font-heading font-bold uppercase text-white"
      style={{
        fontSize: "clamp(18px, 2.8vw, 22px)",
        lineHeight: 1.2,
        letterSpacing: "-0.2px",
        marginTop: "40px",
        marginBottom: "12px",
      }}
      {...props}
    >
      {children}
    </h3>
  );
}

function Paragraph(props: ComponentProps<"p">) {
  return (
    <p
      className="font-body text-white/85"
      style={{
        fontSize: "clamp(16px, 2vw, 18px)",
        lineHeight: 1.7,
        marginBottom: "20px",
      }}
      {...props}
    />
  );
}

function UnorderedList(props: ComponentProps<"ul">) {
  return (
    <ul
      className="font-body text-white/85"
      style={{
        fontSize: "clamp(16px, 2vw, 18px)",
        lineHeight: 1.7,
        marginBottom: "20px",
        paddingLeft: "1.25rem",
        listStyle: "disc",
      }}
      {...props}
    />
  );
}

function ListItem(props: ComponentProps<"li">) {
  return <li style={{ marginBottom: "8px" }} {...props} />;
}

function Blockquote({ children, ...props }: ComponentProps<"blockquote">) {
  return (
    <blockquote
      className="font-heading italic text-white"
      style={{
        fontSize: "clamp(20px, 3vw, 26px)",
        lineHeight: 1.4,
        margin: "40px 0",
        paddingLeft: "20px",
        borderLeft: "4px solid #fd5b56",
      }}
      {...props}
    >
      {children}
    </blockquote>
  );
}

function MdLink({ href = "", children }: ComponentProps<"a">) {
  const target = typeof href === "string" ? href : "";
  const isInternal = target.startsWith("/");
  const isAnchor = target.startsWith("#");
  if (isInternal && !isAnchor) {
    return (
      <Link
        href={target}
        style={{ color: "#fd5b56", textDecoration: "underline", textUnderlineOffset: "3px" }}
      >
        {children}
      </Link>
    );
  }
  return (
    <a
      href={target}
      style={{ color: "#fd5b56", textDecoration: "underline", textUnderlineOffset: "3px" }}
      target={isAnchor ? undefined : "_blank"}
      rel={isAnchor ? undefined : "noopener noreferrer"}
    >
      {children}
    </a>
  );
}

export function PostMdx({ source }: { source: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h2: Heading2,
        h3: Heading3,
        p: Paragraph,
        ul: UnorderedList,
        li: ListItem,
        blockquote: Blockquote,
        a: MdLink,
      }}
    >
      {source}
    </ReactMarkdown>
  );
}
