"use client";

/**
 * The first-party mobile waiver flow (/waiver). Mounts the shared WaiverParty
 * (KioskPartyManager) in mobile theme with the guardian-signs-for-minor chain
 * ON — the kiosk players section, on a phone. Two modes:
 *
 *   Standalone (/waiver?c=)         — a guest adds their family and signs; the
 *                                     waiver is on file for their visit.
 *   Reservation-scoped (…&loc=&pid=) — signatures ATTACH to a specific BMI
 *                                     reservation (a group-event contract or a
 *                                     web booking), with a lean event-info header
 *                                     and a Text/Email/Copy/Share block so the
 *                                     organizer can forward the link to the whole
 *                                     party WITHOUT exposing the confirmation.
 *
 * Standalone brand comes from the host (x-brand); center from ?c=. Reservation
 * mode derives center + Pandora location from the authoritative locationId.
 */
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { IconCheck, IconChevronRight } from "@tabler/icons-react";
import type { Brand, CenterCode } from "~/features/booking/types";
import type { PartyMember } from "~/features/booking/state/types";
import { KioskPartyManager, peopleReady } from "~/features/kiosk/components/KioskPartyManager";
import { BrandLogo } from "~/features/kiosk/components/BrandLogo";
import { useReservationJoinAttach } from "./attach/reservation-join";
import { MobileWaiverPhoto } from "./MobileWaiverPhoto";

type PandoraLocation = "fasttrax" | "headpinz" | "naples";

/** Reservation mode: locationId is authoritative for center + Pandora location
 *  (467486 = FastTrax FM, 332160 = HeadPinz FM, 332145 = HeadPinz Naples). */
function locationInfo(locationId: number): { center: CenterCode; pandora: PandoraLocation } {
  if (locationId === 332145) return { center: "naples", pandora: "naples" };
  if (locationId === 332160) return { center: "fort-myers", pandora: "headpinz" };
  return { center: "fort-myers", pandora: "fasttrax" };
}

/** Standalone: center-first Pandora location (a Naples waiver records at Naples,
 *  never HP Fort Myers — the 2026-07-20 misroute class). */
function pandoraLocationFor(brand: Brand, center: CenterCode): PandoraLocation {
  if (center === "naples") return "naples";
  return brand === "headpinz" ? "headpinz" : "fasttrax";
}

function standaloneCenterName(brand: Brand, center: CenterCode): string {
  if (center === "naples") return "HeadPinz Naples";
  return brand === "headpinz" ? "HeadPinz Fort Myers" : "FastTrax Fort Myers";
}

interface WaiverContextSummary {
  label: string;
  activity: string | null;
  whenLabel: string;
  centerName: string;
  total: number;
}

/** Kiosk flow-head, phone scale: logo + activity label, then the signed-progress
 *  bar, then the k-display title — the same reading order as KioskFlow. */
function WaiverHead({
  brand,
  subtitle,
  signed,
  total,
}: {
  brand: Brand;
  subtitle: string;
  signed: number;
  total: number;
}) {
  return (
    <header className="mb-5">
      <div className="k-fh-top">
        <BrandLogo brand={brand} className="h-[36px] w-auto" alt={`${brandName(brand)} home`} />
        <span className="k-fh-activity">Waiver</span>
      </div>
      {total > 0 && (
        <>
          <div className="k-prog" role="presentation">
            {Array.from({ length: total }, (_, i) => (
              <span key={i} className={i < signed ? "done" : ""} />
            ))}
          </div>
          <div className="k-prog-label k-num" aria-live="polite">
            {signed} of {total} signed
          </div>
        </>
      )}
      <h1 className="k-display k-fh-title">Sign your waiver</h1>
      <p className="mt-1 text-sm text-[var(--k-dim)]">{subtitle}</p>
    </header>
  );
}

function brandName(brand: Brand): string {
  return brand === "headpinz" ? "HeadPinz" : "FastTrax";
}

