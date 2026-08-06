"use client";

import { useState } from "react";

import {
  walletPlatformFromUserAgent,
  type WalletPlatform,
} from "~/features/game-cards/wallet/platform";
import { useLicenceOffer, type OfferRacer } from "./useLicenceOffer";
import { WALLET_BADGES, BADGE_HEIGHT } from "~/features/game-cards/wallet/badges";

/**
 * The racing licence on the confirmation page — one QR per racer, all rendered.
 *
 * THIS IS THE CHECK-IN CODE, not a marketing offer, and the copy has to say so.
 * It replaced a grid labelled "Check-In QR", so anything vaguer than "scan this
 * to check into your race" loses the guest the thing they came here for. That
 * it is ALSO a permanent licence is the second sentence, never the first.
 *
 * EVERY RACER'S QR IS SHOWN, each one named — a row of unlabelled codes is how a
 * parent's licence ends up on a child's phone. Every racer also gets a wallet
 * badge: the badge adds to THIS phone, which is right both for the booker and
 * for a parent carrying their kids' passes.
 *
 * ── Adding is NOT instant, and the UI has to admit that ─────────────────────
 * A pass is ISSUED on the tap, and PassKit will not render a brand-new one for
 * tens of seconds — it answers 200 with its own landing page until it is ready,
 * and the first request appears to be what starts the render. A tap that just
 * navigates therefore hands the guest an un-installable file; live on
 * 2026-08-06 it downloaded a JSON error instead. So every add — the bundle and
 * each individual badge — polls until its pass is really renderable, and shows
 * that it is working.
 *
 * ONE LOCK ACROSS THE WHOLE CARD. While anything is preparing, everything else
 * is disabled: four taps would mean four issues racing each other and four
 * navigations fighting over the same page (owner 2026-08-06).
 *
 * NOTHING IS BILLED BY RENDERING THIS. A pass is created only when a racer taps
 * or scans. No login codes reach the browser: links are server-resolved hops
 * and every QR is rendered server-side.
 */
export default function LicenceOfferCard({ billId }: { billId: string }) {
  const racers = useLicenceOffer(billId);
  /** Which add is in flight — "all", a personId, or null. Card-wide on purpose. */
  const [busy, setBusy] = useState<string | null>(null);

  // Computed during render, not held in state: nothing paints until `racers`
  // resolves (client-only), so server and client both render null through
  // hydration and there is no mismatch to guard against.
  const platform: WalletPlatform | null =
    typeof navigator === "undefined" ? null : walletPlatformFromUserAgent(navigator.userAgent);

  const eligible = racers?.filter((r) => r.qr) ?? [];
  if (!racers || eligible.length === 0) return null;

  // Booker first — theirs is the phone in front of this page.
  const ordered = [...eligible].sort((a, b) => Number(b.isYou) - Number(a.isYou));

  return (
    <div className="mt-6 rounded-2xl border border-[#00E2E5]/30 bg-[#00E2E5]/[0.06] p-5">
      <p className="font-display text-[11px] uppercase tracking-[0.2em] text-[#00E2E5] mb-1.5">
        Race check-in · FastTrax Licence
      </p>
      <h3 className="text-white text-lg font-bold leading-snug mb-1">
        Scan this to check into your race
      </h3>
      <p className="text-white/55 text-sm mb-5 max-w-md leading-relaxed">
        It’s your FastTrax Racing Licence too — the same code signs you in at any kiosk and at the
        register, and it never expires. Add it to your phone’s wallet and it shows your next race
        automatically, instead of a text before every visit.
      </p>

      {/* Apple only: Google's multi-save needs several objects inside ONE
          issuer-signed JWT, and PassKit gives us a per-pass link with no way to
          merge them. Google users add each racer from their row. */}
      {platform === "apple" && eligible.length > 1 && (
        <AddButton
          billId={billId}
          label={`Add all ${eligible.length} to Apple Wallet`}
          busyLabel={(n) => `Preparing ${n > 0 ? `${n} of ${eligible.length}` : "passes"}…`}
          expected={eligible.length}
          isBusy={busy === "all"}
          locked={busy !== null && busy !== "all"}
          onStart={() => setBusy("all")}
          onDone={() => setBusy(null)}
          primary
        />
      )}

      <div className="flex flex-col divide-y divide-white/10">
        {ordered.map((r) => (
          <RacerQr
            key={r.personId}
            racer={r}
            platform={platform}
            billId={billId}
            isBusy={busy === r.personId}
            locked={busy !== null && busy !== r.personId}
            onStart={() => setBusy(r.personId)}
            onDone={() => setBusy(null)}
          />
        ))}
      </div>
    </div>
  );
}

