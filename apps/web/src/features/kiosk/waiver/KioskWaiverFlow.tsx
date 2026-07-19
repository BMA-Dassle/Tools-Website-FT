"use client";

/**
 * Kiosk "Online & Group Waiver" flow (owner ask 2026-07-18).
 *
 * A guest with an existing reservation — a group function OR an online racing
 * booking (the daily-events "group"/"online" split) — finds their group and
 * gets their waiver done without the front desk:
 *
 *   pick   → today's waiver-relevant reservations starting within 2 hours
 *            (event name, else main contact as "First L."), sorted by time.
 *   roster → "First L." of everyone already registered with a VALID waiver,
 *            plus the exact race-flow identity screens (KioskPartyManager:
 *            new-player form / returning lookup / photo + signature waiver)
 *            to add more people.
 *
 * The attach pipeline watches the local party: the moment a member has a
 * person id AND a valid waiver, it POSTs /api/kiosk/waiver/join (Neon
 * persist-first; BMI registerProjectPerson behind the probe-gated flag) and
 * refetches the roster — so back-to-back signers on one kiosk each appear as
 * they finish. The party persists across adds so a signed parent remains
 * pickable as a minor's guardian.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  IconChevronLeft,
  IconRefresh,
  IconSignature,
  IconUserCheck,
  IconUsersGroup,
} from "@tabler/icons-react";
import type { PartyMember } from "~/features/booking";
import { KioskPartyManager } from "../components/KioskPartyManager";
import { IdleWatcher } from "../components/IdleWatcher";
import { useKioskConfig } from "../KioskConfigContext";
import { kioskId } from "../config";
import { resetToKiosk } from "../version";
import { BrandedLoader } from "../components/BrandedLoader";
import type { KioskWaiverReservationItem, KioskWaiverRosterPayload } from "./types";

const IDLE_MS = 120_000;

export function KioskWaiverFlow() {
  const router = useRouter();
  const { config } = useKioskConfig();

  const [selected, setSelected] = useState<KioskWaiverReservationItem | null>(null);
  const [reservations, setReservations] = useState<KioskWaiverReservationItem[] | null>(null);
  const [resError, setResError] = useState(false);
  const [roster, setRoster] = useState<KioskWaiverRosterPayload | null>(null);
  const [party, setParty] = useState<PartyMember[]>([]);
  const [managerBusy, setManagerBusy] = useState(false);
  const [joinsInFlight, setJoinsInFlight] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  // person ids already POSTed to /join — the attach effect must never double-post.
  const postedRef = useRef<Set<string>>(new Set());

  // No device config → this URL was opened outside a provisioned kiosk.
  // (config hydrates synchronously from localStorage via useSyncExternalStore,
  // so by the time effects run, null genuinely means unprovisioned.)
  useEffect(() => {
    if (config === null) router.replace("/kiosk");
  }, [config, router]);

  // Picker fetch — one inline effect; the Refresh button bumps refreshTick to
  // re-run it. "Loading" is reservations === null; a manual refresh keeps the
  // old list on screen until the fresh one lands.
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/kiosk/waiver/reservations?center=${config.center}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.success) throw new Error("load failed");
        setReservations(data.reservations as KioskWaiverReservationItem[]);
        setResError(false);
      } catch {
        if (!cancelled) {
          setResError(true);
          setReservations([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, refreshTick]);

  const fetchRoster = useCallback(
    async (item: KioskWaiverReservationItem) => {
      if (!config) return;
      try {
        const res = await fetch(
          `/api/kiosk/waiver/roster?center=${config.center}&locationId=${item.locationId}&projectId=${item.projectId}`,
          { cache: "no-store" },
        );
        const data = (await res.json()) as KioskWaiverRosterPayload;
        if (res.ok && data.success) setRoster(data);
      } catch {
        /* roster is best-effort display — the manager still works without it */
      }
    },
    [config],
  );

  const openReservation = (item: KioskWaiverReservationItem) => {
    setSelected(item);
    setRoster(null);
    void fetchRoster(item);
  };

  // Attach pipeline: any party member with a person id + valid waiver joins the
  // reservation. Catches every ready path — fresh signature (WaiverSigning
  // onComplete patch), onboard-returns-already-valid, returning lookup with a
  // current waiver, and the importLinked authoritative patch.
  useEffect(() => {
    if (!selected || !config) return;
    for (const m of party) {
      const pid = m.pandoraPersonId ?? m.bmiPersonId;
      if (!pid || !m.waiverValid || postedRef.current.has(pid)) continue;
      postedRef.current.add(pid);
      setJoinsInFlight((n) => n + 1);
      void fetch("/api/kiosk/waiver/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          center: config.center,
          locationId: selected.locationId,
          projectId: selected.projectId,
          personId: pid,
          firstName: m.firstName,
          lastName: m.lastName ?? "",
          kioskId: kioskId(config),
        }),
      })
        .catch(() => {
          // Allow a retry on the next party change — the join never got saved.
          postedRef.current.delete(pid);
        })
        .finally(() => {
          setJoinsInFlight((n) => n - 1);
          if (selected) void fetchRoster(selected);
        });
    }
  }, [party, selected, config, fetchRoster]);

  const goHome = useCallback(() => {
    void resetToKiosk(() => router.replace("/kiosk"));
  }, [router]);

  if (!config) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[#000418]">
        <BrandedLoader brand="fasttrax" label="Loading…" />
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-[#000418]">
      <IdleWatcher timeoutMs={IDLE_MS} paused={managerBusy || joinsInFlight > 0} onReset={goHome} />

      {/* Header */}
      <div className="flex shrink-0 items-center gap-[24px] border-b border-white/10 px-[48px] py-[32px]">
        <button
          type="button"
          onClick={() => {
            if (selected) {
              setSelected(null);
              setRoster(null);
            } else {
              goHome();
            }
          }}
          className="k-tap flex h-[88px] items-center gap-[8px] rounded-2xl border-2 border-white/15 px-[28px] text-[28px] font-bold text-white/70"
        >
          <IconChevronLeft size={36} aria-hidden="true" />
          Back
        </button>
        <div className="min-w-0 flex-1">
          <div className="k-eyebrow text-[#00e2e5]">Online &amp; group waivers</div>
          <div className="k-display truncate text-[52px]">
            {selected ? selected.label : "Find your reservation"}
          </div>
        </div>
        <IconSignature size={56} className="shrink-0 text-white/25" aria-hidden="true" />
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-[48px] py-[40px]">
        {!selected ? (
          <div className="space-y-[24px]">
            <div className="flex items-center justify-between gap-[24px]">
              <p className="text-[28px] text-white/55">
                Racing or celebrating with a group in the next two hours? Tap your reservation to
                sign waivers before you play.
              </p>
              <button
                type="button"
                onClick={() => setRefreshTick((t) => t + 1)}
                className="k-tap flex h-[76px] shrink-0 items-center gap-[10px] rounded-2xl border-2 border-white/15 px-[24px] text-[24px] font-semibold text-white/60"
              >
                <IconRefresh size={30} aria-hidden="true" />
                Refresh
              </button>
            </div>

            {reservations === null ? (
              <div className="flex justify-center py-[120px]">
                <BrandedLoader brand={config.brand} label="Checking today's reservations…" />
              </div>
            ) : reservations.length === 0 ? (
              <div className="k-glass p-[48px] text-center">
                <IconUsersGroup size={72} className="mx-auto text-white/25" aria-hidden="true" />
                <div className="k-display mt-[20px] text-[40px]">
                  {resError ? "Couldn't load reservations" : "Nothing in the next two hours"}
                </div>
                <p className="mx-auto mt-[12px] max-w-[34ch] text-[26px] text-white/50">
                  {resError
                    ? "Please try again in a moment, or see the front desk."
                    : "Reservations show here starting two hours before their time. The front desk can always help sooner."}
                </p>
              </div>
            ) : (
              <div className="space-y-[16px]">
                {reservations.map((r) => (
                  <button
                    key={r.projectId}
                    type="button"
                    onClick={() => openReservation(r)}
                    className="k-glass k-tap w-full p-[28px] text-left"
                  >
                    <div className="flex items-center gap-[28px]">
                      <div className="w-[190px] shrink-0">
                        <div className="k-display text-[40px] text-[#00e2e5]">{r.timeLabel}</div>
                        <div className="k-eyebrow mt-[4px] text-white/40">
                          {r.kind === "online" ? "Online booking" : "Group event"}
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="k-display truncate text-[38px]">{r.label}</div>
                        <div className="mt-[6px] text-[24px] text-white/50">
                          {r.persons > 0 ? `${r.persons} guests` : "Group"}
                          {r.registeredPersons !== null &&
                            ` · ${r.registeredPersons} signed up so far`}
                        </div>
                      </div>
                      <IconChevronLeft
                        size={40}
                        className="shrink-0 rotate-180 text-white/30"
                        aria-hidden="true"
                      />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-[36px]">
            {/* Who's already set */}
            <div>
              <div className="k-eyebrow mb-[14px] text-white/40">
                Signed &amp; ready on this reservation
              </div>
              {roster === null ? (
                <div className="text-[26px] text-white/40">Checking who&rsquo;s signed…</div>
              ) : roster.people.length === 0 ? (
                <div className="text-[26px] text-white/40">
                  No one yet — be the first to get signed in below.
                </div>
              ) : (
                <div className="flex flex-wrap gap-[12px]">
                  {roster.people.map((p) => (
                    <span
                      key={p.personId}
                      className="flex items-center gap-[10px] rounded-2xl border-2 border-[#46d68c]/40 bg-[#46d68c]/8 px-[22px] py-[14px] text-[26px] font-bold text-white"
                    >
                      <IconUserCheck size={30} className="text-[#46d68c]" aria-hidden="true" />
                      {p.displayName}
                    </span>
                  ))}
                </div>
              )}
              {roster !== null && roster.counts.pending > 0 && (
                <div className="mt-[12px] text-[24px] text-[#f0b341]">
                  {roster.counts.pending} in this group still{" "}
                  {roster.counts.pending === 1 ? "needs" : "need"} a waiver.
                </div>
              )}
            </div>

            {/* Add people — the exact race-flow identity screens */}
            <div>
              <div className="k-eyebrow mb-[14px] text-white/40">Add yourself or your group</div>
              <KioskPartyManager
                mode="waiver"
                party={party}
                brandLocation={config.brand === "headpinz" ? "headpinz" : "fasttrax"}
                center={config.center}
                includedIds={new Set(party.map((m) => m.id))}
                onIncludedChange={() => {}}
                onAddMember={(member) => setParty((prev) => [...prev, member])}
                onUpdateMember={(id, patch) =>
                  setParty((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)))
                }
                onRemoveMember={(id) => setParty((prev) => prev.filter((m) => m.id !== id))}
                setBusy={setManagerBusy}
              />
            </div>

            <button
              type="button"
              onClick={goHome}
              className="k-btn-primary k-tap h-[96px] w-full text-[32px]"
            >
              Done — back to start
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