export function WaiverFlow({
  brand,
  initialCenter,
  reservation,
}: {
  brand: Brand;
  initialCenter: CenterCode | null;
  reservation?: { locationId: number; projectId: string } | null;
}) {
  const resInfo = reservation ? locationInfo(reservation.locationId) : null;

  // Standalone: FastTrax host is Fort Myers; a HeadPinz visitor with no ?c picks
  // their center. Reservation mode derives center from locationId (below).
  const [standaloneCenter, setStandaloneCenter] = useState<CenterCode | null>(
    brand === "fasttrax" ? "fort-myers" : initialCenter,
  );
  const [party, setParty] = useState<PartyMember[]>([]);
  const [ctx, setCtx] = useState<WaiverContextSummary | null>(null);

  const center: CenterCode | null = resInfo ? resInfo.center : standaloneCenter;
  const location: PandoraLocation | null = resInfo
    ? resInfo.pandora
    : center
      ? pandoraLocationFor(brand, center)
      : null;

  // Reservation mode: fetch the lean, PII-safe event-info header.
  useEffect(() => {
    if (!reservation || !center) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/waiver/context?c=${center}&loc=${reservation.locationId}&pid=${reservation.projectId}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (!cancelled && res.ok && data.ok) setCtx(data as WaiverContextSummary);
      } catch {
        /* header is best-effort — the sign flow works without it */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reservation, center]);

  // Reservation mode: each member who reaches (person id + valid waiver) attaches
  // to the reservation — Neon persist-first, then the probe-gated BMI attach.
  useReservationJoinAttach({
    party,
    target: reservation ?? null,
    center,
    kioskId: null,
    enabled: !!reservation && !!center,
  });

  // `wp-mobile` scopes the kiosk look (tokens, k-* primitives, px re-proportioning)
  // to the whole page, not just the party manager — so the head, share block and
  // success card are the same design system as the kiosk, at phone scale. The deep
  // navy is the kiosk's --k-deep on BOTH brands, mirroring .kiosk-canvas.
  const shell = (children: ReactNode) => (
    <div
      className="wp-mobile min-h-screen bg-[#000418]"
      style={{ "--accent": "#00E2E5" } as CSSProperties}
    >
      <main className="wp-mobile-page mx-auto max-w-md px-4 pt-6">{children}</main>
    </div>
  );

  // Standalone HeadPinz visitor with no center yet — pick one (reservation mode
  // always resolves a center from locationId, so it never lands here).
  if (!center || !location) {
    return shell(
      <>
        <WaiverHead
          brand={brand}
          subtitle="Which location are you visiting?"
          signed={0}
          total={0}
        />
        <div className="space-y-3">
          {(
            [
              ["fort-myers", "HeadPinz Fort Myers"],
              ["naples", "HeadPinz Naples"],
            ] as const
          ).map(([code, label]) => (
            <button
              key={code}
              type="button"
              className="k-glass k-tap flex w-full items-center justify-between px-4 py-4 text-left"
              onClick={() => setStandaloneCenter(code)}
            >
              <span className="k-display text-lg">{label}</span>
              <IconChevronRight aria-hidden size={20} className="text-[var(--k-cyan)]" />
            </button>
          ))}
        </div>
      </>,
    );
  }

  const allIds = new Set(party.map((m) => m.id));
  const ready = party.length > 0 && peopleReady(party, Array.from(allIds)) === true;
  // Live signed count for the kiosk-style progress bar (kiosk shows step-of-N;
  // the waiver's real progress is how much of the party is done).
  const signedCount = party.filter((m) => m.waiverValid).length;

  return shell(
    <>
      <WaiverHead
        brand={brand}
        subtitle={
          reservation
            ? [ctx?.activity, ctx?.whenLabel, ctx?.centerName].filter(Boolean).join(" · ") ||
              "Loading reservation…"
            : standaloneCenterName(brand, center)
        }
        signed={signedCount}
        total={party.length}
      />

      {reservation && <EventInfoCard ctx={ctx} />}

      <KioskPartyManager
        mode="waiver"
        theme="mobile"
        guardianSigning
        hasCamera
        photoStep="required-adults"
        renderPhoto={(args) => <MobileWaiverPhoto {...args} />}
        party={party}
        brandLocation={location}
        center={center}
        includedIds={allIds}
        onIncludedChange={() => {}}
        onAddMember={(m) => setParty((p) => [...p, m])}
        onUpdateMember={(id, patch) =>
          setParty((p) => p.map((m) => (m.id === id ? { ...m, ...patch } : m)))
        }
        onRemoveMember={(id) => setParty((p) => p.filter((m) => m.id !== id))}
        onWaiverSigned={(info) => {
          // Best-effort E-SIGN audit row in our own DB (Pandora holds the
          // signature image; this is the persist-to-Neon record of acceptance).
          void fetch("/api/waiver/record", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              personId: info.personId,
              firstName: info.firstName,
              center,
              waiverId: info.waiverId,
              termsVersion: info.templateContentId,
              signedByPersonId: info.signerPersonId,
            }),
          }).catch(() => {});
        }}
      />

      {reservation && <ShareBlock label={ctx?.label ?? "your reservation"} />}

      {ready && (
        <div className="mt-6 rounded-[18px] border border-[var(--k-ok)]/40 bg-[var(--k-ok)]/10 p-4 text-center">
          <p className="k-display flex items-center justify-center gap-2 text-lg text-[var(--k-ok)]">
            <IconCheck aria-hidden size={20} stroke={3} />
            All waivers signed
          </p>
          <p className="mt-1 text-sm text-[var(--k-dim)]">
            {reservation
              ? "You're all set — these are saved to your reservation. Share the link above so the rest of your group can sign too."
              : "You're all set — we'll have these on file when you arrive. Add someone else above anytime."}
          </p>
        </div>
      )}
    </>,
  );
}

