import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AlternativePage } from "@/components/AlternativePage";
import { HP_ALTERNATIVES, listAlternatives } from "@/lib/alternatives-data";

/**
 * HeadPinz alternative comparison landing pages.
 * Internal URL:     /hp/alternatives/{slug} (dev + server routing)
 * Public URL:       https://headpinz.com/alternatives/{slug}
 *                   (middleware rewrites /alternatives/* → /hp/alternatives/*)
 */

export async function generateStaticParams() {
  return listAlternatives("hp").map((a) => ({ slug: a.slug }));
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const data = HP_ALTERNATIVES[slug];
  if (!data) return { title: "Not found" };

  const canonicalUrl = `https://headpinz.com/alternatives/${data.slug}`;
  const title = `${data.competitor} Alternative in Southwest Florida`;
  const description = data.intro.slice(0, 160);

  return {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${title} | HeadPinz`,
      description,
      type: "article",
      url: canonicalUrl,
      siteName: "HeadPinz",
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | HeadPinz`,
      description,
    },
    keywords: [
      data.searchTerm,
      `alternative to ${data.competitor}`,
      `${data.competitor} vs HeadPinz`,
      `bowling Fort Myers`,
      `bowling Naples`,
      `family entertainment Southwest Florida`,
    ],
  };
}

export default async function HpAlternativeSlugPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const data = HP_ALTERNATIVES[slug];
  if (!data) notFound();

  const canonicalUrl = `https://headpinz.com/alternatives/${data.slug}`;
  return <AlternativePage data={data} canonicalUrl={canonicalUrl} />;
}
