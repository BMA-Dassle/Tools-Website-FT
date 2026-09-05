"use client";

/**
 * Kiosk "Your Crew" page — /kiosk/racers (owner ask 2026-08-06).
 *
 * A group adds / removes / signs in everyone — accounts, waivers, licences —
 * with NO prices, no cart and no checkout, then hands the assembled party into
 * the normal booking flow. It is also the landing pad for a racing licence
 * scanned on an entry screen when the racer has nothing booked today
 * (useEntryScanRouter's `racer` arm).
 *
 * People screens: mounts KioskAttractionPeopleStep.Component — the live kiosk
 * people monolith — through its public StepDef surface, exactly like the waiver
 * flow (KioskWaiverFlow.tsx), and for the same reason: that file is
 * multi-writer-hot, so reusing the surface inherits every change for free. The
 * synthetic item is a slug-less attraction (no racing age floor, "Activity
 * Waiver" heading) passed as a PROP only — it is never dispatched into
 * `session.items`, so it can never show up as a phantom cart line.
 *
 * Where this page DIVERGES from the waiver flow: the reducer is the PERSISTED
 * kiosk session (same storageKey + schemaVersion as KioskFlow), because leaking
 * the party into the booking flow is the whole point. Party mutations land in
 * sessionStorage and the wizard's people step arrives pre-populated. That also
 * means an in-progress cart (bmiBillId, holds, promos) survives a round trip
 * through this page untouched — and that idle/start-over teardown here must run
 * KioskFlow's FULL sequence (abandonBooking → clearBookingSession →
 * resetToKiosk): the roster is guest PII, and a bare resetToKiosk clears only
 * the entry-scan stash. Expect a pre-populated party on mount — the voucher
 * auto-link rail (kiosk 1.26.0) may have seeded BMI-linked members already.
 *
 * Do NOT mount EntryScanListener here: serial-port opens are exclusive, and the
 * people step's own useLicenseScan is the port owner on this page — it already
 * handles a licence or member QR scanned live, so a second racer walking up
 * and scanning works with zero extra code. The entry-screen `racer` hand-off
 * needs no wiring either: the people step claims consumeEntryScan("racer")
 * itself the moment it mounts.
 *
 * NOTE (H5): a brief double-mount during router.push is harmless — the
 * persisted hook's write effect only fires after hydration, and restoreSession
 * replaces state wholesale, so both mounts converge on the stored session.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { IconChevronLeft, IconUsersGroup } from "@tabler/icons-react";
import { emptySession, type AttractionItem } from "~/features/booking";
import { clearBookingSession, usePersistedReducer } from "~/features/booking/hooks";
import { abandonBooking } from "~/features/booking/service/checkout";
import { clarityEvent } from "~/lib/clarity";
import { KioskAttractionPeopleStep } from "../steps/KioskPeopleStep";
import { newCrewItem } from "./crew-item";
import { KIOSK_SCHEMA_VERSION, KIOSK_SESSION_STORAGE_KEY } from "../state/registry";
import { IdleWatcher } from "../components/IdleWatcher";
import { BrandedLoader, BrandedLoaderOverlay } from "../components/BrandedLoader";
import { useKioskConfig } from "../KioskConfigContext";
import { isTestKiosk, type KioskConfig } from "../config";
import { useMobileJoinStatus } from "../hooks/useMobileJoin";
import { closeMobileJoin } from "../join/kiosk-client";
import { resetToKiosk } from "../version";
import { useT } from "../i18n";
import { StaffBar, StaffModeSurface, endStaffMode } from "../staff-mode";
import type { StaffLocation } from "../staff-mode/types";
import { GuestRaceHistoryProvider } from "../race-history/GuestRaceHistory";

// Same patience as the waiver flow / race-info: guests stand and work through
// waivers here; the watchdog pauses while a photo/signature is mid-flight.
const IDLE_MS = 120_000;

const PeopleScreens = KioskAttractionPeopleStep.Component;

/** True after hydration — server snapshot false, client snapshot true; no
 *  setState-in-effect, no hydration mismatch. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

export function KioskCrewFlow() {
  const t = useT();
  const router = useRouter();
  const { config } = useKioskConfig();
  const hydrated = useHydrated();

  // No device config → this URL was opened outside a provisioned kiosk.
  useEffect(() => {
    if (hydrated && config === null) router.replace("/kiosk");
  }, [hydrated, config, router]);

  // Two-component split ON PURPOSE (unlike today's waiver flow, whose reducer
  // is local): the PERSISTED reducer below must never initialize — and
  // therefore never write — against a null config, or a fresh session gets a
  // fallback entryBrand/center baked in (H2).
  if (!hydrated || !config) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[#000418]">
        <BrandedLoader brand="fasttrax" label={t("crew.loading")} />
      </div>
    );
  }
  return <CrewInner config={config} />;
}

function CrewInner({ config }: { config: KioskConfig }) {
  const t = useT();
  const router = useRouter();

  // Fallback initial — same shape KioskFlow builds, so a session CREATED here
  // is indistinguishable from one created in the flow. Only used when nothing
  // is stored; restoreSession replaces it wholesale otherwise.
  const initial = useMemo(
    () =>
      emptySession({
        entryBrand: config.brand,
        context: {
          center: config.center,
          kiosk: true,
          ...(isTestKiosk(config) ? { kioskTest: true as const } : {}),
        },
      }),
    [config],
  );
  const [session, dispatch, hydrated] = usePersistedReducer(initial, {
    storageKey: KIOSK_SESSION_STORAGE_KEY,
    schemaVersion: KIOSK_SCHEMA_VERSION,
  });
  const [item, setItem] = useState<AttractionItem>(newCrewItem);
  const [partyBusy, setPartyBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const mobileJoin = useMobileJoinStatus();

  // Post-hydration center seeding — same as KioskFlow: a session created here
  // gets its center from device config, never a picker.
  useEffect(() => {
    if (!hydrated) return;
    if (!session.center) dispatch({ type: "setCenter", center: config.center });
  }, [hydrated, session.center, config.center, dispatch]);

  /** Full guest-boundary teardown (H6 — the roster is PII): release vendor
   *  holds, wipe the persisted session, then back to attract. A bare
   *  resetToKiosk is NOT enough here — it clears only the entry-scan stash. */
  const teardown = useCallback(async () => {
    closeMobileJoin("start-over");
    // Staff mode is a per-tab credential; the guest boundary ends it too.
    endStaffMode();
    setResetting(true);
    // abandonBooking retries + verifies the BMI cancel (7/19 incident: silent
    // cancel failures stacked abandoned holds onto live heats). Safe on a
    // cart-less session (no bmiBillId → no-op) and never called on a CONFIRMED
    // booking — this page can't reach confirmation.
    const released = await abandonBooking(session).catch(() => false);
    if (!released) console.error("[kiosk] crew start-over could not confirm hold release");
    clearBookingSession(KIOSK_SESSION_STORAGE_KEY);
    await resetToKiosk(() => router.replace("/kiosk"));
  }, [session, router]);

  const goBook = () => {
    clarityEvent("kiosk:crew:book");
    router.push("/kiosk/flow");
  };

  // Staff surface (staff-mode/): a manager's Intercard card scanned here arms
  // Membership / Comp / Race history on every roster card. Center first —
  // Naples writes to the Naples Pandora location regardless of brand.
  const staffLocation: StaffLocation =
    config.center === "naples" ? "naples" : config.brand === "headpinz" ? "headpinz" : "fasttrax";

  // Guest race history (owner 2026-09-05): mounting this provider is what puts
  // the "My race history" button on every signed-in roster card — the crew page
  // is the only surface that opts in (the booking wizard stays focused on
  // building the party). It also HOSTS the sheet, above the roster cards; see
  // the containing-block note in GuestRaceHistory.tsx. Same location rule as
  // the staff surface above.

  // Gate the body on reducer hydration (H4): the hook won't WRITE before
  // hydrated, and this keeps a fast tapper from dispatching against the
  // pre-restore fallback either.
  if (!hydrated) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[#000418]">
        <BrandedLoader brand={config.brand} label={t("crew.loading")} />
      </div>
    );
  }

  return (
    <StaffModeSurface location={staffLocation}>
      <div className="k-flow">
        <IdleWatcher
          timeoutMs={IDLE_MS}
          // Never reset a guest mid-photo/signature, mid-teardown, or while
          // phones are actively signing in (heartbeats expire server-side in
          // ~30s, so an abandoned phone unpauses within one window).
          paused={
            partyBusy || resetting || (mobileJoin.status === "open" && mobileJoin.activeClients > 0)
          }
          onReset={() => {
            clarityEvent("kiosk:crew:idle-reset");
            closeMobileJoin("idle");
            void teardown();
          }}
        />

        {/* Header — back + eyebrow + title (the race-info skeleton). Back goes to
          the CHOOSER, never the attract screen: the crew must stay reachable
          and the session alive (H7). */}
        <div className="k-flow-head pb-[8px]">
          <div className="flex items-center gap-[28px]">
            <button
              type="button"
              aria-label={t("crew.back")}
              onClick={() => router.push("/kiosk/flow")}
              className="k-tap flex h-[96px] w-[96px] shrink-0 items-center justify-center rounded-[24px] border-2 border-white/15 bg-white/5 text-white/80"
            >
              <IconChevronLeft size={52} aria-hidden="true" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="k-eyebrow text-[#00e2e5]">{t("crew.eyebrow")}</div>
              <div className="k-display mt-[10px] text-[74px]">{t("crew.title")}</div>
            </div>
            <IconUsersGroup size={56} className="shrink-0 text-white/25" aria-hidden="true" />
          </div>
        </div>

        {/* Staff bar — who armed the kiosk, the 10 s idle ring, Staff logout.
          Renders nothing until a manager's card is scanned. */}
        <StaffBar />

        {/* Body — the live people monolith over the PERSISTED session. */}
        <div className="k-flow-body kiosk-scroll">
          <p className="mb-[28px] max-w-[44ch] text-[28px] leading-snug text-white/55">
            {t("crew.subtitle")}
          </p>
          <GuestRaceHistoryProvider location={staffLocation}>
            <PeopleScreens
              item={item}
              session={session}
              onChange={(patch) => setItem((prev) => ({ ...prev, ...patch }))}
              dispatch={dispatch}
              setBusy={setPartyBusy}
            />
          </GuestRaceHistoryProvider>
        </div>

        {/* Actions — no cart pill, no prices; that's the point of this page. */}
        <div className="k-z-actions pt-[16px]">
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="k-btn-ghost k-tap"
            style={{ flex: "0 0 auto" }}
          >
            {t("crew.startOver")}
          </button>
          <button type="button" onClick={goBook} className="k-btn-primary k-tap">
            {t("crew.bookSomething")}
          </button>
        </div>
        <div className="flex h-[96px] shrink-0 items-center justify-center">
          <span className="k-eyebrow text-white/35">{t("crew.footer.tagline")}</span>
        </div>

        {/* Start-over confirm — same canvas-native sheet pattern as KioskFlow's
          exit confirm: the SAFE choice is the big primary, the destructive one
          is the ghost. No tap-outside dismiss (kiosk convention). */}
        {confirmReset && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-[48px] backdrop-blur-sm">
            <div className="k-glass w-full max-w-[860px] space-y-[24px] p-[44px]">
              <div className="k-eyebrow text-[#f0b341]">{t("crew.startOver")}</div>
              <div className="k-display text-[46px] leading-[1.05]">{t("crew.confirm.title")}</div>
              <p className="text-[26px] leading-snug text-white/60">{t("crew.confirm.body")}</p>
              <div className="flex flex-col gap-[16px] pt-[4px]">
                {/* Inline flex per the .kiosk-canvas cascade gotcha (KioskFlow's
                  confirm sheet): k-btn-primary's flex:1 squashes its height in
                  a column layout. */}
                <button
                  type="button"
                  onClick={() => setConfirmReset(false)}
                  className="k-btn-primary k-tap"
                  style={{ flex: "0 0 auto" }}
                >
                  {t("crew.confirm.stay")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (partyBusy) return;
                    clarityEvent("kiosk:crew:start-over");
                    setConfirmReset(false);
                    void teardown();
                  }}
                  className="k-btn-ghost k-tap"
                  style={{
                    flex: "0 0 auto",
                    color: "#fca5a5",
                    borderColor: "rgba(248,113,113,0.45)",
                  }}
                >
                  {t("crew.confirm.reset")}
                </button>
              </div>
            </div>
          </div>
        )}

        {resetting && (
          <BrandedLoaderOverlay brand={config.brand} label={t("flow.loader.clearing")} />
        )}
      </div>
    </StaffModeSurface>
  );
}
