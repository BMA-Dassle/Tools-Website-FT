import { headers } from "next/headers";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { RACER_PUBLIC_CODE_RE } from "~/features/kiosk/license/types";
import { resolveRacerHub } from "~/features/racing/service/racer-hub";
import { walletPlatformFromUserAgent } from "~/features/game-cards/wallet/platform";

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

  const badges = (
    [
      {
        platform: "apple",
        src: "/brand/wallet/apple-wallet-en.svg",
        w: 158,
        label: "Add to Apple Wallet",
      },
      {
        platform: "google",
        src: "/brand/wallet/google-wallet-en.svg",
        w: 181,
        label: "Add to Google Wallet",
      },
    ] as const
  ).filter((b) => !platform || b.platform === platform);

  return (
    <main className="min-h-screen bg-[#00041b] px-4 py-10 sm:py-14">
      <div className="mx-auto w-full max-w-md">
        <p className="font-display text-[11px] uppercase tracking-[0.25em] text-[#00E2E5] text-center">
          FastTrax Racing Licence
        </p>
        <h1
          className="mt-2 text-center text-3xl sm:text-4xl font-display uppercase tracking-widest text-white"
          style={{ textWrap: "balance" }}
        >
          {hub.fullName}
        </h1>

        <div className="mt-2 flex items-center justify-center gap-3 text-white/45 text-sm">
          {hub.tier && <span>{hub.tier}</span>}
          {hub.tier && <span aria-hidden="true">·</span>}
          <span>
            {hub.races} {hub.races === 1 ? "race" : "races"}
          </span>
        </div>

        {/* NEXT RACE — person-based, so it survives a heat move. Absent is a
            normal state (nothing booked), not an error worth apologising for. */}
        <div className="mt-7 rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-center">
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
            // Before the pre-race cron mints a ticket there is nothing to link
            // to — and nothing missing either, because the code below is what
            // check-in actually scans.
            <p className="mt-3 text-white/35 text-xs">
              Your e-ticket arrives about 2 hours before you race.
            </p>
          ) : null}
        </div>

        {/* THE LICENCE ITSELF. One code for the kiosk, the check-in desk and the
            register — proven live 2026-08-05. */}
        <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <p className="font-display text-[11px] uppercase tracking-[0.2em] text-white/40 text-center">
            Your licence
          </p>
          {qr && (
            <div className="mt-3 flex justify-center">
              <div className="rounded-xl bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- data URI, no loader */}
                <img src={qr} alt="" width={200} height={200} className="block" />
              </div>
            </div>
          )}
          <p className="mt-3 text-center text-white/45 text-xs leading-relaxed">
            Scan this to sign in at any kiosk, check into your race, or log in at the register.
          </p>
          <p className="mt-2 text-center font-mono text-white/25 text-[11px] tracking-wider">
            {hub.code}
          </p>
        </div>

        {/* Keep it, rather than reopening this page every visit. */}
        {badges.length > 0 && (
          <div className="mt-5">
            <p className="text-center text-white/45 text-xs mb-3">
              Keep it on your phone — it updates itself with your next race.
            </p>
            <div className="rounded-2xl bg-white p-4 flex flex-wrap items-center justify-center gap-3">
              {badges.map((b) => (
                <a key={b.platform} href={`/r/${encodeURIComponent(code)}/wallet?platform=${b.platform}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- vendor artwork must ship byte-for-byte */}
                  <img src={b.src} alt={b.label} width={b.w} height={50} />
                </a>
              ))}
            </div>
          </div>
        )}

        <p className="mt-8 text-center text-white/20 text-[11px]">
          14501 Global Parkway, Fort Myers, FL 33913
        </p>
      </div>
    </main>
  );
}
