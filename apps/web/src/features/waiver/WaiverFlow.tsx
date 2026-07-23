"use client";

/**
 * The first-party mobile waiver flow (/waiver). Mounts the shared WaiverParty
 * (KioskPartyManager) in mobile theme with the guardian-signs-for-minor chain
 * ON — the exact players section the kiosk uses, on a phone. Standalone here
 * (no reservation): a guest adds their family and signs, and the waiver is on
 * file for their visit. Reservation-scoped attach + link sharing land later.
 *
 * Brand comes from the host (x-brand, resolved in the server page). Center comes
 * from ?c=; a HeadPinz visitor with no center picks Fort Myers vs Naples first
 * so Naples waivers record at the Naples Pandora location (not HP Fort Myers).
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import type { Brand, CenterCode } from "~/features/booking/types";
import type { PartyMember } from "~/features/booking/state/types";
import { KioskPartyManager, peopleReady } from "~/features/kiosk/components/KioskPartyManager";
import { MobileWaiverPhoto } from "./MobileWaiverPhoto";

/** Center-first Pandora location — a Naples waiver records at Naples, never HP
 *  Fort Myers (the 2026-07-20 misroute class). Mirrors join-helpers.brandLocationFor. */
function pandoraLocationFor(brand: Brand, center: CenterCode): "fasttrax" | "headpinz" | "naples" {
  if (center === "naples") return "naples";
  return brand === "headpinz" ? "headpinz" : "fasttrax";
}

function centerName(brand: Brand, center: CenterCode): string {
  if (center === "naples") return "HeadPinz Naples";
  return brand === "headpinz" ? "HeadPinz Fort Myers" : "FastTrax Fort Myers";
}

const outlineBtn =
  "w-full rounded-xl border border-white/25 px-4 py-3 text-base font-bold text-white";

export function WaiverFlow({
  brand,
  initialCenter,
}: {
  brand: Brand;
  initialCenter: CenterCode | null;
}) {
  // FastTrax host is Fort Myers racing only; a HeadPinz visitor without ?c picks
  // their center so Naples waivers don't record at Fort Myers.
  const [center, setCenter] = useState<CenterCode | null>(
    brand === "fasttrax" ? "fort-myers" : initialCenter,
  );
  const [party, setParty] = useState<PartyMember[]>([]);

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

  if (!center) {
    return shell(
      <div className="space-y-4">
        <header className="mb-2 text-center">
          <div className="text-xs font-black uppercase tracking-[0.3em] text-white/40">
            HeadPinz
          </div>
          <h1 className="mt-2 text-2xl font-extrabold">Sign your waiver</h1>
          <p className="mt-1 text-sm text-white/50">Which location are you visiting?</p>
        </header>
        <button type="button" className={outlineBtn} onClick={() => setCenter("fort-myers")}>
          HeadPinz Fort Myers
        </button>
        <button type="button" className={outlineBtn} onClick={() => setCenter("naples")}>
          HeadPinz Naples
        </button>
      </div>,
    );
  }

  const location = pandoraLocationFor(brand, center);
  const allIds = new Set(party.map((m) => m.id));
  const ready = party.length > 0 && peopleReady(party, Array.from(allIds)) === true;

  return shell(
    <>
      <header className="mb-6 text-center">
        <div className="text-xs font-black uppercase tracking-[0.3em] text-white/40">
          {brand === "headpinz" ? "HeadPinz" : "FastTrax"}
        </div>
        <h1 className="mt-2 text-2xl font-extrabold">Sign your waiver</h1>
        <p className="mt-1 text-sm text-white/50">{centerName(brand, center)}</p>
      </header>

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

      {ready && (
        <div className="mt-6 rounded-2xl border border-[#46d68c]/40 bg-[#46d68c]/10 p-4 text-center">
          <p className="text-base font-bold text-[#46d68c]">✓ All waivers signed</p>
          <p className="mt-1 text-sm text-white/60">
            You&rsquo;re all set — we&rsquo;ll have these on file when you arrive. Add someone else
            above anytime.
          </p>
        </div>
      )}
    </>,
  );
}
