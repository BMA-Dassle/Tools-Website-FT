"use client";

/**
 * /kiosk/staff — the floor lead's tools, on the kiosk itself. Reached via a
 * hidden gesture on the attract screen (5 taps, top-RIGHT — top-left opens the
 * full admin) → PIN. The staff PIN (KIOSK_STAFF_PIN) or the admin PIN unlocks
 * it; the staff PIN does NOT open /kiosk/admin. Verified server-side on every
 * call (admin-auth.ts `kioskStaffOk`).
 *
 * Deliberately narrower than /kiosk/admin — no provisioning, no raw commands:
 *  - Dispenser: un-stick the CRT-591 in plain English (push a card out, take
 *    it back, clear a jam, gate control, reject-bin counter).
 *  - Lanes: live bowling + duckpin occupancy from QAMF (never Neon — walk-ins,
 *    leagues and maintenance blocks don't reach our DB).
 *  - Card loads: this kiosk's sales ledger with truthful outcomes and live card
 *    lookup. Read-only — nothing here can change a card's value.
 *
 * Staff surface → hardcoded English (house precedent; the i18n rule exempts
 * staff surfaces). Styling mirrors KioskAdmin's dark panel language with a
 * GREEN accent so staff always know which tier they're on (admin is cyan).
 */
import { useState } from "react";
import { useKioskConfig } from "../KioskConfigContext";
import { kioskDeviceKey } from "../config";
import { KIOSK_VERSION } from "../version";
import { KioskStaffDispenser } from "./KioskStaffDispenser";
import { KioskStaffLanes } from "./KioskStaffLanes";
import { KioskStaffCardLoads } from "./KioskStaffCardLoads";

type Tab = "dispenser" | "lanes" | "loads";

const TAB_LABELS: Record<Tab, string> = {
  dispenser: "Dispenser",
  lanes: "Lanes",
  loads: "Card loads",
};

/** Authed fetch for the staff API — the canonical x-kiosk-pin header. */
export async function staffFetch(pin: string, url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      "x-kiosk-pin": pin,
      "content-type": "application/json",
    },
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

export function KioskStaff() {
  const { config } = useKioskConfig();
  const [pin, setPin] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("dispenser");

  const tryAuth = async () => {
    setAuthError(null);
    const { ok, status } = await staffFetch(pin, "/api/kiosk/staff?action=ping");
    if (ok) setAuthed(true);
    else setAuthError(status === 401 ? "Wrong PIN" : "Couldn't reach the staff API");
  };

  if (!authed) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 overflow-y-auto bg-[#000418] px-8 py-10">
        <div className="w-full max-w-sm space-y-5 rounded-3xl border border-white/10 bg-[#0d1a36] p-8 text-center">
          <div className="font-heading text-3xl font-extrabold italic">Staff tools</div>
          <p className="text-sm text-white/55">
            Staff PIN required. (The admin PIN also works here.)
          </p>
          <input
            type="password"
            inputMode="numeric"
            data-osk-layout="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void tryAuth()}
            placeholder="PIN"
            className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-center text-2xl tracking-[0.4em] text-white focus:border-[#46d68c] focus:outline-none"
          />
          {authError && <p className="text-sm text-red-300">{authError}</p>}
          <button
            type="button"
            onClick={() => void tryAuth()}
            className="w-full rounded-xl bg-[#46d68c] px-5 py-3 font-bold text-[#04250f]"
          >
            Unlock
          </button>
          <a href="/kiosk" className="block text-xs text-white/40">
            Back to kiosk
          </a>
        </div>
      </div>
    );
  }

  return (
    // Same scroll container rule as KioskAdmin: this lives inside the fixed
    // kiosk canvas (overflow-hidden), so the page needs its OWN scroll.
    <div className="absolute inset-0 overflow-y-auto bg-[#000418] px-6 py-8 text-white">
      <div className="mx-auto max-w-2xl space-y-6 pb-16">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <div className="font-heading text-3xl font-extrabold italic">Staff tools</div>
            <span className="text-xs font-semibold text-white/40">v{KIOSK_VERSION}</span>
            {config && (
              <span className="rounded-full bg-[#46d68c]/15 px-3 py-0.5 font-mono text-xs font-bold text-[#46d68c]">
                {kioskDeviceKey(config)}
              </span>
            )}
          </div>
          <a
            href="/kiosk"
            className="rounded-full border border-white/15 px-5 py-2 text-sm text-white/60"
          >
            Exit to kiosk
          </a>
        </div>

        {!config && (
          <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            This device isn&apos;t provisioned (no saved kiosk setup). The dispenser and lane tabs
            still work; the card-load ledger needs a kiosk identity — set one up in Kiosk admin
            first.
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {(["dispenser", "lanes", "loads"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-full px-5 py-2 text-sm font-bold ${
                tab === t ? "bg-[#46d68c] text-[#04250f]" : "border border-white/15 text-white/60"
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {tab === "dispenser" && <KioskStaffDispenser config={config} />}
        {tab === "lanes" && <KioskStaffLanes pin={pin} center={config?.center ?? "fort-myers"} />}
        {tab === "loads" && (
          <KioskStaffCardLoads
            pin={pin}
            kioskId={config ? kioskDeviceKey(config) : null}
            center={config?.center ?? null}
            brand={config?.brand ?? null}
          />
        )}
      </div>
    </div>
  );
}
