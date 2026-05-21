import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

/**
 * Filesystem-backed blog post loader.
 *
 * Posts live as MDX under `apps/web/content/blog/`. Frontmatter is parsed with
 * gray-matter at build time (or on-demand in dev). Pages stay server-rendered
 * and statically generated via `generateStaticParams`, so disk reads only
 * happen during the build — no per-request fs hit in production.
 *
 * Why typed frontmatter (vs. `Record<string, unknown>` everywhere):
 * - the metadata is the contract the listing page, [slug] page, JSON-LD, and
 *   sitemap all consume. A typed loader is the only place that needs to
 *   know the shape; everything downstream just reads the props.
 */

export type Brand = "headpinz" | "fasttrax";

export interface PostFrontmatter {
  slug: string;
  title: string;
  description: string;
  eyebrow?: string;
  publishedAt: string;
  updatedAt?: string;
  readMinutes: number;
  heroImage: string;
  heroImageAlt: string;
  ogImage?: string;
  author: string;
  brand: Brand;
  location?: string;
  tags: string[];
  keywords?: string[];
}

export interface BlogPost {
  meta: PostFrontmatter;
  body: string;
}

const POSTS_DIR = path.join(process.cwd(), "content", "blog");

function ensureString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Blog post frontmatter is missing required string field "${field}"`);
  }
  return v;
}

function ensureNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`Blog post frontmatter is missing required number field "${field}"`);
  }
  return v;
}

function ensureStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`Blog post frontmatter field "${field}" must be a string[]`);
  }
  return v as string[];
}

function ensureBrand(v: unknown): Brand {
  if (v === "headpinz" || v === "fasttrax") return v;
  throw new Error(
    `Blog post frontmatter "brand" must be "headpinz" or "fasttrax", got: ${String(v)}`,
  );
}

function parseFrontmatter(slugFromFile: string, raw: Record<string, unknown>): PostFrontmatter {
  return {
    slug: ensureString(raw.slug ?? slugFromFile, "slug"),
    title: ensureString(raw.title, "title"),
    description: ensureString(raw.description, "description"),
    eyebrow: typeof raw.eyebrow === "string" ? raw.eyebrow : undefined,
    publishedAt: ensureString(raw.publishedAt, "publishedAt"),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    readMinutes: ensureNumber(raw.readMinutes, "readMinutes"),
    heroImage: ensureString(raw.heroImage, "heroImage"),
    heroImageAlt: ensureString(raw.heroImageAlt, "heroImageAlt"),
    ogImage: typeof raw.ogImage === "string" ? raw.ogImage : undefined,
    author: ensureString(raw.author, "author"),
    brand: ensureBrand(raw.brand),
    location: typeof raw.location === "string" ? raw.location : undefined,
    tags: ensureStringArray(raw.tags, "tags"),
    keywords: raw.keywords === undefined ? undefined : ensureStringArray(raw.keywords, "keywords"),
  };
}

function listFiles(): string[] {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith(".mdx"));
}

export function getAllPosts(brand?: Brand): BlogPost[] {
  const posts = listFiles().map((file) => {
    const slugFromFile = file.replace(/\.mdx$/, "");
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), "utf8");
    const parsed = matter(raw);
    return {
      meta: parseFrontmatter(slugFromFile, parsed.data as Record<string, unknown>),
      body: parsed.content,
    };
  });
  const filtered = brand ? posts.filter((p) => p.meta.brand === brand) : posts;
  // Newest first.
  return filtered.sort((a, b) => b.meta.publishedAt.localeCompare(a.meta.publishedAt));
}

export function getPostBySlug(slug: string, brand?: Brand): BlogPost | null {
  const file = path.join(POSTS_DIR, `${slug}.mdx`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  const parsed = matter(raw);
  const meta = parseFrontmatter(slug, parsed.data as Record<string, unknown>);
  if (brand && meta.brand !== brand) return null;
  return { meta, body: parsed.content };
}

export function listPostSlugs(brand?: Brand): string[] {
  return getAllPosts(brand).map((p) => p.meta.slug);
}
