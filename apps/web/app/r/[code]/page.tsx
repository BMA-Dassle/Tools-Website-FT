import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { RACER_PUBLIC_CODE_RE } from "~/features/kiosk/license/types";
import { resolveRacerHub } from "~/features/racing/service/racer-hub";
import { walletPlatformFromUserAgent } from "~/features/game-cards/wallet/platform";
import { WALLET_BADGES, BADGE_HEIGHT } from "~/features/game-cards/wallet/badges";
import CopyCode from "~/features/racing/components/CopyCode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * `/r/{code}` — a racer's permanent page.
 *
 * THIS URL ALREADY EXISTED, AS A 404. Every licence we have issued carries
 * `licenceUrl: {brand}/r/{code}` on the back of the pass, and only the
 * `/wallet` child route was ever built — so tapping the link on your own pass
 * went nowhere. This is that page.
 *
 * It is the one racer surface that works at every moment: before a booking,
 * days ahead of a heat, and in the two hours when an e-ticket exists. That is
 * what removes the pressure to mint e-tickets early — the licence QR below is
 * scannable at the desk, the kiosk and the register right now, and it is
 * person-based, so a heat move cannot make it stale.
 *
 * SHAPE-CHECKED WITH THE PUBLIC REGEX, NOT THE SCAN ONE. Six-character tags are
 * real and look like counters; accepting them in a URL would make this an
 * enumerable racer directory. See RACER_PUBLIC_CODE_RE.
 */
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!RACER_PUBLIC_CODE_RE.test(String(code ?? "").trim())) return { title: "FastTrax" };
  const hub = await resolveRacerHub(code).catch(() => null);
  return {
    title: hub ? `${hub.fullName} — FastTrax Racing Licence` : "FastTrax Racing Licence",
    // A racer's schedule is not for crawlers.
    robots: { index: false, follow: false },
  };
}

