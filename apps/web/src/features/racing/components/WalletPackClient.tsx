"use client";

import { useEffect, useRef, useState } from "react";
import {
  walletPlatformFromUserAgent,
  type WalletPlatform,
} from "~/features/game-cards/wallet/platform";
import { useLicenceOffer } from "./useLicenceOffer";
import { WALLET_BADGES, BADGE_HEIGHT } from "~/features/game-cards/wallet/badges";
import { BrandedLoader } from "~/features/kiosk/components/BrandedLoader";

/**
 * The branded loader's keyframes live in `app/kiosk/kiosk.css`, which only
 * loads on kiosk routes — so a web page using the same loader has to bring
 * them. Copied verbatim rather than importing the whole kiosk stylesheet, and
 * the reduced-motion guard comes with them: the arc is decoration, and someone
 * who asked the OS for less movement should not get a spinning ring.
 */
const LOADER_KEYFRAMES = `
@keyframes kiosk-orbit { to { transform: rotate(360deg); } }
.kiosk-orbit { animation: kiosk-orbit 1.2s linear infinite; }
@keyframes kiosk-breathe {
  0%, 100% { transform: scale(0.92); opacity: 0.7; }
  50% { transform: scale(1.08); opacity: 1; }
}
.kiosk-breathe { animation: kiosk-breathe 2.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .kiosk-orbit, .kiosk-breathe { animation: none; }
}
`;

/**
 * `/passes/{billId}` — the kiosk QR's destination. One job: put this booking's
 * licences on the phone that just scanned.
 *
 * WHY NOT THE CONFIRMATION PAGE. That was the first target and it is the wrong
 * one: a guest who scans a kiosk code to get their passes lands on a long
 * booking page and has to find a card partway down it. This starts working the
 * moment it opens.
 *
 * APPLE STARTS AUTOMATICALLY. The bundle is a `.pkpasses` download, so there is
 * nothing to decide — prepare, wait for the passes to be renderable, hand the
 * file to Wallet. Everything the guest has to do happens in iOS's own sheet.
 *
 * ANDROID GETS BADGES, because Google's multi-save needs several objects inside
 * ONE issuer-signed JWT and PassKit hands us a per-pass link with no way to
 * merge them. Same reason the confirmation card offers Google per racer.
 *
 * Nothing is billed by opening this — the passes are issued by the prepare step,
 * which only runs because someone deliberately scanned the code.
 */
