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
 *            plus the EXACT race-flow people screens to add more people.
 *
 * People screens: this mounts KioskAttractionPeopleStep.Component — the live
 * kiosk people monolith (new-player form, returning lookup, guardian signer
 * flow, photo + signature waiver) — over a LOCAL, non-persisted instance of
 * the real booking reducer. Deliberately NOT an extraction: that file is
 * multi-writer-hot (Alex ships to it directly), so the waiver flow reuses it
 * through its public StepDef surface and inherits every change for free. The
 * synthetic item is a slug-less attraction: no racing age floor, "Activity
 * Waiver" heading, signer-only guardians stay out of the party.
 *
 * The attach pipeline watches session.party: the moment a member has a person
 * id AND a valid waiver, it POSTs /api/kiosk/waiver/join (Neon persist-first;
 * BMI registerProjectPerson behind the probe-gated flag) and refetches the
 * roster — back-to-back signers on one kiosk each appear as they finish. The
 * party persists across adds so a signed parent remains available as a
 * later minor's guardian. Signer-only guardians (session.guardians) are NOT
 * joined to the reservation — they're not attending; "Join the fun" moves
 * them into the party, which is.
 */
import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  IconChevronLeft,
  IconRefresh,
  IconSignature,
  IconUserCheck,
  IconUsersGroup,
} from "@tabler/icons-react";
import { emptySession, reducer, type AttractionItem } from "~/features/booking";
import { useReservationJoinAttach } from "~/features/waiver/attach/reservation-join";
import { KioskAttractionPeopleStep } from "../steps/KioskPeopleStep";
import { IdleWatcher } from "../components/IdleWatcher";
import { useKioskConfig } from "../KioskConfigContext";
import { kioskId } from "../config";
import { resetToKiosk } from "../version";
import { BrandedLoader } from "../components/BrandedLoader";
import { useT } from "../i18n";
import type { KioskWaiverReservationItem, KioskWaiverRosterPayload } from "./types";

const IDLE_MS = 120_000;

const PeopleScreens = KioskAttractionPeopleStep.Component;

/** Slug-less synthetic attraction item — carries the participants toggle the
 *  people step expects; never priced, never booked. */
function newWaiverItem(): AttractionItem {
  return {
    id: "waiver",
    kind: "attraction",
    slug: null,
    date: null,
    slot: null,
    qty: 1,
    productId: null,
    pageId: null,
    price: 0,
    // Synthetic item — never booked, so the booking-side fields stay empty.
    bmiLineId: null,
    slotProposal: null,
    assignedTo: [],
  };
}