function RacerQr({
  racer,
  platform,
  billId,
  isBusy,
  locked,
  onStart,
  onDone,
}: {
  racer: OfferRacer;
  platform: WalletPlatform | null;
  billId: string;
  isBusy: boolean;
  locked: boolean;
  onStart: () => void;
  onDone: () => void;
}) {
  // Desktop resolves to null, which means "we don't know" — NOT "neither".
  // Offer BOTH there, the way /v/{code} does: a desktop guest still wants the
  // pass on their phone, and PassKit's landing page hands them a QR to hop
  // across. Showing nothing was the bug — a booker on a laptop had no way to
  // add at all. Artwork comes from the shared WALLET_BADGES.
  const badges = WALLET_BADGES.filter((b) => !platform || b.platform === platform);

  return (
    <div className="py-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-white text-[15px] font-bold truncate">{racer.name}</span>
        {racer.isYou && (
          <span className="shrink-0 rounded-full border border-[#00E2E5]/45 px-2 py-[1px] text-[9px] font-extrabold uppercase tracking-[0.12em] text-[#00E2E5]">
            You
          </span>
        )}
      </div>

      <div className="flex items-start gap-4">
        <div className="rounded-xl bg-white p-2 shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URI, no loader */}
          <img src={racer.qr ?? ""} alt="" width={128} height={128} className="block" />
        </div>
        <p className="text-white/55 text-xs leading-relaxed min-w-0 flex-1">
          Scan at the check-in desk, any kiosk, or the register.
        </p>
      </div>

      {/* NO WHITE PLATE. Apple's badge is black with a #A6A6A6 hairline and
          Google's is #1F1F1F with its own outline, so both read straight onto
          this card; the white slab we used to mount them on looked like a
          foreign object stuck to the panel. */}
      {racer.addUrl && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {badges.map((b) => (
            <AddButton
              key={b.platform}
              billId={billId}
              personId={racer.personId}
              badge={b}
              platform={b.platform}
              expected={1}
              isBusy={isBusy}
              locked={locked}
              onStart={onStart}
              onDone={onDone}
              href={`${racer.addUrl}&platform=${b.platform}`}
            />
          ))}
        </div>
      )}

      {racer.hubUrl && (
        <a
          href={racer.hubUrl}
          // NEW TAB on purpose. /r/{code} renders without site chrome, so there
          // is no way back from it — and this page is the guest's booking
          // record, which they should not lose to open a licence.
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-block text-[#00E2E5] text-xs font-semibold"
        >
          {racer.isYou ? "View my page ›" : `Open ${racer.name.split(/\s+/)[0]}’s page ›`}
        </a>
      )}
    </div>
  );
}

/**
 * One add — the whole party or a single racer — with the wait made visible.
 *
 * Polls `?probe=1` until the pass (or every pass) is renderable, then navigates.
 * Each poll also NUDGES the render along, because asking is what starts it, so a
 * probe that answers "not yet" has still made progress.
 */
