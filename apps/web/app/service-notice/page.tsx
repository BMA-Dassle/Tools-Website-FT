import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { IconAlertTriangle, IconArrowRight, IconPhone } from "@tabler/icons-react";
import { activeOutages, isProductPaused, outageForProduct } from "~/features/maintenance";

/**
 * Vendor-outage notice — `/service-notice`.
 *
 * Where the maintenance gate in middleware.ts sends every booking entry whose
 * vendor is down. One page for every blocked product: it names what the guest
 * came for, says why it can't be booked, answers "can I just call?" (no — the
 * front desk books through the same vendor), and then does the one useful thing
 * a wall can do: link the products that ARE still bookable, derived from the
 * same registry so it can never advertise something that is also down.
 *
 * Registered in middleware's `isSharedTopLevelRoute` (shared route ↔ middleware
 * pairing rule) so it serves on BOTH brand hosts; chrome/brand is host-aware.
 *
 * No outage active → redirect to the booking landing. A stale wall left up after
 * a vendor recovers costs more than the wall ever saved.
 */

export const metadata: Metadata = {
  title: "Booking temporarily unavailable",
  description: "One of our vendors is having a system outage. Please check back shortly.",
  // Never index an outage page — it outlives the outage in search results.
  robots: { index: false, follow: false },
};

/** Guest-facing name for the product the blocked URL was selling. */
const PRODUCT_LABEL: Record<string, string> = {
  race: "Racing",
  "race-pack": "Race Packs",
  "race-bowl": "the VIP Experience",
  "ultimate-qualifier": "the Ultimate Qualifier",
  "gel-blaster": "Nexus Gel Blaster",
  "laser-tag": "Nexus Laser Tag",
  shuffly: "Shuffle Showdown",
  "duck-pin": "Duckpin Bowling",
};

/**
 * Copy overrides for products the default "we can't book X" sentence doesn't fit.
 *
 * A waiver is not a purchase, so a guest signing one at home before a visit needs
 * a different reassurance: that they don't have to do anything before arriving.
 * Without that, "unavailable" reads as "your visit is blocked". Kept here rather
 * than in the registry because this is per-PRODUCT wording, while a registry
 * entry describes the INCIDENT.
 *
 * Only reachable while `waiver`'s vendor (bmi-office — the reservation/account
 * lookup both waiver flows start with) is down. Signing itself goes to Pandora.
 */
const PRODUCT_COPY: Record<string, { heading: string; body: string; note: string }> = {
  waiver: {
    heading: "We can’t start your waiver right now",
    body: "One of our vendors is having a system outage, so we can’t look up your reservation or your account to attach a waiver to. Nothing you’ve entered has been recorded.",
    note: "You don’t need to do anything before you arrive — you can sign in person when you get here, and our team at Guest Services can help. If you’d rather do it ahead of time, please check back a little later.",
  },
};

/** Everything we can still sell, in the order we'd offer it. Filtered against
 *  the registry so a second vendor going down silently removes its rows. */
const ALTERNATIVES: Array<{ product: string; name: string; blurb: string; href: string }> = [
  {
    product: "bowling",
    name: "Bowling",
    blurb: "Classic & VIP lanes at HeadPinz — Fort Myers and Naples.",
    href: "/book/bowling/v2",
  },
  {
    product: "duck-pin",
    name: "Duckpin Bowling",
    blurb: "Modern duckpin at FastTrax — smaller pins, lighter balls.",
    href: "/book/duck-pin/v2",
  },
  {
    product: "kbf",
    name: "Kids Bowl Free",
    blurb: "Free bowling for registered kids, Mon–Fri.",
    href: "/book/kbf/v2",
  },
  {
    product: "game-zone",
    name: "Game Zone",
    blurb: "Buy or reload an arcade card online — no waiting at the counter.",
    href: "/reload",
  },
];

