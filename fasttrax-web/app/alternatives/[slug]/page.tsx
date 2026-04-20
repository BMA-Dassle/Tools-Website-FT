import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AlternativePage } from "@/components/AlternativePage";
import { FT_ALTERNATIVES, listAlternatives } from "@/lib/alternatives-data";

/**
 * FastTrax alternative comparison landing pages.
 * URL:     /alternatives/{slug}
 * Source:  lib/alternatives-data.ts (FT_ALTERNATIVES registry)
 *
 * Intent: capture "[competitor] alternative Fort Myers" search queries.
 * Metadata and H1 consistently include "alternative" so Google never
 * misdirects direct brand queries here.
 */

export async function generateStaticParams() {
  return listAlternatives("ft").map((a) => ({ slug: a.slug }));
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const data = FT_ALTERNATIVES[slug];
  if (!data) return { title: "Not found" };

  const canonicalPath = `/alternatives/${data.slug}`;
  const canonicalUrl = `https://fasttraxent.com${canonicalPath}`;
  const title = `${data.competitor} Alternative in Fort Myers`;
  const description = data.intro.slice(0, 160);

  return {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${title} | FastTrax`,
      description,
      type: "article",
      url: canonicalUrl,
      siteName: "FastTrax Entertainment",
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | FastTrax`,
      description,
    },
    keywords: [
      data.searchTerm,
      `alternative to ${data.competitor}`,
      `${data.competitor} vs FastTrax`,
      `things to do Fort Myers`,
      `indoor entertainment Fort Myers`,
    ],
  };
}

export default async function FtAlternativeSlugPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const data = FT_ALTERNATIVES[slug];
  if (!data) notFound();

  const canonicalUrl = `https://fasttraxent.com/alternatives/${data.slug}`;
  return <AlternativePage data={data} canonicalUrl={canonicalUrl} />;
}