function AddButton({
  billId,
  personId,
  badge,
  platform,
  href,
  label,
  busyLabel,
  expected,
  isBusy,
  locked,
  onStart,
  onDone,
  primary = false,
}: {
  billId: string;
  personId?: string;
  badge?: (typeof WALLET_BADGES)[number];
  platform?: WalletPlatform;
  href?: string;
  label?: string;
  busyLabel?: (ready: number) => string;
  expected: number;
  isBusy: boolean;
  locked: boolean;
  onStart: () => void;
  onDone: () => void;
  primary?: boolean;
}) {
  const [ready, setReady] = useState(0);
  const [failed, setFailed] = useState(false);

  const probeUrl =
    `/api/racing/licence-offer/add-all?billId=${encodeURIComponent(billId)}&probe=1` +
    (personId ? `&personId=${encodeURIComponent(personId)}` : "");
  const target =
    href ?? `/api/racing/licence-offer/add-all?billId=${encodeURIComponent(billId)}`;

  const prepareUrl =
    `/api/racing/licence-offer/add-all?billId=${encodeURIComponent(billId)}&prepare=1` +
    (personId ? `&personId=${encodeURIComponent(personId)}` : "");

  async function start() {
    if (isBusy || locked) return;
    setFailed(false);
    setReady(0);
    onStart();

    // ISSUE ONCE, then only ever READ.
    //
    // Issuing is what must not repeat: a re-tap recovers the existing pass and
    // self-heals it with a `PUT metaData`, and a PUT makes PassKit RE-RENDER.
    // Polling an endpoint that issued therefore reset the render every three
    // seconds and spun forever — worst for racers who ALREADY had a pass, since
    // they take that path every time.
    try {
      await fetch(prepareUrl, { cache: "no-store" });
    } catch {
      // The passes may already exist; the probe below is the real check.
    }

    // ~2 minutes. Rendering a fresh party has taken well over a minute, and
    // giving up early is what produced the JSON download.
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const res = await fetch(probeUrl, { cache: "no-store" });
        if (res.ok) {
          const j = (await res.json()) as { total?: number; ready?: number };
          const got = Number(j.ready ?? 0);
          setReady(got);
          if (got > 0 && got >= Number(j.total ?? expected)) {
            window.location.href = target;
            return; // deliberately stays "busy" — we are leaving the page
          }
        }
      } catch {
        // a blip mid-render is not a failure
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Partial is still worth having — three good passes beat an error.
    if (ready > 0) {
      window.location.href = target;
      return;
    }
    setFailed(true);
    onDone();
  }

  if (failed) {
    return (
      <p className="text-[#f0b341] text-xs leading-relaxed">
        Still preparing — try again in a minute, or scan the code above.
      </p>
    );
  }

  const spinner = (
    <span
      className={`h-4 w-4 animate-spin rounded-full border-2 ${
        primary ? "border-[#04252b]/30 border-t-[#04252b]" : "border-white/30 border-t-white"
      }`}
      aria-hidden="true"
    />
  );

  if (primary) {
    return (
      <button
        type="button"
        onClick={start}
        disabled={isBusy || locked}
        aria-busy={isBusy}
        className="mb-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#00E2E5] px-5 py-3 text-[#04252b] text-sm font-bold disabled:opacity-60"
      >
        {isBusy ? (
          <>
            {spinner}
            {busyLabel?.(ready) ?? "Preparing…"}
          </>
        ) : (
          label
        )}
      </button>
    );
  }

  // Vendor badge. It stays a badge while idle — the artwork is the control —
  // and becomes a labelled progress state while it works.
  return (
    <button
      type="button"
      onClick={start}
      disabled={isBusy || locked}
      aria-busy={isBusy}
      aria-label={badge?.label}
      className="inline-flex items-center gap-2 disabled:opacity-40"
    >
      {isBusy ? (
        <span className="inline-flex items-center gap-2 rounded-lg border border-white/25 px-3 py-2 text-[11px] font-semibold text-white">
          {spinner}
          Preparing…
        </span>
      ) : (
        badge && (
          // eslint-disable-next-line @next/next/no-img-element -- vendor artwork must ship byte-for-byte
          <img
            src={badge.svg}
            alt={badge.label}
            width={badge.width}
            height={BADGE_HEIGHT}
            className="h-[50px] w-auto"
          />
        )
      )}
      {platform ? null : null}
    </button>
  );
}