export default async function ServiceNoticePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const outages = activeOutages();
  // Recovered (or someone typed the URL) → nothing to say. Send them to booking.
  if (outages.length === 0) redirect("/book/v2");

  const sp = await searchParams;
  const productParam = typeof sp.a === "string" ? sp.a : "";
  // Only trust the param when that product really is paused — otherwise the
  // notice would name an activity the guest can actually still book.
  const product = productParam && isProductPaused(productParam) ? productParam : "";
  const outage = (product ? outageForProduct(product) : null) ?? outages[0];
  const productLabel = product ? PRODUCT_LABEL[product] : "";
  const override = product ? PRODUCT_COPY[product] : undefined;
  const heading =
    override?.heading ??
    (productLabel ? `We can’t book ${productLabel} online right now` : outage.web.heading);
  const body = override?.body ?? outage.web.body;
  const note = override?.note ?? outage.web.phoneNote;

  const hdrs = await headers();
  const isHeadPinz = hdrs.get("x-brand") === "headpinz";
  const accent = isHeadPinz ? "#fd5b56" : "#00E2E5";
  const open = ALTERNATIVES.filter((a) => !isProductPaused(a.product));

  return (
    <div className={`${isHeadPinz ? "brand-headpinz" : "brand-fasttrax"} min-h-screen px-4 py-14`}>
      <div className="mx-auto max-w-2xl">
        <div
          className="rounded-2xl border p-6 sm:p-8"
          style={{ borderColor: "#f59e0b40", backgroundColor: "#f59e0b0f" }}
        >
          <div className="mb-4 flex items-center gap-3">
            <IconAlertTriangle size={26} stroke={2} color="#f59e0b" aria-hidden="true" />
            <span
              className="font-bold uppercase"
              style={{ color: "#f59e0b", fontSize: "12px", letterSpacing: "3px" }}
            >
              Temporary outage
            </span>
          </div>

          <h1
            className="font-display font-black uppercase italic text-white"
            style={{
              fontSize: "clamp(26px, 5vw, 42px)",
              lineHeight: 1.08,
              letterSpacing: "-0.5px",
            }}
          >
            {heading}
          </h1>

          <p
            className="font-body mt-4 text-white/75"
            style={{ fontSize: "16px", lineHeight: 1.65 }}
          >
            {body}
          </p>

          <div className="mt-5 flex items-start gap-3 rounded-xl border border-white/10 bg-black/25 px-4 py-3">
            <IconPhone
              size={20}
              stroke={2}
              className="mt-0.5 shrink-0 text-white/45"
              aria-hidden="true"
            />
            <p className="font-body text-sm text-white/65" style={{ lineHeight: 1.6 }}>
              {note}
            </p>
          </div>
        </div>

        {open.length > 0 && (
          <section className="mt-10">
            <h2
              className="mb-4 font-bold uppercase"
              style={{ color: accent, fontSize: "12px", letterSpacing: "3px" }}
            >
              Still bookable right now
            </h2>
            <div className="flex flex-col gap-3">
              {open.map((a) => (
                <Link
                  key={a.product}
                  href={a.href}
                  className="group flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4 transition-colors hover:border-white/25 hover:bg-white/[0.06]"
                >
                  <span className="min-w-0">
                    <span className="font-display block text-base font-black uppercase tracking-wider text-white">
                      {a.name}
                    </span>
                    <span className="font-body mt-0.5 block text-sm text-white/50">{a.blurb}</span>
                  </span>
                  <IconArrowRight
                    size={20}
                    stroke={2.5}
                    className="shrink-0 transition-transform group-hover:translate-x-0.5"
                    style={{ color: accent }}
                    aria-hidden="true"
                  />
                </Link>
              ))}
            </div>
          </section>
        )}

        <p className="mt-10 text-center text-sm text-white/40">
          Visiting today? Walk-ins are still welcome — our team at Guest Services can help in
          person.
        </p>
      </div>
    </div>
  );
}