/** Lean event-info card — which reservation these signatures attach to. The
 *  activity/when/center line lives in the head subtitle, so this card carries the
 *  reservation identity + guest count only.
 *  Deliberately NO pricing / deposit / other guests' PII (see /api/waiver/context). */
function EventInfoCard({ ctx }: { ctx: WaiverContextSummary | null }) {
  return (
    <section className="k-glass mb-5 px-4 py-3">
      <div className="k-eyebrow">Signing for</div>
      <p className="k-display mt-1 text-base">{ctx?.label ?? "Your reservation"}</p>
      {!!ctx?.total && (
        <p className="k-num mt-1 text-xs text-[var(--k-dim)]">
          {ctx.total} {ctx.total === 1 ? "guest" : "guests"} on this reservation
        </p>
      )}
    </section>
  );
}

/** Forward the confirmation-free waiver link to the rest of the party. */
/** Client-only hydration flag (server snapshot false → client true) — lets us
 *  read window.location / navigator without a setState-in-effect or a hydration
 *  mismatch. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

function ShareBlock({ label }: { label: string }) {
  const hydrated = useHydrated();
  const [copied, setCopied] = useState(false);
  const url = hydrated ? window.location.href : "";
  const canNativeShare =
    hydrated && typeof navigator !== "undefined" && typeof navigator.share === "function";

  const subject = `Sign the waiver for ${label}`;
  const bodyText = `${subject}: ${url}`;

  const nativeShare = () => {
    void navigator.share({ title: subject, text: subject, url }).catch(() => {});
  };
  const copy = () => {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  // Two-up on anything wider than a small phone, single column below it — the
  // share actions are secondary, so they never crowd the signing flow.
  const shareBtn =
    "k-tap flex items-center justify-center rounded-full border-2 border-[var(--k-line)] px-3 text-center text-sm font-bold uppercase tracking-wide text-[var(--k-dim)]";

  return (
    <section className="k-glass mt-6 px-4 py-4">
      <div className="k-eyebrow">Share with your group</div>
      <p className="mt-2 text-xs text-[var(--k-dim)]">
        Anyone can sign from this link — it only shows the event, never your booking details.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <a href={`sms:?&body=${encodeURIComponent(bodyText)}`} className={shareBtn}>
          Text it
        </a>
        <a
          href={`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`}
          className={shareBtn}
        >
          Email it
        </a>
        <button type="button" onClick={copy} className={shareBtn}>
          {copied ? "Copied" : "Copy link"}
        </button>
        {canNativeShare && (
          <button type="button" onClick={nativeShare} className="k-btn-primary k-tap px-3">
            Share
          </button>
        )}
      </div>
    </section>
  );
}