/** True after hydration — server snapshot false, client snapshot true; no
 *  setState-in-effect, no hydration mismatch. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

export function KioskWaiverFlow() {
  const t = useT();
  const router = useRouter();
  const { config } = useKioskConfig();
  const hydrated = useHydrated();

  // The people screens run on the REAL booking reducer, locally scoped to this
  // page (not persisted — a waiver session is one group at the kiosk, and the
  // IdleWatcher reset is the cleanup). center is baked in at init: config
  // hydrates synchronously from localStorage, so it's present on the first
  // client render; the unprovisioned case redirects below.
  const [session, dispatch] = useReducer(reducer, undefined, () => ({
    ...emptySession({
      entryBrand: config?.brand ?? "fasttrax",
      context: { kiosk: true, ...(config ? { center: config.center } : {}) },
    }),
    center: config?.center ?? null,
  }));
  const [item, setItem] = useState<AttractionItem>(newWaiverItem);

  const [selected, setSelected] = useState<KioskWaiverReservationItem | null>(null);
  const [reservations, setReservations] = useState<KioskWaiverReservationItem[] | null>(null);
  const [resError, setResError] = useState(false);
  const [roster, setRoster] = useState<KioskWaiverRosterPayload | null>(null);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [joinsInFlight, setJoinsInFlight] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);

  // No device config → this URL was opened outside a provisioned kiosk.
  useEffect(() => {
    if (hydrated && config === null) router.replace("/kiosk");
  }, [hydrated, config, router]);

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
    async (target: KioskWaiverReservationItem) => {
      if (!config) return;
      try {
        const res = await fetch(
          `/api/kiosk/waiver/roster?center=${config.center}&locationId=${target.locationId}&projectId=${target.projectId}`,
          { cache: "no-store" },
        );
        const data = (await res.json()) as KioskWaiverRosterPayload;
        if (res.ok && data.success) setRoster(data);
      } catch {
        /* roster is best-effort display — the people screens work without it */
      }
    },
    [config],
  );

  const openReservation = (target: KioskWaiverReservationItem) => {
    setSelected(target);
    setRoster(null);
    void fetchRoster(target);
  };

  // Attach pipeline (extracted to useReservationJoinAttach so the mobile /waiver
  // flow shares the exact same logic): any PARTY member with a person id + valid
  // waiver joins the reservation — Neon persist-first, then probe-gated BMI attach.
  // Signer-only guardians are not attending, so they're never in `party` here.
  useReservationJoinAttach({
    party: session.party,
    target: selected,
    center: config?.center ?? null,
    kioskId: config ? kioskId(config) : null,
    enabled: !!config,
    onJoinStart: () => setJoinsInFlight((n) => n + 1),
    onJoinSettled: () => {
      setJoinsInFlight((n) => n - 1);
      if (selected) void fetchRoster(selected);
    },
  });

  const goHome = useCallback(() => {
    void resetToKiosk(() => router.replace("/kiosk"));
  }, [router]);

  if (!hydrated || !config) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[#000418]">
        <BrandedLoader brand="fasttrax" label={t("waiverFlow.loading")} />
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-[#000418]">
      <IdleWatcher timeoutMs={IDLE_MS} paused={peopleBusy || joinsInFlight > 0} onReset={goHome} />

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
          {t("waiverFlow.back")}
        </button>
        <div className="min-w-0 flex-1">
          <div className="k-eyebrow text-[#00e2e5]">{t("waiverFlow.eyebrow")}</div>
          <div className="k-display truncate text-[52px]">
            {selected ? selected.label : t("waiverFlow.findReservation")}
          </div>
        </div>
        <IconSignature size={56} className="shrink-0 text-white/25" aria-hidden="true" />
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-[48px] py-[40px]">
        {!selected ? (
          <div className="space-y-[24px]">
            <div className="flex items-center justify-between gap-[24px]">
              <p className="text-[28px] text-white/55">{t("waiverFlow.pickerPrompt")}</p>
              <button
                type="button"
                onClick={() => setRefreshTick((n) => n + 1)}
                className="k-tap flex h-[76px] shrink-0 items-center gap-[10px] rounded-2xl border-2 border-white/15 px-[24px] text-[24px] font-semibold text-white/60"
              >
                <IconRefresh size={30} aria-hidden="true" />
                {t("waiverFlow.refresh")}
              </button>
            </div>

            {reservations === null ? (
              <div className="flex justify-center py-[120px]">
                <BrandedLoader brand={config.brand} label={t("waiverFlow.checkingReservations")} />
              </div>
            ) : reservations.length === 0 ? (
              <div className="k-glass p-[48px] text-center">
                <IconUsersGroup size={72} className="mx-auto text-white/25" aria-hidden="true" />
                <div className="k-display mt-[20px] text-[40px]">
                  {resError ? t("waiverFlow.empty.errorTitle") : t("waiverFlow.empty.title")}
                </div>
                <p className="mx-auto mt-[12px] max-w-[34ch] text-[26px] text-white/50">
                  {resError ? t("waiverFlow.empty.errorBody") : t("waiverFlow.empty.body")}
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
                          {r.kind === "online"
                            ? t("waiverFlow.kind.online")
                            : t("waiverFlow.kind.group")}
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="k-display truncate text-[38px]">{r.label}</div>
                        <div className="mt-[6px] text-[24px] text-white/50">
                          {r.persons > 0
                            ? t("waiverFlow.guests", { count: r.persons })
                            : t("waiverFlow.group")}
                          {r.registeredPersons !== null &&
                            ` · ${t("waiverFlow.signedUpSoFar", { count: r.registeredPersons })}`}
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
              <div className="k-eyebrow mb-[14px] text-white/40">{t("waiverFlow.signedReady")}</div>
              {roster === null ? (
                <div className="text-[26px] text-white/40">{t("waiverFlow.checkingSigned")}</div>
              ) : roster.people.length === 0 ? (
                <div className="text-[26px] text-white/40">{t("waiverFlow.noneSigned")}</div>
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
                  {t("waiverFlow.pending", { count: roster.counts.pending })}
                </div>
              )}
            </div>

            {/* Add people — the exact race-flow people screens, on a local
                booking-reducer session scoped to this waiver visit */}
            <div>
              <div className="k-eyebrow mb-[14px] text-white/40">{t("waiverFlow.addYourself")}</div>
              <PeopleScreens
                item={item}
                session={session}
                onChange={(patch) => setItem((prev) => ({ ...prev, ...patch }))}
                dispatch={dispatch}
                setBusy={setPeopleBusy}
              />
            </div>

            <button
              type="button"
              onClick={goHome}
              className="k-btn-primary k-tap h-[96px] w-full text-[32px]"
            >
              {t("waiverFlow.done")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
