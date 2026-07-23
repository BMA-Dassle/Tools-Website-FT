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
import type { Brand, CenterCode } from "~/features/booking/types";
import type { PartyMember } from "~/features/booking/state/types";
import { KioskPartyManager, peopleReady } from "~/features/kiosk/components/KioskPartyManager";
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

const outlineBtn =
  "w-full rounded-xl border border-white/25 px-4 py-3 text-base font-bold text-white";

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

  const shell = (children: ReactNode) => (
    <div
      className={`min-h-screen text-white ${
        brand === "headpinz" ? "brand-headpinz bg-[#0a1628]" : "bg-[#000418]"
      }`}
      style={{ "--accent": "#00E2E5" } as CSSProperties}
    >
      <main className="mx-auto max-w-md px-4 py-8">{children}</main>
    </div>
  );

  // Standalone HeadPinz visitor with no center yet — pick one (reservation mode
  // always resolves a center from locationId, so it never lands here).
  if (!center || !location) {
    return shell(
      <div className="space-y-4">
        <header className="mb-2 text-center">
          <div className="text-xs font-black uppercase tracking-[0.3em] text-white/40">
            HeadPinz
          </div>
          <h1 className="mt-2 text-2xl font-extrabold">Sign your waiver</h1>
          <p className="mt-1 text-sm text-white/50">Which location are you visiting?</p>
        </header>
        <button
          type="button"
          className={outlineBtn}
          onClick={() => setStandaloneCenter("fort-myers")}
        >
          HeadPinz Fort Myers
        </button>
        <button type="button" className={outlineBtn} onClick={() => setStandaloneCenter("naples")}>
          HeadPinz Naples
        </button>
      </div>,
    );
  }

  const allIds = new Set(party.map((m) => m.id));
  const ready = party.length > 0 && peopleReady(party, Array.from(allIds)) === true;

  return shell(
    <>
      {reservation ? (
        <EventInfoHeader ctx={ctx} />
      ) : (
        <header className="mb-6 text-center">
          <div className="text-xs font-black uppercase tracking-[0.3em] text-white/40">
            {brand === "headpinz" ? "HeadPinz" : "FastTrax"}
          </div>
          <h1 className="mt-2 text-2xl font-extrabold">Sign your waiver</h1>
          <p className="mt-1 text-sm text-white/50">{standaloneCenterName(brand, center)}</p>
        </header>
      )}

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
        <div className="mt-6 rounded-2xl border border-[#46d68c]/40 bg-[#46d68c]/10 p-4 text-center">
          <p className="text-base font-bold text-[#46d68c]">✓ All waivers signed</p>
          <p className="mt-1 text-sm text-white/60">
            {reservation
              ? "You're all set — these are saved to your reservation. Share the link above so the rest of your group can sign too."
              : "You're all set — we'll have these on file when you arrive. Add someone else above anytime."}
          </p>
        </div>
      )}
    </>,
  );
}

/** Lean event-info header — reservation name/activity/when/center + guest count.
 *  Deliberately NO pricing / deposit / other guests' PII (see /api/waiver/context). */
function EventInfoHeader({ ctx }: { ctx: WaiverContextSummary | null }) {
  return (
    <header className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-4 text-center">
      <div className="text-xs font-black uppercase tracking-[0.3em] text-[#00e2e5]">
        Sign your waiver
      </div>
      <h1 className="mt-2 text-xl font-extrabold leading-tight">
        {ctx?.label ?? "Your reservation"}
      </h1>
      <p className="mt-1 text-sm text-white/60">
        {[ctx?.activity, ctx?.whenLabel, ctx?.centerName].filter(Boolean).join(" · ") ||
          "Loading reservation…"}
      </p>
      {!!ctx?.total && (
        <p className="mt-1 text-xs text-white/40">
          {ctx.total} {ctx.total === 1 ? "guest" : "guests"} on this reservation
        </p>
      )}
    </header>
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

  return (
    <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="text-sm font-bold text-white">Share the waiver with your group</div>
      <p className="mt-1 text-xs text-white/50">
        Anyone can sign from this link — it only shows the event, never your booking details.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <a
          href={`sms:?&body=${encodeURIComponent(bodyText)}`}
          className="rounded-xl border border-white/20 px-3 py-2 text-center text-sm font-bold text-white"
        >
          Text it
        </a>
        <a
          href={`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`}
          className="rounded-xl border border-white/20 px-3 py-2 text-center text-sm font-bold text-white"
        >
          Email it
        </a>
        <button
          type="button"
          onClick={copy}
          className="rounded-xl border border-white/20 px-3 py-2 text-center text-sm font-bold text-white"
        >
          {copied ? "Copied!" : "Copy link"}
        </button>
        {canNativeShare && (
          <button
            type="button"
            onClick={nativeShare}
            className="rounded-xl bg-[var(--accent)] px-3 py-2 text-center text-sm font-bold text-[#04252b]"
          >
            Share…
          </button>
        )}
      </div>
    </div>
  );
}
