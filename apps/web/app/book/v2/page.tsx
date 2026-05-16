import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { DEFAULT_ACTIVITY_BY_BRAND, type Activity, type Brand } from "~/features/booking";

/**
 * Brand-aware activity chooser — v2 booking entry.
 *
 * FastTrax visitors see racing-first. HeadPinz visitors see bowling-first.
 * Each tile links to the per-activity /v2 route where the actual wizard
 * lives. Per-activity deep-link URLs (/book/race/v2 etc.) stay reachable
 * for SEO and marketing; this chooser is just the convenience entry point.
 *
 * PR-B1 ships the shell. KBF has its own route (/book/kbf/v2) and is also
 * surfaced here when the visitor is on HeadPinz.
 */

interface ActivityTile {
  activity: Activity;
  href: string;
  label: string;
  description: string;
  /** Only show on these brands. Omitted = show on all. */
  brands?: Brand[];
}

const TILES: ActivityTile[] = [
  {
    activity: "race",
    href: "/book/race/v2",
    label: "Go-kart racing",
    description: "Book a heat at FastTrax.",
    brands: ["fasttrax"],
  },
  {
    activity: "race-pack",
    href: "/book/race-pack/v2",
    label: "Race packages",
    description: "Multi-heat bundles (Rookie Pack, Ultimate Qualifier).",
    brands: ["fasttrax"],
  },
  {
    activity: "bowling",
    href: "/book/bowling/v2",
    label: "Bowling",
    description: "Reserve a lane at HeadPinz.",
    brands: ["headpinz"],
  },
  {
    activity: "kbf",
    href: "/book/kbf/v2",
    label: "Kids Bowl Free",
    description: "Free summer bowling for registered kids.",
    brands: ["headpinz"],
  },
  {
    activity: "attraction",
    href: "/book/gel-blaster/v2",
    label: "Gel blaster · Laser tag · Duck pin · Shuffly",
    description: "Pick an attraction to book.",
  },
];

export async function generateMetadata(): Promise<Metadata> {
  const hdrs = await headers();
  const isHeadPinz = hdrs.get("x-brand") === "headpinz";
  return {
    title: isHeadPinz ? "Book Online | HeadPinz" : "Book Online | FastTrax",
    description: isHeadPinz
      ? "Reserve bowling, KBF, attractions and more at HeadPinz Fort Myers & Naples."
      : "Reserve go-kart racing, packages, attractions and more at FastTrax Fort Myers.",
  };
}

export default async function BookV2ChooserPage() {
  const hdrs = await headers();
  const brand: Brand = hdrs.get("x-brand") === "headpinz" ? "headpinz" : "fasttrax";
  const preferred = DEFAULT_ACTIVITY_BY_BRAND[brand];

  // Show this brand's tiles first, then the cross-brand tiles. Tiles for
  // the OTHER brand are still reachable but rendered below as "more options."
  const primaryTiles = TILES.filter((t) => !t.brands || t.brands.includes(brand));
  const otherTiles = TILES.filter((t) => t.brands && !t.brands.includes(brand));

  return (
    <section className="mx-auto max-w-3xl p-6">
      <h1 className="text-3xl font-semibold">What would you like to book?</h1>
      <p className="mt-2 text-sm text-gray-600">
        v2 booking — preview surface. Existing booking stays at the non-/v2 URLs.
      </p>

      <ul className="mt-6 grid gap-3">
        {primaryTiles.map((t) => (
          <li key={t.activity}>
            <Link
              href={t.href}
              className={`block rounded-lg border p-4 transition hover:border-black ${
                t.activity === preferred ? "border-black bg-gray-50" : "border-gray-200"
              }`}
            >
              <div className="font-semibold">{t.label}</div>
              <div className="text-sm text-gray-500">{t.description}</div>
            </Link>
          </li>
        ))}
      </ul>

      {otherTiles.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-gray-400">
            More options
          </h2>
          <ul className="mt-2 grid gap-3">
            {otherTiles.map((t) => (
              <li key={t.activity}>
                <Link
                  href={t.href}
                  className="block rounded-lg border border-gray-200 p-4 transition hover:border-black"
                >
                  <div className="font-semibold">{t.label}</div>
                  <div className="text-sm text-gray-500">{t.description}</div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
