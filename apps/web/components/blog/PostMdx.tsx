import { MDXRemote } from "next-mdx-remote/rsc";
import Link from "next/link";
import type { ComponentProps } from "react";

/**
 * MDX component overrides for blog post bodies.
 *
 * Two things this map fixes that default MDX rendering doesn't:
 * 1. Links — convert relative MDX hrefs to next/link so they prefetch and
 *    don't full-page-reload (`[Kids Bowl Free](/kids-bowl-free)` → <Link>).
 * 2. Typography — match the HP visual system (Outfit headings, DM Sans body,
 *    coral H2 underline, navy bg). Pulled inline so a marketing edit to the
 *    MDX never needs a separate CSS file touch.
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

function MdxLink({ href = "", children, ...props }: ComponentProps<"a">) {
  const isInternal = href.startsWith("/");
  const isAnchor = href.startsWith("#");
  if (isInternal && !isAnchor) {
    return (
      <Link
        href={href}
        style={{ color: "#fd5b56", textDecoration: "underline", textUnderlineOffset: "3px" }}
      >
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href}
      style={{ color: "#fd5b56", textDecoration: "underline", textUnderlineOffset: "3px" }}
      target={isAnchor ? undefined : "_blank"}
      rel={isAnchor ? undefined : "noopener noreferrer"}
      {...props}
    >
      {children}
    </a>
  );
}

const components = {
  h2: Heading2,
  h3: Heading3,
  p: Paragraph,
  ul: UnorderedList,
  li: ListItem,
  blockquote: Blockquote,
  a: MdxLink,
};

export function PostMdx({ source }: { source: string }) {
  return <MDXRemote source={source} components={components} />;
}
