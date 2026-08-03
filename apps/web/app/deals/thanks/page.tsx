import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  IconCalendarEvent,
  IconCheck,
  IconDeviceGamepad2,
  IconMail,
  IconQrcode,
} from "@tabler/icons-react";
import { ATTRACTIONS } from "@/lib/attractions-data";
import { getVoucherStatus } from "~/features/game-cards/service/native-voucher";
import { voucherQrDataUri } from "~/features/game-cards/service/voucher-mail";
import {
  formatVoucherCode,
  isNativeVoucherCode,
  normalizeVoucherCode,
} from "~/features/game-cards/vouchers/codes";
import { formatVoucherExpiry, groupVoucherItems } from "~/features/game-cards/vouchers/display";
import { getDeal, isDealLocation, type DealLocationKey } from "~/features/deals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deal-pack confirmation — a REAL PAGE, not a panel state.
 *
 * The buy panel used to swap itself for a success view, which meant a refresh or
 * a back-tap lost the codes and left the buyer on a form for something they had
 * already paid for (owner 2026-08-03: "after you buy I feel like it should be a
 * separate page").
 *
 * IT IS DRIVEN BY THE CODES, NOT A PURCHASE ID. The codes are bearer instruments
 * already carried in URLs by convention (/v/{code}, the emailed links), so this
 * page needs no lookup token, exposes no buyer PII, survives a refresh, and can be
 * forwarded — which someone splitting packs will do anyway. A purchase id would be
 * enumerable and would leak what a stranger paid.
 *
 * Everything the buyer needs is HERE — the QR, the code, what is on it, and where
 * each half is redeemed — rather than one link away.
 */

export const metadata: Metadata = {
  title: "Your vouchers are ready",
  // Bearer codes in the URL: never index, never follow.
  robots: { index: false, follow: false },
};

type Search = { [key: string]: string | string[] | undefined };

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function DealThanksPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;

  // Same normalise → validate → dedupe → cap treatment the ?voucher= seed gets;
  // this value is equally attacker-controlled.
  const codes = Array.from(
    new Set(
      (first(sp.codes) ?? "")
        .split(",")
        .map((c) => normalizeVoucherCode(c))
        .filter((c) => isNativeVoucherCode(c)),
    ),
  ).slice(0, 10);
  if (codes.length === 0) notFound();

  const statuses = (await Promise.all(codes.map((c) => getVoucherStatus(c)))).filter(
    (s): s is NonNullable<typeof s> => !!s,
  );
  if (statuses.length === 0) notFound();

  const qrs = await Promise.all(statuses.map((s) => voucherQrDataUri(s.code)));

  const deal = getDeal(first(sp.deal) ?? "");
  const rawLoc = first(sp.location);
  const location: DealLocationKey | null = rawLoc && isDealLocation(rawLoc) ? rawLoc : null;
  const attraction = deal ? ATTRACTIONS[deal.scheduleSlug] : null;
  const accent = attraction?.color ?? "#fd5b56";

  /** Book-your-time link, carrying every code so all admissions get covered. */
  const bookUrl =
    deal && attraction
      ? `/book/${deal.scheduleSlug}/v2?${new URLSearchParams({
          location: location === "naples" ? "naples" : "fort-myers",
          voucher: statuses.map((s) => s.code).join(","),
        }).toString()}`
      : null;

  const expiry = formatVoucherExpiry(statuses[0]?.expiresAt ?? null);
  const many = statuses.length > 1;

  return (
    <div className="min-h-screen bg-[#00041b]">
      <main className="mx-auto max-w-md px-5 pt-32 pb-20 text-white sm:pt-36 lg:max-w-5xl lg:pt-40">
        <div className="flex items-center gap-3">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
            style={{ background: accent, color: "#00041b" }}
          >
            <IconCheck size={24} stroke={3} />
          </span>
          <div>
            <h1 className="font-display text-3xl text-white sm:text-4xl">You&apos;re all set</h1>
            <p className="text-sm text-white/60">
              {deal ? `${deal.name} — ` : ""}
              {many ? `${statuses.length} vouchers are` : "your voucher is"} ready, and we&apos;ve
              emailed {many ? "them" : "it"} to you.
            </p>
          </div>
        </div>

        <div className="mt-10 lg:grid lg:grid-cols-2 lg:items-start lg:gap-12">
          {/* ── The vouchers themselves ─────────────────────────────── */}
          <div className="space-y-6">
            {statuses.map((status, i) => {
              const groups = groupVoucherItems(status.items);
              return (
                <div
                  key={status.code}
                  className="rounded-2xl border border-white/12 bg-white/[0.04] p-5"
                >
                  {qrs[i] && (
                    /* eslint-disable-next-line @next/next/no-img-element -- data URI, no loader */
                    <img
                      src={qrs[i] as string}
                      alt={`QR code for voucher ${formatVoucherCode(status.code)}`}
                      className="mx-auto h-44 w-44 rounded-xl bg-white p-2"
                    />
                  )}
                  <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 text-center font-mono text-xl tracking-[0.12em] text-white">
                    {formatVoucherCode(status.code)}
                  </p>
                  <ul className="mt-4 space-y-1.5">
                    {groups.map((g) => (
                      <li
                        key={`${g.label}-${g.indexes[0]}`}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <span className={g.spent > 0 ? "text-white/35 line-through" : "text-white"}>
                          {g.total > 1 ? `${g.total} × ` : ""}
                          {g.label}
                        </span>
                        <span className="shrink-0 text-xs text-white/45">
                          {g.spent > 0 ? "used" : g.route === "gamezone" ? "kiosk" : "book a time"}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href={`/v/${status.code}`}
                    className="mt-4 block text-center text-xs text-white/50 underline-offset-2 hover:text-white hover:underline"
                  >
                    Open this voucher&apos;s own page
                  </Link>
                </div>
              );
            })}
          </div>

          {/* ── What to do with it ──────────────────────────────────── */}
          <div className="mt-8 space-y-5 lg:mt-0">
            {bookUrl && (
              <a
                href={bookUrl}
                className="block rounded-full px-6 py-4 text-center text-sm font-bold tracking-widest uppercase transition hover:brightness-110"
                style={{ background: accent, color: "#00041b" }}
              >
                Book your {attraction?.shortName.toLowerCase() ?? "session"} time
              </a>
            )}

            <div className="space-y-4 rounded-2xl border border-white/12 bg-white/[0.03] p-5">
              <h2 className="text-xs font-bold tracking-widest text-white/45 uppercase">
                How to use it
              </h2>

              <div className="flex gap-3">
                <IconDeviceGamepad2
                  size={20}
                  className="mt-0.5 shrink-0"
                  style={{ color: accent }}
                />
                <p className="text-sm text-white/70">
                  <span className="font-semibold text-white">Game cards — at a kiosk.</span> Scan
                  the QR at any HeadPinz kiosk and it prints your cards with the credit already on
                  them. Look for &ldquo;Coupon or voucher?&rdquo; on the welcome screen. Already
                  have a HeadPinz card? Open the voucher page and load it straight on instead.
                </p>
              </div>

              {attraction && (
                <div className="flex gap-3">
                  <IconCalendarEvent
                    size={20}
                    className="mt-0.5 shrink-0"
                    style={{ color: accent }}
                  />
                  <p className="text-sm text-white/70">
                    <span className="font-semibold text-white">
                      {attraction.shortName} — book a time, online or at a kiosk.
                    </span>{" "}
                    {attraction.shortName} runs as a timed session, so pick a slot rather than
                    turning up. Use the button above, or scan your QR at a kiosk when you arrive.
                    Your code is applied at checkout — there&apos;s nothing more to pay.
                  </p>
                </div>
              )}

              <div className="flex gap-3">
                <IconQrcode size={20} className="mt-0.5 shrink-0" style={{ color: accent }} />
                <p className="text-sm text-white/70">
                  <span className="font-semibold text-white">Use it in pieces.</span> Every item is
                  redeemed separately, so you can take a game card today and come back for the rest.
                  Whatever you haven&apos;t used stays on the code
                  {many ? " — and each code works on its own, so you can pass one on." : "."}
                </p>
              </div>

              <div className="flex gap-3">
                <IconMail size={20} className="mt-0.5 shrink-0" style={{ color: accent }} />
                <p className="text-sm text-white/70">
                  <span className="font-semibold text-white">It&apos;s in your inbox too.</span> No
                  need to keep this page — the same QR and code were emailed to you
                  {expiry ? `, and everything is valid through ${expiry}` : ""}.
                </p>
              </div>

              <p className="border-t border-white/10 pt-4 text-xs text-white/40">
                Redeem at a kiosk, not the front desk — Guest Services can&apos;t print cards or
                apply voucher codes.
              </p>
            </div>

            <div className="flex flex-wrap gap-4 text-sm">
              <Link href="/deals" className="text-white/55 hover:text-white">
                See the other deal →
              </Link>
              <Link
                href={location === "naples" ? "/naples/attractions" : "/fort-myers/attractions"}
                className="text-white/55 hover:text-white"
              >
                Everything else at this location →
              </Link>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