export default async function RacerHubPage({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = String(raw ?? "").trim();

  // Failures land on the returning-racer sign-in rather than a dead end, the
  // same fallback `/r/{code}/wallet` uses.
  if (!RACER_PUBLIC_CODE_RE.test(code)) redirect("/book/race");
  const hub = await resolveRacerHub(code).catch(() => null);
  if (!hub) redirect(`/book/race?code=${encodeURIComponent(code)}`);

  const platform = walletPlatformFromUserAgent((await headers()).get("user-agent"));
  const qr = await QRCode.toDataURL(hub.memberQr, {
    width: 460,
    margin: 1,
    color: { dark: "#04252b", light: "#ffffff" },
  }).catch(() => null);

  // Shared artwork — see features/game-cards/wallet/badges.ts for why these are
  // never re-set by hand.
  const badges = WALLET_BADGES.filter((b) => !platform || b.platform === platform);

  return (
    // Generous top padding even without site chrome: this page suppresses the
    // Nav (it was covering the racer's NAME), so nothing else is holding the
    // header off the top of the viewport.
    <main className="min-h-screen bg-[#00041b] px-4 pb-14 pt-14 sm:pt-20">
      {/* Two columns from md up. A single 28rem column centred on a 1440px
          monitor was mostly empty space, and the QR — the one thing a guest
          holds up to a scanner — was the smallest element on the screen. */}
      <div className="mx-auto w-full max-w-md md:max-w-4xl">
        <header className="text-center md:text-left">
          <p className="font-display text-[11px] uppercase tracking-[0.25em] text-[#00E2E5]">
            FastTrax Racing Licence
          </p>
          <h1
            className="mt-2 text-3xl sm:text-4xl md:text-5xl font-display uppercase tracking-widest text-white break-words"
            style={{ textWrap: "balance" }}
          >
            {hub.fullName}
          </h1>
          <div className="mt-2 flex items-center justify-center md:justify-start gap-3 text-white/45 text-sm">
            {hub.tier && <span>{hub.tier}</span>}
            {hub.tier && <span aria-hidden="true">·</span>}
            <span>
              {hub.races} {hub.races === 1 ? "race" : "races"}
            </span>
          </div>
        </header>

        <div className="mt-7 grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
          {/* LEFT — the code. It is the reason the page exists, so on a wide
              screen it gets a column of its own rather than a slot in a stack. */}
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <p className="font-display text-[11px] uppercase tracking-[0.2em] text-white/40 text-center">
              Your licence
            </p>
            {qr && (
              <div className="mt-3 flex justify-center">
                <div className="rounded-xl bg-white p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element -- data URI, no loader */}
                  <img
                    src={qr}
                    alt=""
                    width={260}
                    height={260}
                    className="block h-auto w-full max-w-[260px]"
                  />
                </div>
              </div>
            )}
            <p className="mt-3 text-center text-white/45 text-xs leading-relaxed">
              Scan this to check into your race, sign in at any kiosk, or log in at the register.
            </p>
            <p className="mt-3 text-center text-white/30 text-[11px]">
              Licence code
              <span className="ml-1.5 font-mono tracking-wider text-white/55">{hub.code}</span>
            </p>
            <p className="mt-1 text-center text-white/25 text-[11px]">
              Read it out at the desk if a scanner is down.
            </p>
          </section>

          {/* RIGHT — everything about the race, plus keeping the pass. */}
          <div className="flex flex-col gap-5">
            <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-center md:text-left">
              <p className="font-display text-[11px] uppercase tracking-[0.2em] text-white/40">
                Next race
              </p>
              <p className="mt-1.5 text-white text-xl font-bold">
                {hub.nextRace?.label || "Nothing booked yet"}
              </p>

              {hub.ticketId ? (
                <a
                  href={`/t/${encodeURIComponent(hub.ticketId)}`}
                  className="mt-4 inline-block rounded-xl bg-[#00E2E5] px-5 py-2.5 text-[#04252b] text-sm font-bold"
                >
                  View my e-ticket
                </a>
              ) : hub.nextRace ? (
                // Before the pre-race cron mints a ticket there is nothing to
                // link to — and nothing missing either, because the code beside
                // this is what check-in actually scans.
                <p className="mt-3 text-white/35 text-xs">
                  Your e-ticket arrives about 2 hours before you race.
                </p>
              ) : (
                <Link
                  href="/book/race"
                  className="mt-4 inline-block rounded-xl border border-[#00E2E5]/50 px-5 py-2.5 text-[#00E2E5] text-sm font-bold"
                >
                  Book a race
                </Link>
              )}
            </section>

            {/* ACTIVITY BOX — the SMS-Timing racer app, where lap times and race
                history live. Same login code as the licence: one credential for
                the kiosk, the desk, the register and the app. Shown large and
                copyable because the app asks a racer to TYPE it, unlike
                everything else here, which scans it. */}
            <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <p className="font-display text-[11px] uppercase tracking-[0.2em] text-white/40">
                Activity Box
              </p>
              <p className="mt-1.5 text-white text-sm font-semibold">Check your race stats</p>
              <p className="mt-1 text-white/40 text-xs leading-relaxed">
                Lap times, race history and your ProSkill ranking. Sign in with the code below.
              </p>

              <div className="mt-3 rounded-xl border border-white/10 bg-black/25 px-3.5 py-3">
                <p className="text-white/35 text-[10px] uppercase tracking-[0.16em] mb-1.5">
                  Login code
                </p>
                <CopyCode code={hub.code} label="Copy your login code" />
              </div>

              <a
                href="https://smstim.in/headpinzftmyers"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block text-[#00E2E5] text-xs font-semibold"
              >
                Get the Activity Box app ›
              </a>
            </section>

            {badges.length > 0 && (
              <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <p className="text-center md:text-left text-white/55 text-sm font-semibold">
                  Keep it on your phone
                </p>
                <p className="mt-1 text-center md:text-left text-white/40 text-xs leading-relaxed">
                  Your next race appears on it automatically and updates itself if your heat moves —
                  no text needed.
                </p>
                {/* No white plate: Apple's badge is black with a #A6A6A6
                    hairline and Google's is #1F1F1F with its own outline, so
                    both read straight onto the card. A white slab behind them
                    looked like a foreign object stuck to the panel. */}
                <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
                  {badges.map((b) => (
                    <a
                      key={b.platform}
                      href={`/r/${encodeURIComponent(code)}/wallet?platform=${b.platform}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- vendor artwork must ship byte-for-byte */}
                      <img src={b.svg} alt={b.label} width={b.width} height={BADGE_HEIGHT} />
                    </a>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>

        <p className="mt-8 text-center text-white/20 text-[11px]">
          14501 Global Parkway, Fort Myers, FL 33913
        </p>
      </div>
    </main>
  );
}