export default function WalletPackClient({
  billId,
  personId,
}: {
  billId: string;
  /** One racer only. The kiosk's per-racer QRs land here so a single add gets
   *  the same prepare-and-wait flow as the bundle — a bare redirect to the pass
   *  URL hands the guest an un-rendered pass. */
  personId?: string;
}) {
  const racers = useLicenceOffer(billId);
  const [platform, setPlatform] = useState<WalletPlatform | null | "unknown">("unknown");
  const [ready, setReady] = useState(0);
  const [phase, setPhase] = useState<"working" | "sent" | "failed">("working");
  const started = useRef(false);

  useEffect(() => {
    setPlatform(walletPlatformFromUserAgent(navigator.userAgent));
  }, []);

  const all = racers?.filter((r) => r.qr) ?? [];
  const eligible = personId ? all.filter((r) => r.personId === personId) : all;
  const total = eligible.length;

  useEffect(() => {
    if (platform !== "apple" || total === 0 || started.current) return;
    started.current = true;

    const base =
      `/api/racing/licence-offer/add-all?billId=${encodeURIComponent(billId)}` +
      (personId ? `&personId=${encodeURIComponent(personId)}` : "");
    let cancelled = false;

    (async () => {
      // Issue ONCE. Re-issuing an existing pass triggers a metaData PUT, which
      // makes PassKit re-render it — polling an endpoint that issues destroys
      // the render it is waiting for.
      try {
        await fetch(`${base}&prepare=1`, { cache: "no-store" });
      } catch {
        /* they may already exist; the probe below is the real check */
      }

      for (let i = 0; i < 40 && !cancelled; i++) {
        try {
          const res = await fetch(`${base}&probe=1`, { cache: "no-store" });
          if (res.ok) {
            const j = (await res.json()) as { total?: number; ready?: number };
            const got = Number(j.ready ?? 0);
            setReady(got);
            if (got > 0 && got >= Number(j.total ?? total)) {
              window.location.href = base;
              setTimeout(() => setPhase("sent"), 2000);
              return;
            }
          }
        } catch {
          /* a blip mid-render is not a failure */
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!cancelled) setPhase("failed");
    })();

    return () => {
      cancelled = true;
    };
  }, [platform, total, billId, personId]);

  const badges = WALLET_BADGES.filter((b) => !platform || platform === "unknown" || b.platform === platform);

  return (
    <main className="min-h-screen bg-[#00041b] px-5 py-14 flex flex-col items-center justify-center">
      <style>{LOADER_KEYFRAMES}</style>
      <div className="w-full max-w-md text-center">
        {racers === null ? (
          <Spinner caption="Finding your licences…" />
        ) : total === 0 ? (
          <p className="mt-10 text-white/60 text-sm leading-relaxed">
            No racing licences on this booking yet. A licence is created the first time you race.
          </p>
        ) : platform === "apple" ? (
          phase === "working" ? (
            <Spinner
              caption={
                total === 1
                  ? `Preparing ${eligible[0]?.name ?? "your"}'s licence…`
                  : ready > 0
                    ? `Preparing ${ready} of ${total} passes…`
                    : `Preparing ${total} passes…`
              }
            />
          ) : phase === "sent" ? (
            <Done total={total} onRetry={() => window.location.reload()} />
          ) : (
            <Failed onRetry={() => window.location.reload()} />
          )
        ) : (
          // Android and desktop: one badge per racer, named.
          <div className="mt-10 text-left">
            <h1 className="font-display text-2xl uppercase tracking-widest text-white text-center">
              Your licences
            </h1>
            <p className="mt-2 text-white/50 text-sm text-center">
              Add each racer&rsquo;s licence to this phone.
            </p>
            <div className="mt-6 flex flex-col divide-y divide-white/10">
              {eligible.map((r) => (
                <div key={r.personId} className="py-4">
                  <p className="text-white text-[15px] font-bold mb-2.5">{r.name}</p>
                  <div className="flex flex-wrap gap-3">
                    {badges.map((b) =>
                      r.addUrl ? (
                        <a key={b.platform} href={`${r.addUrl}&platform=${b.platform}`}>
                          {/* eslint-disable-next-line @next/next/no-img-element -- vendor artwork must ship byte-for-byte */}
                          <img
                            src={b.svg}
                            alt={b.label}
                            width={b.width}
                            height={BADGE_HEIGHT}
                            className="h-[50px] w-auto"
                          />
                        </a>
                      ) : null,
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

/** The kiosk's own loader, so a guest who just scanned a kiosk screen sees the
 *  same thing continue on their phone. */
function Spinner({ caption }: { caption: string }) {
  return (
    <BrandedLoader
      size={240}
      label={caption}
      sublabel="Keep this page open — your passes will open in Wallet automatically."
    />
  );
}

function Done({ total, onRetry }: { total: number; onRetry: () => void }) {
  return (
    <div className="mt-12 flex flex-col items-center gap-4">
      <span className="grid h-14 w-14 place-items-center rounded-full border-4 border-[#46d68c] text-2xl text-[#46d68c]">
        ✓
      </span>
      <p className="text-white text-lg font-bold">
        {total} {total === 1 ? "licence" : "licences"} sent to Wallet
      </p>
      <p className="text-white/40 text-xs max-w-[30ch] leading-relaxed">
        If Wallet didn&rsquo;t open, tap below to try again.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 rounded-xl border border-white/25 px-5 py-2.5 text-sm font-semibold text-white"
      >
        Send again
      </button>
    </div>
  );
}

function Failed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mt-12 flex flex-col items-center gap-4">
      <p className="text-[#f0b341] text-sm leading-relaxed max-w-[32ch]">
        Your passes are still being prepared. Give it a minute and try again.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-xl bg-[#00E2E5] px-5 py-2.5 text-sm font-bold text-[#04252b]"
      >
        Try again
      </button>
    </div>
  );
}
