"use client";

/**
 * Kiosk self-service CHECK-IN flow (PR1 — read-only lookup + "what's next").
 *
 * Screens: find (phone / scan / browse) → prove possession → itinerary. Phone
 * is primary (works for every booking, including kiosk-booked ones that have no
 * email QR); a scanned code opens directly; browse rows text a code to the
 * booking's OWN contact before opening. PR2 turns the read-only party panel
 * into add-people + waivers and wires "Check in everyone".
 *
 * Structure mirrors KioskWaiverFlow: page-local state, IdleWatcher, resetToKiosk
 * exit, canvas Podium classes, the shell's global on-screen keyboard for input.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import {
  IconChevronLeft,
  IconDeviceMobile,
  IconScan,
  IconListSearch,
  IconChevronRight,
  IconMapPin,
  IconClock,
  IconUserCheck,
  IconBolt,
  IconStarFilled,
} from "@tabler/icons-react";
import { emptySession, reducer, type AttractionItem } from "~/features/booking";
import { KioskAttractionPeopleStep } from "../steps/KioskPeopleStep";
import { IdleWatcher } from "../components/IdleWatcher";
import { BrandedLoader } from "../components/BrandedLoader";
import { RacingWhatsNext } from "../components/RacingWhatsNext";
import { useKioskConfig } from "../KioskConfigContext";
import { isTestKiosk, kioskId, venueSlug } from "../config";
import { resetToKiosk } from "../version";
import { consumeEntryScan } from "../entry-scan/handoff";
import { useT } from "../i18n";
import {
  bindParty,
  completeCheckin,
  confirmContactOtp,
  fetchBindableParty,
  fetchItinerary,
  lookupBrowse,
  lookupByPhone,
  lookupByRefBypass,
  lookupByScan,
  sendContactOtp,
  sendOwnPhoneOtp,
  verifyOwnPhoneOtp,
} from "./service";
import { prefillPartyMembers } from "./party-prefill";
import { kioskVoucherPrefillEnabled } from "../flags";
import { CheckinBowlingDetails } from "./CheckinBowlingDetails";
import { useWedgeScan } from "./wedge-scan";
import { useQrScanner } from "../qr-scanner";
import { heatsConflict } from "~/features/booking/service/conflict";
import { resolveRaceClass } from "./category";
import { autoAssignRaces } from "./race-autofill";
import type {
  CheckinActivity,
  CheckinBindMember,
  CheckinBrowseRow,
  CheckinCompleteResponse,
  CheckinItinerary,
  CheckinLookupMatch,
  CheckinPartyMember,
  CheckinRaceSlot,
  CheckinSlotAssignment,
} from "./types";
import type { PartyMember } from "~/features/booking";

/** The people monolith, mounted directly over a local reducer (KioskWaiverFlow
 *  pattern) — gives add-people + returning lookup + waivers + the mobile-join
 *  QR + merge, all writing into our local session.party. */
const PeopleScreens = KioskAttractionPeopleStep.Component;

/** Slug-less synthetic attraction item — no racing age floor; never booked. */
function newCheckinItem(): AttractionItem {
  return {
    id: "checkin",
    kind: "attraction",
    slug: null,
    date: null,
    slot: null,
    qty: 1,
    productId: null,
    pageId: null,
    price: 0,
    bmiLineId: null,
    slotProposal: null,
    assignedTo: [],
  };
}

const IDLE_MS = 120_000;

type Stage =
  | "find"
  | "phone-otp"
  | "matches"
  | "browse"
  | "browse-verify"
  | "browse-otp"
  | "itinerary"
  | "party"
  | "assign"
  | "bowling"
  | "done";

const DONE_RESET_MS = 60_000;

/** True after hydration — no setState-in-effect, no hydration mismatch. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

const ACCENT: Record<CheckinActivity["kind"], string> = {
  racing: "#e94141",
  bowling: "#2dd4ea",
  attraction: "#a78bfa",
};

export function KioskCheckinFlow() {
  const router = useRouter();
  const { config } = useKioskConfig();
  const t = useT();
  const hydrated = useHydrated();
  const center = config?.center ?? "fort-myers";
  // Which BUILDING this kiosk is in — center can't say (FastTrax + HeadPinz FM
  // share "fort-myers"). Bowling check-in is a HeadPinz-building action (owner
  // 2026-08-16): at "FT" the server withholds bowling-only results and this
  // flow never opens the bowler-details step or the lane-open button.
  const venue = config ? venueSlug(config) : undefined;
  const atFtKiosk = venue === "FT";
  // (No Pandora location needed here any more — check-in no longer mints or
  // reads a person to resolve an id; it uses the id the cloud already assigned.)

  const [stage, setStage] = useState<Stage>("find");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Express-lane info modal — set to the booking that was tapped. An express
  // party needs nothing from the kiosk, so this REPLACES their check-in: no
  // last-4 gate, no OTP, no itinerary (owner, repeatedly).
  const [expressFor, setExpressFor] = useState<{ label: string; timeLabel: string } | null>(null);
  // True while the kiosk's serial QR scanner holds the port and hears scans.
  const [scanListening, setScanListening] = useState(false);

  // Phone path
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [matches, setMatches] = useState<CheckinLookupMatch[]>([]);

  // Browse path
  const [rows, setRows] = useState<CheckinBrowseRow[]>([]);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [otpMask, setOtpMask] = useState<string>("");
  const [last4, setLast4] = useState("");

  // Itinerary
  const [itinerary, setItinerary] = useState<CheckinItinerary | null>(null);
  const [proofToken, setProofToken] = useState<string | null>(null);
  // Voucher-QR party prefill (flag-gated): the proven reservation's bind-ready
  // roster, fetched alongside the itinerary. Null = unavailable / flag off.
  const [prefillRoster, setPrefillRoster] = useState<CheckinPartyMember[] | null>(null);
  // BMI never answered for this reservation — the roster is booking-labels only
  // and may be missing people who ARE registered. Say so rather than present a
  // short list as the truth.
  const [rosterDegraded, setRosterDegraded] = useState(false);
  // True while the booking's roster is still being fetched — drives the branded
  // loader on the party step so the wait is never a blank list.
  const [rosterLoading, setRosterLoading] = useState(false);
  // Ready members from the booking are added automatically (owner 2026-08-07:
  // "why were they just not auto loaded in list"). Ref-gated so the effect runs
  // once per fetched roster — dispatching grows session.party, which would
  // otherwise re-trigger it.
  const autoLoadedRef = useRef(false);

  // Party panel — the people monolith runs on this LOCAL, non-persisted booking
  // reducer (center baked in; config hydrates synchronously on a provisioned
  // kiosk, and the unprovisioned case redirects below).
  const [session, dispatch] = useReducer(reducer, undefined, () => ({
    ...emptySession({
      entryBrand: config?.brand ?? "fasttrax",
      context: { kiosk: true, ...(config ? { center: config.center } : {}) },
    }),
    center: config?.center ?? null,
  }));
  const [checkinItem, setCheckinItem] = useState<AttractionItem>(newCheckinItem);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [binding, setBinding] = useState(false);
  const [bindMsg, setBindMsg] = useState<string | null>(null);
  // member ids already attached this visit — never re-attach on a second tap.
  const [boundIds, setBoundIds] = useState<Set<string>>(() => new Set());
  const [complete, setComplete] = useState<CheckinCompleteResponse | null>(null);
  // Race-slot assignment ("who is who") — open-slot heatId → party member id.
  const [assignMap, setAssignMap] = useState<Record<string, string>>({});
  // Bowler-details PATCH in flight — pauses the idle watcher and locks back.
  const [bowlSaving, setBowlSaving] = useState(false);

  const goHome = useCallback(() => {
    void resetToKiosk(() => router.replace("/kiosk"));
  }, [router]);

  // Unprovisioned URL → back to attract.
  useEffect(() => {
    if (hydrated && config === null) router.replace("/kiosk");
  }, [hydrated, config, router]);

  const openItinerary = useCallback(
    async (token: string) => {
      setBusy(true);
      setError(null);
      const data = await fetchItinerary(center, token);
      setBusy(false);
      if (!data || !data.ok) {
        setError(
          data?.reason === "cancelled" ? t("checkin.err.cancelled") : t("checkin.err.openFail"),
        );
        return;
      }
      setItinerary(data);
      setProofToken(token);
      setStage("itinerary");
      // A bowling-only reservation never mounts the party step — no accounts,
      // no waivers — so the (7.7–15.5s) BMI roster fetch would be pure waste;
      // the server answers empty for its key anyway.
      const dataBowlingOnly =
        data.activities.length > 0 && data.activities.every((a) => a.kind === "bowling");
      // Prefill roster rides the same proof — fire-and-forget so the itinerary
      // never waits on it; a failure just means no shortcut button.
      if (kioskVoucherPrefillEnabled() && !dataBowlingOnly) {
        // The roster is a TWO-HOP lookup (BMI project → person profiles) plus a
        // live Pandora waiver read per person: measured 7.7–15.5s on real
        // reservations, and it used to run behind a blank list with no hint
        // anything was happening (owner 2026-08-07: "no loading indication and
        // it took a few seconds"). Still fire-and-forget so the itinerary never
        // waits on it — the flag only drives the loader.
        setRosterLoading(true);
        void fetchBindableParty(center, token)
          .then((res) => {
            if (res?.degraded) setRosterDegraded(true);
            const members = res?.members;
            if (members && members.length > 0) setPrefillRoster(members);
          })
          .finally(() => setRosterLoading(false));
      }
    },
    [center, t],
  );

  // WHO IS ACTUALLY CHECKING IN. The people step ticks members into
  // `checkinItem.participants` (undefined = everyone, the default). The gate
  // below used to scan session.party wholesale, so a single row that arrived
  // from the booking without an account deadlocked BOTH buttons and unticking
  // it did nothing — the guest had to find "Remove". Counting only the ticked
  // members makes the checkbox mean what it looks like it means. (W57387: three
  // un-setup booking labels froze a party of four who were all ready.)
  const includedIds = useMemo(
    () => new Set(checkinItem.participants ?? session.party.map((m) => m.id)),
    [checkinItem.participants, session.party],
  );
  const includedParty = session.party.filter((m) => includedIds.has(m.id));
  const readyMembers = includedParty.filter((m) => m.bmiPersonId && m.waiverValid);
  const unboundReady = readyMembers.filter((m) => !boundIds.has(m.id));
  // A TICKED member still mid-setup (added but no account/waiver yet) blocks
  // check-in — mirror the people step's readiness gate.
  const partyNeedsSetup = includedParty.some((m) => !m.bmiPersonId || !m.waiverValid);
  // Everyone unticked → nothing to check in. Without this, an empty `some()`
  // reads as "ready" and the button would arm with nobody selected.
  const nobodyIncluded = includedParty.length === 0;

  // "Who is who" — the open (unfilled) purchased race slots, and the handler
  // that assigns a ready party member to one. Keyed by the seat-unique slotKey
  // (never heatId — two racers can share a heat). A member may hold SEVERAL
  // slots (multi-race bookings: a red then a blue race is one person twice),
  // subject to web booking's per-racer heat-spacing rules (raceSlotsConflict):
  // assigning releases only the member's slots too close to the new one, never
  // their compatible other races.
  // AUTO-LOAD the people the booking already knows AND who are ready to go —
  // an account plus a live waiver. They need no decision from the guest, so
  // making them tap a button to see their own party was pure friction (owner
  // 2026-08-07: "where did those come from and why were they just not auto
  // loaded in list"). Anyone still needing an account or a waiver is NOT
  // auto-added: that is a real decision, and it stays behind the gold bar so
  // nobody silently acquires a party member they then have to set up.
  useEffect(() => {
    if (!prefillRoster || autoLoadedRef.current) return;
    const toAdd = prefillPartyMembers(session.party, prefillRoster);
    if (toAdd.length === 0) return;
    autoLoadedRef.current = true;
    for (const m of toAdd) dispatch({ type: "addPartyMember", member: m });
  }, [prefillRoster, session.party]);

  // TICK the people who are actually ready. Everyone from the booking is now in
  // the list, but only those with an account AND a live waiver are checked in
  // by default — so someone still needing setup is visible (with their "Set up"
  // button) without blocking the party that IS ready. Fires once per member, on
  // the transition to ready, so a deliberate untick is never undone.
  const autoTickedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const newlyReady = session.party.filter(
      (m) => m.bmiPersonId && m.waiverValid && !autoTickedRef.current.has(m.id),
    );
    if (newlyReady.length === 0) return;
    for (const m of newlyReady) autoTickedRef.current.add(m.id);
    setCheckinItem((prev) => {
      // Seed EMPTY, not "everyone": defaulting to the whole party would tick the
      // very people who still need setup and re-create the deadlock this fixes.
      const current = prev.participants ?? [];
      const next = new Set(current);
      for (const m of newlyReady) next.add(m.id);
      return { ...prev, participants: Array.from(next), qty: Math.max(next.size, 1) };
    });
  }, [session.party]);

  const openRaceSlots = itinerary?.raceSlots.filter((s) => s.open) ?? [];
  // Bowling legs that take the kiosk bowler-details check-in (names / shoes /
  // bumpers) — HeadPinz lanes only, flagged by the server; FT duckpin and
  // cancelled legs never qualify. NEVER at a FastTrax-building kiosk: a combo
  // checked in at FT does racing only, and its bowling is checked in at the
  // HeadPinz kiosks (owner 2026-08-16).
  const bowlingDetailActivities = atFtKiosk
    ? []
    : (itinerary?.activities ?? []).filter(
        (a): a is CheckinActivity & { neonReservationId: number } =>
          a.kind === "bowling" && a.bowlingCheckinEligible === true && !!a.neonReservationId,
      );
  // Bowling is the WHOLE reservation → no accounts, no waivers, no party step
  // (owner 2026-08-16: "bowling does not need a full account/waiver").
  const bowlingOnly =
    !!itinerary &&
    itinerary.activities.length > 0 &&
    itinerary.activities.every((a) => a.kind === "bowling");
  const slotByKey = (key: string) => openRaceSlots.find((s) => s.slotKey === key);
  const assignRace = (slotKey: string, memberId: string) => {
    const target = slotByKey(slotKey);
    setAssignMap((prev) => {
      const next: Record<string, string> = {};
      for (const [k, mId] of Object.entries(prev)) {
        if (mId === memberId && raceSlotsConflict(slotByKey(k), target)) continue; // too close — release
        next[k] = mId;
      }
      if (prev[slotKey] === memberId) return next; // tapping the held slot clears it
      next[slotKey] = memberId;
      return next;
    });
  };
  // AUTO-FILL the races the kiosk can work out (owner 2026-08-07: "when the
  // party and the races line up, fill them in, show it, and let them change").
  // Runs once on entering the assign step, and only over slots nobody has
  // chosen yet — a guest's own pick is never overwritten. autoAssignRaces
  // refuses to guess when a category has more racers than seats, and is given
  // the SAME spacing predicate the chips use, so it can only reach a state the
  // guest could have reached by hand.
  // Who ended up on each race, for the done screen. Built from the SAME seat
  // grouping the assign step uses (heat + product = one race, N seats), so the
  // confirmation names the drivers the guest just chose rather than repeating
  // "Race · Blue Track". Read straight off assignMap, so it reflects the final
  // state including any changes made after auto-fill.
  const raceLineup = (() => {
    const byKey = new Map<
      string,
      { key: string; label: string; track: string | null; timeLabel: string; names: string[] }
    >();
    const order: string[] = [];
    for (const s of openRaceSlots) {
      const memberId = assignMap[s.slotKey];
      if (!memberId) continue;
      const member = session.party.find((m) => m.id === memberId);
      if (!member) continue;
      const key = `${s.heatId}|${s.productId ?? ""}|${s.classLabel}`;
      let row = byKey.get(key);
      if (!row) {
        row = { key, label: s.classLabel, track: s.track, timeLabel: s.timeLabel, names: [] };
        byKey.set(key, row);
        order.push(key);
      }
      row.names.push(racerName(member));
    }
    return order.map((k) => byKey.get(k)!);
  })();

  const clearRace = (slotKey: string) =>
    setAssignMap((prev) => {
      const next = { ...prev };
      delete next[slotKey];
      return next;
    });

  // Fired by the "Next: who's racing" tap rather than by an effect on `stage`:
  // auto-fill is an EVENT (the guest arriving at the step), not a state
  // synchronisation, so doing it in the handler avoids a cascading render and
  // keeps the proposal computed from the party as it stood at that moment.
  // Ref-gated: coming BACK from the assign step must not re-fill races the
  // guest deliberately cleared.
  const autoFillDoneRef = useRef(false);
  const [autoFilled, setAutoFilled] = useState(false);
  const goToAssign = () => {
    if (!autoFillDoneRef.current) {
      autoFillDoneRef.current = true;
      const proposal = autoAssignRaces({
        slots: openRaceSlots,
        members: readyMembers.map((m) => ({ id: m.id, category: resolveRaceClass(m) })),
        conflicts: raceSlotsConflict,
      });
      const fresh = Object.entries(proposal).filter(([slotKey]) => !assignMap[slotKey]);
      if (fresh.length > 0) {
        setAssignMap((prev) => {
          const next = { ...prev };
          for (const [slotKey, memberId] of fresh) if (!next[slotKey]) next[slotKey] = memberId;
          return next;
        });
        setAutoFilled(true);
      }
    }
    setStage("assign");
  };

  // "Check everyone in": attach any newly-added party first, then finalize
  // (schedule onto the session + Confirmation Kiosk state + memo) in one tap.
  const checkInEveryone = async () => {
    if (!proofToken || binding) return;
    setBinding(true);
    setBindMsg(null);

    /**
     * Pick the id each ASSIGNED racer will be scheduled under. NO MINTING HERE.
     *
     * This block used to mint a person for a returning racer who had only a
     * 17-digit Office id, on the stated assumption that "pandoraCreatePerson is
     * upsert (a known person resolves to the SAME id), so this never
     * duplicates." That was true of the Pandora rail. It is FALSE under
     * cloud-first (2026-08-12): the mint route now calls createOfficePerson,
     * which ALWAYS creates a brand-new person — so every such racer got a
     * DUPLICATE, and the duplicate is the one that carried no waiver.
     *
     * Caught live on W59931: "Test 5." held person …163524 (waiver 58557849) and
     * a minted twin …163528 with waiverExpiry null. The party-ready gate checked
     * the twin, found no waiver, and the check-in state could never flip — while
     * the duplicate row is exactly the shape that jams Fast WSync.
     *
     * So we use the id the racer ALREADY has. The 17-digit worry that justified
     * minting ("/bmi/schedule 500s on an Office id") is handled where it belongs:
     * completeCheckin posts short ids and Office ids in SEPARATE batches, so if
     * Pandora refuses the Office-id batch only those racers are affected and they
     * land in the staff memo. An unseated racer the desk is told about beats a
     * duplicate person nobody knows exists.
     */
    const assignedMemberIds = new Set(Object.values(assignMap));
    const shortIds = new Map<string, string>();
    for (const m of session.party) {
      if (!assignedMemberIds.has(m.id)) continue;
      const existing = m.pandoraPersonId || m.bmiPersonId;
      if (existing) shortIds.set(m.id, existing);
    }
    const shortIdFor = (m: PartyMember): string | null =>
      shortIds.get(m.id) ?? m.pandoraPersonId ?? null;

    if (unboundReady.length > 0) {
      const members: CheckinBindMember[] = unboundReady.map((m) => ({
        bmiPersonId: m.bmiPersonId as string,
        pandoraPersonId: shortIdFor(m),
        firstName: m.firstName,
        lastName: m.lastName,
        waiverValid: !!m.waiverValid,
      }));
      const b = await bindParty(center, proofToken, members, config ? kioskId(config) : undefined);
      if (!b.ok) {
        setBinding(false);
        setBindMsg(t("checkin.err.addFail"));
        return;
      }
      setBoundIds((prev) => new Set([...prev, ...unboundReady.map((m) => m.id)]));
    }
    const assignments: CheckinSlotAssignment[] = Object.entries(assignMap)
      .map(([slotKey, memberId]): CheckinSlotAssignment | null => {
        const m = session.party.find((p) => p.id === memberId);
        if (!m) return null;
        const personId = shortIdFor(m) ?? m.bmiPersonId;
        if (!personId) return null;
        return { slotKey, personId, category: resolveRaceClass(m) };
      })
      .filter((x): x is CheckinSlotAssignment => x !== null);
    const c = await completeCheckin(
      center,
      proofToken,
      config ? kioskId(config) : undefined,
      assignments,
    );
    setBinding(false);
    if (!c.ok) {
      setBindMsg(c.reason === "busy" ? t("checkin.err.finishing") : t("checkin.err.checkinFail"));
      return;
    }
    setComplete(c);
    setStage("done");
  };

  // Auto-reset the done screen back to attract — deferred while a lane-open POST
  // is in flight (binding), and the timer restarts whenever busy clears.
  useEffect(() => {
    if (stage !== "done" || binding) return;
    const t = setTimeout(goHome, DONE_RESET_MS);
    return () => clearTimeout(t);
  }, [stage, binding, goHome]);

  // Opening a row. An EXPRESS row short-circuits to the info modal and stops
  // there — that party has every racer resolved with a waiver on file, so they
  // don't check in here and we must not text them a code. Everyone else proves
  // the booking is theirs with the last 4 of the number on file first, so a tap
  // can't blind-OTP an arbitrary guest.
  const openRow = async (row: CheckinBrowseRow) => {
    setError(null);
    if (row.express) {
      setExpressFor({ label: row.label, timeLabel: row.timeLabel });
      return;
    }
    // Test kiosk 99: try the server's env-allowlisted bypass first — a row
    // opens with no last-4 and no OTP. Any refusal (env unset, expired ref)
    // falls through to the normal verify path.
    if (isTestKiosk(config) && config) {
      setBusy(true);
      const direct = await lookupByRefBypass(center, row.ref, kioskId(config));
      setBusy(false);
      if (direct.ok && direct.matches?.[0]) {
        void openItinerary(direct.matches[0].proofToken);
        return;
      }
    }
    setPendingRef(row.ref);
    setLast4("");
    setStage("browse-verify");
  };

  const verifyLast4AndSend = async () => {
    if (!pendingRef || last4.replace(/\D/g, "").length < 4) return;
    setBusy(true);
    setError(null);
    const res = await sendContactOtp(center, pendingRef, last4);
    setBusy(false);
    if (!res.ok) {
      setError(
        res.reason === "mismatch"
          ? t("checkin.err.last4Mismatch")
          : res.reason === "rate-limited"
            ? t("checkin.err.codeJustSent")
            : res.reason === "no-contact"
              ? t("checkin.err.noPhone")
              : t("checkin.err.sendCodeFail"),
      );
      return;
    }
    setOtpMask(res.mask ?? t("checkin.otpMaskFallback"));
    setOtp("");
    setStage("browse-otp");
  };

  const onScan = async (raw: string) => {
    setBusy(true);
    setError(null);
    const res = await lookupByScan(center, raw, venue);
    setBusy(false);
    // A signed link opens directly; an enumerable code/W# comes back as an
    // OTP-gated row → run the same text-a-code-to-the-contact flow as browse.
    if (res.ok && res.matches && res.matches[0]) {
      void openItinerary(res.matches[0].proofToken);
      return;
    }
    if (res.ok && res.rows && res.rows[0]) {
      void openRow(res.rows[0]);
      return;
    }
    setError(
      res.reason === "cancelled"
        ? t("checkin.err.cancelled")
        : res.reason === "bowling-elsewhere"
          ? t("checkin.bowl.wrongVenue")
          : t("checkin.err.codeNotFound"),
    );
  };

  const wedge = useWedgeScan(onScan);

  // Arrived here from a scan on the attract screen or the category chooser:
  // replay it through the SAME path a scan on the find screen takes, so the
  // guest skips straight to their itinerary (or the OTP row) without being
  // asked to scan again. Waits for config — `center` drives the lookup and
  // defaults to fort-myers before hydration. Ref-guarded against StrictMode.
  const entryScanRef = useRef(false);
  useEffect(() => {
    if (entryScanRef.current || !hydrated || !config) return;
    entryScanRef.current = true;
    const handoff = consumeEntryScan("checkin");
    // Deferred a microtask: onScan sets busy/error synchronously before its
    // first await, and an effect body must stay setState-free (hooks-lint).
    if (handoff) void Promise.resolve().then(() => onScan(handoff.raw));
    // onScan is redefined every render; the ref guard is the real gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, config]);

  const sendPhone = async () => {
    if (phone.replace(/\D/g, "").length < 10) {
      setError(t("checkin.err.enterMobile"));
      return;
    }
    setBusy(true);
    setError(null);
    // Test kiosk 99: skip the own-phone OTP when the server's env allowlist
    // agrees — the lookup answers directly. A needs-otp refusal (env unset)
    // falls through to the normal text-a-code flow.
    if (isTestKiosk(config) && config) {
      const direct = await lookupByPhone(center, phone, kioskId(config), venue);
      if (direct.ok && direct.matches && direct.matches.length > 0) {
        setBusy(false);
        if (direct.matches.length === 1) {
          void openItinerary(direct.matches[0].proofToken);
          return;
        }
        setMatches(direct.matches);
        setStage("matches");
        return;
      }
      if (
        direct.ok === false &&
        (direct.reason === "not-found" || direct.reason === "bowling-elsewhere")
      ) {
        setBusy(false);
        setError(
          direct.reason === "bowling-elsewhere"
            ? t("checkin.bowl.wrongVenue")
            : t("checkin.err.noReservations"),
        );
        return;
      }
    }
    const sent = await sendOwnPhoneOtp(phone);
    setBusy(false);
    if (!sent) {
      setError(t("checkin.err.textFail"));
      return;
    }
    setOtp("");
    setStage("phone-otp");
  };

  const verifyPhone = async () => {
    setBusy(true);
    setError(null);
    const v = await verifyOwnPhoneOtp(phone, otp);
    if (!v.verified) {
      setBusy(false);
      setError(
        v.attemptsLeft && v.attemptsLeft > 0
          ? t("checkin.err.incorrectTries", { count: v.attemptsLeft })
          : t("checkin.err.codeFailNew"),
      );
      return;
    }
    const res = await lookupByPhone(center, phone, undefined, venue);
    setBusy(false);
    if (!res.ok || !res.matches || res.matches.length === 0) {
      setError(
        res.reason === "bowling-elsewhere"
          ? t("checkin.bowl.wrongVenue")
          : t("checkin.err.noReservations"),
      );
      return;
    }
    if (res.matches.length === 1) {
      void openItinerary(res.matches[0].proofToken);
      return;
    }
    setMatches(res.matches);
    setStage("matches");
  };

  const openBrowse = async () => {
    setBusy(true);
    setError(null);
    const res = await lookupBrowse(center, venue);
    setBusy(false);
    setRows(res.rows ?? []);
    setStage("browse");
  };

  const verifyBrowseOtp = async () => {
    if (!pendingRef) return;
    setBusy(true);
    setError(null);
    const res = await confirmContactOtp(center, pendingRef, otp);
    setBusy(false);
    if (!res.ok || !res.proofToken) {
      setError(
        res.attemptsLeft && res.attemptsLeft > 0
          ? t("checkin.err.incorrectLeft", { count: res.attemptsLeft })
          : t("checkin.err.codeFailBack"),
      );
      return;
    }
    void openItinerary(res.proofToken);
  };

  const back = () => {
    setError(null);
    if (stage === "phone-otp") setStage("find");
    else if (stage === "matches") setStage("find");
    else if (stage === "browse") setStage("find");
    else if (stage === "browse-verify") setStage("browse");
    else if (stage === "browse-otp") setStage("browse-verify");
    else if (stage === "bowling") {
      // Mirror the forward path: racing combos came from assign, other combos
      // from party, bowling-only straight from the itinerary.
      if (openRaceSlots.length > 0) setStage("assign");
      else if (!bowlingOnly) setStage("party");
      else setStage("itinerary");
    } else if (stage === "assign") setStage("party");
    else if (stage === "party") setStage("itinerary");
    else if (stage === "itinerary") {
      setItinerary(null);
      setStage("find");
    } else goHome();
  };

  if (!hydrated || !config) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[#000418]">
        <BrandedLoader brand="fasttrax" label={t("checkin.loading")} />
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-[#000418]">
      <IdleWatcher
        timeoutMs={IDLE_MS}
        paused={busy || peopleBusy || binding || bowlSaving}
        onReset={goHome}
      />

      {/* The kiosk's QR reader is a SERIAL (COM-port) device — it never types
          keystrokes, so the wedge hook alone hears nothing from it. Mounted
          only on the find/list stages: serial opens are exclusive, and the
          party stage's people monolith needs the port for its license scanner. */}
      {(stage === "find" || stage === "matches" || stage === "browse") && (
        <CheckinScanListener
          onScan={(raw) => {
            if (!busy) void onScan(raw);
          }}
          onLicenseLike={() =>
            setError(
              "That looks like a driver's license — scan the QR code from your confirmation email or text instead.",
            )
          }
          onListeningChange={setScanListening}
        />
      )}

      {/* Header */}
      <div className="flex shrink-0 items-center gap-[24px] border-b border-white/10 px-[48px] py-[32px]">
        {/* Locked mid-submit: the assignments have already gone to the server,
            so walking back would leave the screen disagreeing with what is
            actually being written to the grid. */}
        <button
          type="button"
          onClick={back}
          disabled={binding || bowlSaving}
          className="k-tap flex h-[88px] items-center gap-[8px] rounded-2xl border-2 border-white/15 px-[28px] text-[28px] font-bold text-white/70 disabled:opacity-40"
        >
          <IconChevronLeft size={36} aria-hidden="true" />
          {stage === "find" ? t("checkin.home") : t("checkin.back")}
        </button>
        <div className="min-w-0 flex-1">
          <div className="k-eyebrow text-[#00e2e5]">{t("checkin.eyebrow")}</div>
          <div className="k-display truncate text-[52px]">
            {stage === "done"
              ? t("checkin.doneTitle")
              : stage === "assign"
                ? t("checkin.assignTitle")
                : stage === "bowling"
                  ? t("checkin.bowl.title")
                  : stage === "party"
                    ? t("checkin.addGroup.eyebrow")
                    : stage === "itinerary" && itinerary
                      ? t("checkin.welcomeBack", {
                          name: itinerary.firstName || t("checkin.friend"),
                        })
                      : t("checkin.findReservation")}
          </div>
        </div>
        <IconUserCheck size={56} className="shrink-0 text-white/25" aria-hidden="true" />
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-[48px] py-[40px]">
        {error && (
          <div className="mb-[24px] rounded-2xl border-2 border-[#e94141]/40 bg-[#e94141]/10 px-[32px] py-[24px] text-[28px] text-[#ffb4b4]">
            {error}
          </div>
        )}

        {(busy || binding) && (
          <div className="mb-[24px] flex justify-center">
            <BrandedLoader
              brand={config.brand}
              label={binding ? t("checkin.puttingOnGrid") : t("checkin.oneMoment")}
            />
          </div>
        )}

        {stage === "find" && (
          <FindScreen
            phone={phone}
            onPhone={setPhone}
            onSendPhone={sendPhone}
            scanArmed={wedge.armed}
            scanReady={scanListening}
            onArmScan={wedge.arm}
            onBrowse={openBrowse}
          />
        )}

        {stage === "browse-verify" && (
          <div className="k-glass mx-auto max-w-[720px] p-[48px] text-center">
            <div className="k-eyebrow text-[#00e2e5]">{t("checkin.verify.eyebrow")}</div>
            <div className="k-display mt-[8px] text-[40px]">{t("checkin.verify.title")}</div>
            <p className="mt-[12px] text-[28px] text-white/55">{t("checkin.verify.blurb")}</p>
            <input
              type="tel"
              inputMode="numeric"
              value={last4}
              onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="••••"
              aria-label={t("checkin.verify.aria")}
              className="my-[32px] h-[120px] w-full rounded-2xl border-2 border-white/15 bg-white/5 text-center text-[64px] tracking-[0.5em] text-white placeholder:text-white/20"
            />
            <button
              type="button"
              onClick={verifyLast4AndSend}
              disabled={last4.length < 4}
              className="k-btn-primary k-tap h-[96px] w-full text-[34px] disabled:opacity-40"
            >
              {t("checkin.find.textCode")}
            </button>
          </div>
        )}

        {(stage === "phone-otp" || stage === "browse-otp") && (
          <OtpScreen
            code={otp}
            onCode={setOtp}
            mask={stage === "phone-otp" ? formatPhoneMask(phone) : otpMask}
            onVerify={stage === "phone-otp" ? verifyPhone : verifyBrowseOtp}
          />
        )}

        {stage === "matches" && (
          <div className="space-y-[16px]">
            <p className="text-[28px] text-white/55">{t("checkin.matches.prompt")}</p>
            {matches.map((m) => (
              <button
                key={m.proofToken}
                type="button"
                onClick={() => openItinerary(m.proofToken)}
                className="k-glass k-tap flex w-full items-center gap-[28px] p-[28px] text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="k-display truncate text-[38px]">{m.label}</div>
                  <div className="mt-[6px] text-[26px] text-white/55">{m.activitiesLabel}</div>
                </div>
                <div className="k-display text-[40px] text-[#00e2e5]">{m.timeLabel}</div>
                <IconChevronRight size={40} className="shrink-0 text-white/30" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}

        {stage === "browse" && (
          <div className="space-y-[16px]">
            <p className="text-[28px] text-white/55">
              {t("checkin.browse.prompt")} {t("checkin.browse.expressHint")}
            </p>
            {rows.length === 0 ? (
              <div className="k-glass p-[48px] text-center">
                <div className="k-display text-[40px]">{t("checkin.browse.emptyTitle")}</div>
                <p className="mx-auto mt-[12px] max-w-[34ch] text-[26px] text-white/50">
                  {t("checkin.browse.emptyBody")}
                </p>
              </div>
            ) : (
              rows.map((r) => (
                // One tap target per card. The Express badge is DECORATIVE (a
                // span, not a button) — it only marks reservations that really
                // are express, and tapping anywhere on such a row opens the
                // "you're already set" modal instead of starting check-in. No
                // nested button, so no pointer-events overlay needed.
                <button
                  key={r.ref}
                  type="button"
                  onClick={() => void openRow(r)}
                  aria-label={
                    r.express
                      ? t("checkin.express.pillAria", { label: r.label, time: r.timeLabel })
                      : t("checkin.browse.openAria", { label: r.label, time: r.timeLabel })
                  }
                  className="k-glass k-tap flex w-full items-center gap-[28px] p-[28px] text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="k-display truncate text-[38px]">{r.label}</div>
                    <div className="mt-[6px] flex items-center gap-[14px] text-[26px] text-white/55">
                      <span>{r.activitiesLabel}</span>
                      {/* VIP pill — decorative like Express, gold to match the
                          admin board/scanner ★ VIP badges (#d4af37). Driven by
                          the booking's own combo stamp (per-record truth). */}
                      {r.vip && (
                        <span className="flex items-center gap-[8px] rounded-full border-2 border-[#d4af37]/60 bg-[#d4af37]/15 px-[18px] py-[6px] text-[22px] font-bold text-[#d4af37]">
                          <IconStarFilled size={20} aria-hidden="true" />
                          {t("checkin.vip.pill")}
                        </span>
                      )}
                      {r.express && (
                        <span className="flex items-center gap-[8px] rounded-full border-2 border-[#46d68c]/60 bg-[#46d68c]/15 px-[18px] py-[6px] text-[22px] font-bold text-[#46d68c]">
                          <IconBolt size={22} aria-hidden="true" />
                          {t("checkin.express.pill")}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="k-display text-[40px] text-[#00e2e5]">{r.timeLabel}</div>
                  <IconChevronRight
                    size={40}
                    className="shrink-0 text-white/30"
                    aria-hidden="true"
                  />
                </button>
              ))
            )}
          </div>
        )}

        {/* Page 1 — the itinerary (no keyboard); "Continue" → the sign-in page.
            Express Lane (reached by phone lookup or a scanned QR, where the code
            is already spent) ends here instead: nothing to check in, so show
            where to go rather than walking them through the party panel. */}
        {stage === "itinerary" && itinerary && (
          <div className="space-y-[32px]">
            <ItineraryScreen
              itinerary={itinerary}
              readyOverride={
                prefillRoster
                  ? prefillRoster.filter((r) => r.bmiPersonId && r.waiverValid).length
                  : null
              }
            />
            {itinerary.express ? (
              <div className="k-glass border-[#46d68c]/50 p-[40px] text-center">
                <ExpressLaneBody />
                <button
                  type="button"
                  onClick={goHome}
                  className="k-btn-primary k-tap mt-[36px] h-[104px] w-full text-[34px]"
                >
                  {t("checkin.gotIt")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                // Bowling-only skips the party step entirely — bowling needs no
                // account and no waiver (owner 2026-08-16); the guest goes
                // straight to bowler details. Everything else keeps the party
                // (waiver/sign-in) step first.
                onClick={() =>
                  setStage(
                    bowlingOnly && bowlingDetailActivities.length > 0 ? "bowling" : "party",
                  )
                }
                className="k-btn-primary k-tap h-[112px] w-full text-[36px]"
              >
                {t("checkin.continue")}
              </button>
            )}
          </div>
        )}

        {/* Page 2 — add your group + sign in (the keyboard lives on this page,
            so the itinerary above is never covered). */}
        {stage === "party" && itinerary && (
          <div>
            {/* The roster is a two-hop BMI lookup plus a live Pandora waiver
                read per person — 7.7–15.5s on real reservations. While it runs
                the loader REPLACES the step: rendering it above the people list
                showed a spinner over a full set of "add someone" controls,
                which reads as broken rather than busy and invites a tap the
                arriving roster then overwrites (owner 2026-08-07: "none of this
                should be shown till that looking for group is done"). Only
                while the list is still EMPTY — once anyone has landed, a
                spinner over a populated roster reads as a fault. */}
            {rosterLoading && session.party.length === 0 ? (
              <BrandedLoader brand="fasttrax" label={t("checkin.roster.loading")} />
            ) : (
              <>
                <p className="mb-[20px] text-[26px] text-white/55">{t("checkin.addGroup.body")}</p>
                {rosterDegraded && (
                  <div className="mb-[20px] rounded-2xl border-2 border-[#f0b341]/40 bg-[#f0b341]/10 px-[28px] py-[20px] text-[24px] leading-snug text-[#f0b341]">
                    {t("checkin.roster.degraded")}
                  </div>
                )}
                {/* No "Load your party" bar. Everyone the booking knows is already
                IN the list above (owner 2026-08-07: "why does the yellow box
                still need to exist why not just load them?"). The people who
                still need an account or a waiver appear as their own rows with
                a "Set up" button — the roster says it better than a banner
                could, and the ticked/unticked state carries who is checking in. */}
                <PeopleScreens
                  item={checkinItem}
                  session={session}
                  onChange={(patch) => setCheckinItem((prev) => ({ ...prev, ...patch }))}
                  dispatch={dispatch}
                  setBusy={setPeopleBusy}
                />

                {bindMsg && (
                  <div className="mt-[20px] rounded-2xl border-2 border-[#e94141]/40 bg-[#e94141]/10 px-[28px] py-[20px] text-[26px] text-[#ffb4b4]">
                    {bindMsg}
                  </div>
                )}

                {/* Racing → the dedicated "Who's racing?" step; a reservation
                with HeadPinz bowling → bowler details next; otherwise finalize.
                peopleBusy gates ALL: a sign-in lookup / waiver check still in
                flight means the roster isn't settled yet — advancing early let a
                guest skip past their own account resolving. */}
                {openRaceSlots.length > 0 ? (
                  <button
                    type="button"
                    onClick={goToAssign}
                    disabled={partyNeedsSetup || nobodyIncluded || peopleBusy}
                    className="k-btn-primary k-tap mt-[24px] h-[112px] w-full text-[36px] disabled:opacity-40"
                  >
                    {t("checkin.nextWhosRacing")}
                  </button>
                ) : bowlingDetailActivities.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setStage("bowling")}
                    disabled={partyNeedsSetup || nobodyIncluded || peopleBusy}
                    className="k-btn-primary k-tap mt-[24px] h-[112px] w-full text-[36px] disabled:opacity-40"
                  >
                    {t("checkin.bowl.next")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={checkInEveryone}
                    disabled={binding || partyNeedsSetup || nobodyIncluded || peopleBusy}
                    className="k-btn-primary k-tap mt-[24px] h-[112px] w-full text-[36px] disabled:opacity-40"
                  >
                    {binding ? t("checkin.checkingIn") : t("checkin.checkEveryone")}
                  </button>
                )}
                {(partyNeedsSetup || nobodyIncluded) && (
                  <p className="mt-[12px] text-center text-[24px] text-white/45">
                    {nobodyIncluded ? t("checkin.needSomeone") : t("checkin.finishAddingFirst")}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {stage === "assign" && itinerary && (
          <RaceAssignScreen
            slots={openRaceSlots}
            party={readyMembers}
            assignMap={assignMap}
            onAssign={assignRace}
            onClear={clearRace}
            // A reservation with HeadPinz bowling collects bowler details LAST,
            // then finalizes from that screen; racing-only finalizes here.
            onCheckIn={
              bowlingDetailActivities.length > 0 ? () => setStage("bowling") : checkInEveryone
            }
            checkInLabel={
              bowlingDetailActivities.length > 0 ? t("checkin.bowl.next") : undefined
            }
            onBackToParty={() => setStage("party")}
            autoFilled={autoFilled}
            binding={binding}
            bindMsg={bindMsg}
          />
        )}

        {stage === "bowling" && itinerary && (
          <CheckinBowlingDetails
            activities={bowlingDetailActivities.map((a) => ({
              neonReservationId: a.neonReservationId,
              title: a.title,
              timeLabel: a.timeLabel,
              totalCount: a.totalCount,
            }))}
            requireName={bowlingOnly}
            finishing={binding}
            finishError={bindMsg}
            onFinish={checkInEveryone}
            onBusyChange={setBowlSaving}
          />
        )}

        {stage === "done" && itinerary && (
          <DoneScreen
            itinerary={itinerary}
            complete={complete}
            raceLineup={raceLineup}
            atFtKiosk={atFtKiosk}
            onFinish={goHome}
            onBusyChange={setBinding}
          />
        )}
      </div>

      {expressFor && <ExpressLaneModal booking={expressFor} onClose={() => setExpressFor(null)} />}
    </div>
  );
}

// ── Express lane ─────────────────────────────────────────────────────────────
/** The one copy of the express-lane message — shared by the browse-row modal and
 *  the itinerary panel so they can never say different things. Destination is
 *  Race Check-In (matching the eTicket, the race-day email and RacingWhatsNext),
 *  NOT "the pits".
 *
 *  i18n note: the old single-paragraph body was left English because its inline
 *  <strong> spans made it rich text the plain-string engine can't render. Split
 *  into three WHOLE sentences plus one standalone place name, each key is a
 *  complete translatable unit and the emphasis wraps a whole key — so EN and ES
 *  are both fully localized with no half-translated paragraph. */
function ExpressLaneBody(props: { titleId?: string }) {
  const t = useT();
  return (
    <>
      <div
        className="mx-auto mb-[24px] flex h-[120px] w-[120px] items-center justify-center rounded-full border-[3px] border-[#46d68c] bg-[#46d68c]/15"
        aria-hidden="true"
      >
        <IconBolt size={64} className="text-[#46d68c]" />
      </div>
      <div id={props.titleId} className="k-display text-[48px]">
        {t("checkin.express.title")}
      </div>
      <p className="mt-[20px] text-[30px] leading-[1.4] text-white/70">
        <span className="font-bold text-white">{t("checkin.express.bodyNothing")}</span>{" "}
        {t("checkin.express.bodyWhere")}{" "}
        <span className="font-bold text-white">{t("checkin.express.bodyPlace")}</span>.{" "}
        {t("checkin.express.bodyWhen")}
      </p>
    </>
  );
}

/** Express-lane modal — what a tapped EXPRESS browse row opens INSTEAD of the
 *  last-4 gate and the OTP. Informational: no lookup, no text, no check-in. */
function ExpressLaneModal(props: {
  booking: { label: string; timeLabel: string };
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center p-[48px]">
      <button
        type="button"
        aria-label={t("checkin.close")}
        onClick={props.onClose}
        className="absolute inset-0 bg-black/70"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="express-title"
        className="k-glass relative z-10 max-w-[760px] p-[48px] text-center"
      >
        <ExpressLaneBody titleId="express-title" />
        <p className="mt-[20px] text-[28px] text-white/45">
          {props.booking.label} · {props.booking.timeLabel}
        </p>
        <button
          type="button"
          onClick={props.onClose}
          className="k-btn-primary k-tap mt-[36px] h-[104px] w-full text-[34px]"
        >
          {t("checkin.gotIt")}
        </button>
      </div>
    </div>
  );
}

// TODO(i18n): module-scope helper (no hook access) — the "your number" fallback
// stays English until phone-mask formatting is threaded through the locale.

// ── Serial QR-scanner listener ───────────────────────────────────────────────
/** Quiet gap that ends one physical scan's line burst (mirrors useLicenseScan). */
const SCAN_BURST_QUIET_MS = 350;

/**
 * The kiosk's QR reader is a COM-port device driven over Web Serial
 * (useQrScanner, the same saved model/baud/port plumbing as the license
 * scanner) — it never types keystrokes, so the keyboard-wedge hook alone hears
 * nothing from it. Mount this ONLY while a find/list stage is showing: serial
 * opens are exclusive, and the party stage's people monolith needs the port
 * for its own license listener. Lines are regrouped over a short quiet gap —
 * a reservation QR is ONE line; a driver's license bursts ~35 lines and is
 * flagged once instead of spamming lookups.
 */
function CheckinScanListener(props: {
  onScan: (raw: string) => void;
  onLicenseLike: () => void;
  onListeningChange: (listening: boolean) => void;
}) {
  const { config } = useKioskConfig();
  const linesRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  }, [props]);

  const scanner = useQrScanner({
    enabled: !!config?.qrScannerEnabled,
    modelId: config?.qrScannerModel,
    baudRate: config?.qrScannerBaud ?? null,
    portInfo: config?.qrScannerPortInfo ?? null,
    // Strict saved-ids matching only — the MSR + dispenser share this origin's grants.
    allowLoneGrantFallback: false,
    onScan: (scan) => {
      linesRef.current.push(scan.payload);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const lines = linesRef.current;
        linesRef.current = [];
        if (lines.length === 1) propsRef.current.onScan(lines[0]);
        else if (lines.length > 1) propsRef.current.onLicenseLike();
      }, SCAN_BURST_QUIET_MS);
    },
  });

  const listening = scanner.connection.state === "listening";
  useEffect(() => {
    propsRef.current.onListeningChange(listening);
  }, [listening]);
  // Leaving the stage: never fire a half-collected burst, and report the port
  // released so the find tile stops showing "ready".
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      propsRef.current.onListeningChange(false);
    };
  }, []);

  return null;
}

function formatPhoneMask(phone: string): string {
  const d = phone.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : "your number";
}

// ── Find ────────────────────────────────────────────────────────────────────
function FindScreen(props: {
  phone: string;
  onPhone: (v: string) => void;
  onSendPhone: () => void;
  scanArmed: boolean;
  /** Serial scanner holds the port — scans work with no arming tap needed. */
  scanReady: boolean;
  onArmScan: () => void;
  onBrowse: () => void;
}) {
  const t = useT();
  return (
    <div className="space-y-[28px]">
      {/* Phone — primary */}
      <div className="k-glass p-[40px]">
        <div className="mb-[20px] flex items-center gap-[20px]">
          <IconDeviceMobile size={44} className="text-[#00e2e5]" aria-hidden="true" />
          <div className="k-display text-[40px]">{t("checkin.find.usePhone")}</div>
        </div>
        <p className="mb-[20px] text-[26px] text-white/55">{t("checkin.find.phoneBlurb")}</p>
        <input
          type="tel"
          inputMode="tel"
          value={props.phone}
          onChange={(e) => props.onPhone(e.target.value)}
          placeholder="(239) 555-0123"
          aria-label={t("checkin.find.phoneAria")}
          className="mb-[20px] h-[104px] w-full rounded-2xl border-2 border-white/15 bg-white/5 px-[32px] text-[44px] text-white placeholder:text-white/25"
        />
        <button
          type="button"
          onClick={props.onSendPhone}
          className="k-btn-primary k-tap h-[96px] w-full text-[34px]"
        >
          {t("checkin.find.textCode")}
        </button>
      </div>

      {/* Scan + Browse */}
      <div className="grid grid-cols-2 gap-[24px]">
        <button
          type="button"
          onClick={props.onArmScan}
          className={`k-glass k-tap flex flex-col items-center justify-center gap-[16px] p-[40px] text-center ${
            props.scanArmed || props.scanReady ? "border-[#00e2e5]/60" : ""
          }`}
        >
          <IconScan size={56} className="text-[#e94141]" aria-hidden="true" />
          <div className="k-display text-[32px]">
            {props.scanArmed || props.scanReady
              ? t("checkin.find.scanNow")
              : t("checkin.find.scanMyCode")}
          </div>
          <div className="text-[24px] text-white/50">{t("checkin.find.scanSub")}</div>
        </button>
        <button
          type="button"
          onClick={props.onBrowse}
          className="k-glass k-tap flex flex-col items-center justify-center gap-[16px] p-[40px] text-center"
        >
          <IconListSearch size={56} className="text-[#a78bfa]" aria-hidden="true" />
          <div className="k-display text-[32px]">{t("checkin.find.findBooking")}</div>
          <div className="text-[24px] text-white/50">{t("checkin.find.findSub")}</div>
        </button>
      </div>
    </div>
  );
}

// ── OTP ───────────────────────────────────────────────────────────────────────
function OtpScreen(props: {
  code: string;
  onCode: (v: string) => void;
  mask: string;
  onVerify: () => void;
}) {
  const t = useT();
  return (
    <div className="k-glass mx-auto max-w-[720px] p-[48px] text-center">
      <div className="k-eyebrow text-[#00e2e5]">{t("checkin.otp.verify")}</div>
      <div className="k-display mt-[8px] text-[44px]">
        {t("checkin.otp.textedTo", { mask: props.mask })}
      </div>
      <p className="mt-[12px] text-[28px] text-white/55">{t("checkin.otp.enterCode")}</p>
      <input
        type="tel"
        inputMode="numeric"
        value={props.code}
        onChange={(e) => props.onCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="••••••"
        aria-label={t("checkin.otp.aria")}
        className="my-[32px] h-[120px] w-full rounded-2xl border-2 border-white/15 bg-white/5 text-center text-[64px] tracking-[0.4em] text-white placeholder:text-white/20"
      />
      <button
        type="button"
        onClick={props.onVerify}
        disabled={props.code.length < 6}
        className="k-btn-primary k-tap h-[96px] w-full text-[34px] disabled:opacity-40"
      >
        {t("checkin.otp.openDay")}
      </button>
    </div>
  );
}

// ── Itinerary ──────────────────────────────────────────────────────────────────
function ItineraryScreen(props: { itinerary: CheckinItinerary; readyOverride: number | null }) {
  const { itinerary, readyOverride } = props;
  const t = useT();
  return (
    <div className="space-y-[24px]">
      {itinerary.firstStop && (
        <div className="k-glass flex items-center gap-[24px] border-[#00e2e5]/40 p-[32px]">
          <IconMapPin size={48} className="shrink-0 text-[#00e2e5]" aria-hidden="true" />
          <div className="min-w-0">
            <div className="k-eyebrow text-[#00e2e5]">{t("checkin.itin.firstStop")}</div>
            <div className="k-display text-[36px]">{itinerary.firstStop.building}</div>
            {itinerary.firstStop.arriveByLabel && (
              <div className="text-[28px] text-white/60">
                {t("checkin.itin.arriveBy", { label: itinerary.firstStop.arriveByLabel })}
              </div>
            )}
          </div>
        </div>
      )}

      {itinerary.activities.map((a, i) => (
        <div key={`${a.kind}-${i}`} className="k-glass relative overflow-hidden p-[32px] pl-[44px]">
          <span
            className="absolute inset-y-0 left-0 w-[12px]"
            style={{ background: ACCENT[a.kind] }}
            aria-hidden="true"
          />
          <div className="flex items-center gap-[24px]">
            <div className="min-w-0 flex-1">
              <div className="k-display text-[40px]">{a.title}</div>
              <div className="mt-[6px] text-[28px] text-white/55">{a.building}</div>
              {/* The server builds this roster from the booking's own racer
                  labels, which carry no person id, so racing readiness is
                  hardcoded 0 and reads "0 of 2 racers ready" even for people
                  who ARE registered with live waivers. Resolving that needs the
                  BMI project (7–15s) — far too slow for the first screen — so
                  the count self-corrects the moment the party roster lands. */}
              <ReadinessChip
                activity={
                  a.kind === "racing" && readyOverride !== null
                    ? { ...a, readyCount: Math.min(readyOverride, a.totalCount) }
                    : a
                }
              />
            </div>
            <div className="k-display text-[44px] text-white">{a.timeLabel}</div>
          </div>
        </div>
      ))}

      {itinerary.dueAtCenterCents > 0 && (
        <div className="k-glass border-[#f0b341]/40 p-[28px] text-[28px] text-[#f0b341]">
          {t("checkin.itin.dueAtDesk", {
            amount: `$${(itinerary.dueAtCenterCents / 100).toFixed(2)}`,
          })}
        </div>
      )}

      {/* Who's already on the reservation — identified people only (unfilled
          slots are handled in the "Who's racing?" step, never shown here). */}
      {itinerary.roster.length > 0 && (
        <div>
          <div className="k-eyebrow mb-[14px] text-white/40">{t("checkin.itin.alreadyOn")}</div>
          <div className="flex flex-wrap gap-[12px]">
            {itinerary.roster.map((p, i) => (
              <span
                key={`${p.personId ?? p.displayName}-${i}`}
                className="flex items-center gap-[10px] rounded-2xl border-2 border-white/15 bg-white/5 px-[22px] py-[14px] text-[26px] text-white"
              >
                <IconUserCheck
                  size={28}
                  className={p.waiverValid ? "text-[#46d68c]" : "text-white/30"}
                  aria-hidden="true"
                />
                {p.displayName}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Who's racing? (its own step — one card per booked race + a racer picker) ──
// TODO(i18n): module-scope helper (no hook access) — the "Racer" fallback stays
// English until this is threaded through the locale.
function racerName(m: PartyMember): string {
  return `${m.firstName}${m.lastName ? ` ${m.lastName}` : ""}`.trim() || "Racer";
}

/** Web booking's per-racer heat-spacing rules, applied to two purchased slots:
 *  same-track heats must skip the adjacent slot, cross-track needs the 30-min
 *  walk buffer (heatsConflict — the exact function the web picker + reserve
 *  guard use). Unknown/unparseable slots count as conflicting (safe default). */
function raceSlotsConflict(
  a: CheckinRaceSlot | undefined,
  b: CheckinRaceSlot | undefined,
): boolean {
  if (!a || !b) return true;
  const aMs = Date.parse(a.heatId.replace(/Z$/, ""));
  const bMs = Date.parse(b.heatId.replace(/Z$/, ""));
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return true;
  return heatsConflict(aMs, a.track, bMs, b.track);
}

/** The whole assignment step: a card per open race with a "Choose racer" picker
 *  that only offers class-eligible, ready people. */
/**
 * "Who's racing?" — INLINE chips, one row of names per race.
 *
 * This screen stays SECONDARY and the sign-in screen keeps its layout (owner
 * 2026-08-07: "I want our normal sign in screen, that screen still needs to be
 * secondary"). What changed is only what made it confusing: the per-race modal
 * is gone — every eligible racer is a tap target on the race itself, so
 * assigning N races is N taps instead of N open/scan/pick/close round-trips —
 * and the races the kiosk can work out arrive already filled (autoAssignRaces).
 *
 * Off-class racers are never shown on a card; a racer already holding a race
 * too close is shown but MARKED, and picking them releases the clash exactly as
 * the modal did (assignRace owns that rule, unchanged).
 */
function RaceAssignScreen(props: {
  slots: CheckinRaceSlot[];
  party: PartyMember[];
  assignMap: Record<string, string>;
  onAssign: (heatId: string, memberId: string) => void;
  onClear: (slotKey: string) => void;
  onCheckIn: () => void;
  /** Overrides the finalize label — a combo with HeadPinz bowling goes to
   *  bowler details next instead of finishing here. */
  checkInLabel?: string;
  onBackToParty: () => void;
  autoFilled: boolean;
  binding: boolean;
  bindMsg: string | null;
}) {
  const { slots, party, assignMap, onAssign, onClear, onCheckIn, onBackToParty, autoFilled } =
    props;
  const { binding, bindMsg } = props;
  const t = useT();
  const assignedCount = slots.filter((s) => assignMap[s.slotKey]).length;

  // ONE CARD PER RACE, not per seat (owner 2026-08-07: "should be grouped by
  // race and qty max"). A 2-seat heat rendered as two identical cards — same
  // class, same track, same time — which reads as two different races, and the
  // cross-slot conflict hint then said "moves from 10:12 PM" about the very
  // race the guest was looking at. Seats in the same heat+product ARE
  // interchangeable, so the group is the unit: pick up to `qty` racers on it.
  const groups = (() => {
    const byKey = new Map<string, { slots: CheckinRaceSlot[]; head: CheckinRaceSlot }>();
    const order: string[] = [];
    for (const s of slots) {
      const key = `${s.heatId}|${s.productId ?? ""}|${s.classLabel}`;
      const g = byKey.get(key);
      if (g) g.slots.push(s);
      else {
        byKey.set(key, { slots: [s], head: s });
        order.push(key);
      }
    }
    return order.map((k) => byKey.get(k)!);
  })();

  return (
    <div className="space-y-[24px]">
      <p className="text-[28px] text-white/60">
        {autoFilled ? t("checkin.assign.autoFilled") : t("checkin.assign.promptShort")}
      </p>

      {groups.map((group) => {
        const { head } = group;
        const qty = group.slots.length;
        // Who is on THIS race, and which seat each holds.
        const seatOf = new Map<string, string>(); // memberId → slotKey
        for (const s of group.slots) {
          const id = assignMap[s.slotKey];
          if (id) seatOf.set(id, s.slotKey);
        }
        const chosen = seatOf.size;
        const freeSeat = group.slots.find((s) => !assignMap[s.slotKey]);
        // Hard class gate — a junior race never offers an adult (category.ts).
        const eligible = party.filter((m) => resolveRaceClass(m) === head.category);
        return (
          <div key={head.slotKey} className="k-glass p-[28px]">
            <div className="flex items-baseline justify-between gap-[16px]">
              <div className="min-w-0">
                <div className="k-display text-[34px]">{head.classLabel}</div>
                <div className="mt-[2px] text-[24px] text-white/55">
                  {head.track ? `${head.track} · ` : ""}
                  {head.timeLabel}
                </div>
              </div>
              <span
                className={`shrink-0 text-[24px] font-semibold ${
                  chosen === 0
                    ? "text-[#f0b341]"
                    : chosen < qty
                      ? "text-white/55"
                      : "text-[#46d68c]"
                }`}
              >
                {t("checkin.assign.chosenOf", { chosen, total: qty })}
              </span>
            </div>

            {eligible.length === 0 ? (
              // Dead end before: "go back and add a junior racer" with nothing
              // to tap. Now the instruction IS the button.
              <div className="mt-[18px]">
                <p className="text-[26px] text-[#f0b341]">
                  {t("checkin.picker.noneReady", { category: head.category })}
                </p>
                <button
                  type="button"
                  onClick={onBackToParty}
                  disabled={binding}
                  className="k-tap mt-[14px] h-[76px] rounded-2xl border-2 border-[#00e2e5] px-[28px] text-[26px] font-bold text-[#00e2e5] disabled:opacity-40"
                >
                  {t("checkin.assign.addRacer", { category: head.category })}
                </button>
              </div>
            ) : (
              <div className="mt-[18px] flex flex-wrap gap-[12px]">
                {eligible.map((m) => {
                  const heldSeat = seatOf.get(m.id);
                  const selected = !!heldSeat;
                  // A racer can hold at most ONE seat in a race, so the only
                  // "elsewhere" worth mentioning is a DIFFERENT race. Same-heat
                  // seats never produce the old nonsense "moves from 10:12 PM"
                  // hint about the race you are already looking at.
                  const otherRace = groups.find(
                    (g) => g !== group && g.slots.some((s) => assignMap[s.slotKey] === m.id),
                  );
                  const clash = otherRace ? raceSlotsConflict(otherRace.head, head) : false;
                  // Race full and this racer isn't on it — untap someone first.
                  // Locked once the check-in is submitting: the assignment
                  // payload has ALREADY been sent, so a tap here would change
                  // the screen without changing the grid — the guest would walk
                  // away believing a lineup we never wrote.
                  const blocked = (!selected && !freeSeat) || binding;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={selected}
                      disabled={blocked}
                      onClick={() => {
                        if (selected && heldSeat) onClear(heldSeat);
                        else if (freeSeat) onAssign(freeSeat.slotKey, m.id);
                      }}
                      className={`k-tap flex items-center gap-[10px] rounded-2xl border-2 px-[24px] py-[18px] text-left text-[28px] ${
                        selected
                          ? "border-[#46d68c] bg-[#46d68c]/15 text-white"
                          : "border-white/15 bg-white/5 text-white/85"
                      } ${blocked ? "opacity-35" : ""}`}
                    >
                      {selected && (
                        <IconUserCheck size={26} className="text-[#46d68c]" aria-hidden="true" />
                      )}
                      <span>{racerName(m)}</span>
                      {!selected && otherRace ? (
                        <span
                          className={`text-[20px] ${clash ? "text-[#f0b341]" : "text-white/40"}`}
                        >
                          {clash
                            ? t("checkin.assign.movesFromTime", { time: otherRace.head.timeLabel })
                            : t("checkin.assign.alsoAt", { time: otherRace.head.timeLabel })}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {bindMsg && (
        <div className="rounded-2xl border-2 border-[#e94141]/40 bg-[#e94141]/10 px-[28px] py-[20px] text-[26px] text-[#ffb4b4]">
          {bindMsg}
        </div>
      )}

      {/* PARTIAL CHECK-IN. This used to require EVERY seat filled, which made a
          part-party arrival a dead end: a 2-seat heat with one racer present
          can never be completed (the same racer cannot take both seats), so the
          button stayed disabled forever. Now one assigned racer is enough —
          unassigned seats simply stay open, and completeCheckin is resumable,
          so the rest of the group checks in when they arrive. */}
      <button
        type="button"
        onClick={onCheckIn}
        disabled={binding || assignedCount === 0}
        className="k-btn-primary k-tap h-[112px] w-full text-[36px] disabled:opacity-40"
      >
        {binding
          ? t("checkin.puttingOnGridWait")
          : (props.checkInLabel ?? t("checkin.checkEveryone"))}
      </button>
      <p className="text-center text-[24px] text-white/45">
        {assignedCount === 0
          ? t("checkin.assign.needOne")
          : assignedCount < slots.length
            ? t("checkin.assign.someOpen", { count: slots.length - assignedCount })
            : ""}
      </p>
    </div>
  );
}

// ── Done ────────────────────────────────────────────────────────────────────
function DoneScreen(props: {
  itinerary: CheckinItinerary;
  complete: CheckinCompleteResponse | null;
  /** Who ended up on each race — track, time and names (owner 2026-08-07:
   *  "this should list the track, race and people on it"). The generic activity
   *  card only knew "Race · Blue Track", which is the least useful half of what
   *  the guest just decided. */
  raceLineup: Array<{
    key: string;
    label: string;
    track: string | null;
    timeLabel: string;
    names: string[];
  }>;
  /** FastTrax-building kiosk: never offer the lane-open button — the lane is at
   *  HeadPinz, and opening it from here is exactly the confusion the owner
   *  ruled out (2026-08-16). A note points the guest to the HeadPinz kiosks. */
  atFtKiosk: boolean;
  onFinish: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { itinerary, complete, raceLineup, atFtKiosk } = props;
  const t = useT();
  const scheduled = complete?.scheduled ?? 0;
  const laneOpenEnabled = complete?.laneOpenEnabled === true;
  const bowlingActivities = itinerary.activities.filter(
    (a) => a.kind === "bowling" && a.neonReservationId,
  );

  return (
    <div className="space-y-[28px]">
      <div className="flex flex-col items-center py-[24px] text-center">
        <div
          className="flex h-[140px] w-[140px] items-center justify-center rounded-full border-[3px] border-[#46d68c] bg-[#46d68c]/15 text-[72px] font-black text-[#46d68c]"
          aria-hidden="true"
        >
          ✓
        </div>
        <div className="k-display mt-[20px] text-[64px]">{t("checkin.done.allCheckedIn")}</div>
        <p className="mt-[10px] text-[30px] text-white/60">
          {/* A resumed finalize added only the LATE arrivals, so the bare
              "N racers added" would read as the whole party. Say which it is.
              Bowling with no racers gets its own line — "the front desk knows"
              wasn't a claim this rail could back for bowling-only. */}
          {complete?.resumed && scheduled > 0
            ? t("checkin.done.racersAddedLater", { count: scheduled })
            : scheduled > 0
              ? t("checkin.done.racersAdded", { count: scheduled })
              : bowlingActivities.length > 0 && !atFtKiosk
                ? t("checkin.done.bowlingSet")
                : t("checkin.done.frontDeskKnows")}
        </p>
      </div>

      {complete?.scheduleUnlinked && complete.scheduleUnlinked.length > 0 && (
        <div className="k-glass border-[#f0b341]/40 p-[24px] text-[26px] text-[#f0b341]">
          {t("checkin.done.needHand", { names: complete.scheduleUnlinked.join(", ") })}
        </div>
      )}

      {/* What's next — the same activity cards, now as a reminder. Green bar:
          this is the checked-in / done state (owner 2026-07-25). */}
      {/* Racing is rendered per RACE below (with its drivers), so the generic
          racing card would just repeat the track and time without the names. */}
      {itinerary.activities
        .filter((a) => !(a.kind === "racing" && raceLineup.length > 0))
        .map((a, i) => (
          <div
            key={`${a.kind}-${i}`}
            className="k-glass relative overflow-hidden p-[28px] pl-[44px]"
          >
            <span
              className="absolute inset-y-0 left-0 w-[12px]"
              style={{ background: "#46d68c" }}
              aria-hidden="true"
            />
            <div className="flex items-center gap-[24px]">
              <div className="min-w-0 flex-1">
                <div className="k-display text-[36px]">{a.title}</div>
                <div className="mt-[4px] text-[26px] text-white/55">{a.building}</div>
              </div>
              <div className="k-display text-[40px] text-white">{a.timeLabel}</div>
            </div>
          </div>
        ))}

      {raceLineup.map((r) => (
        <div key={r.key} className="k-glass relative overflow-hidden p-[28px] pl-[44px]">
          <span
            className="absolute inset-y-0 left-0 w-[12px]"
            style={{ background: "#46d68c" }}
            aria-hidden="true"
          />
          <div className="flex items-center gap-[24px]">
            <div className="min-w-0 flex-1">
              <div className="k-display text-[36px]">{r.label}</div>
              <div className="mt-[4px] text-[26px] text-white/55">
                {r.track ? `${r.track} Track` : t("checkin.done.racingBuilding")}
              </div>
            </div>
            <div className="k-display text-[40px] text-white">{r.timeLabel}</div>
          </div>
          {r.names.length > 0 && (
            <div className="mt-[18px] flex flex-wrap gap-[10px]">
              {r.names.map((n) => (
                <span
                  key={n}
                  className="inline-flex items-center gap-[8px] rounded-2xl bg-[#46d68c]/12 px-[20px] py-[10px] text-[26px] text-white"
                >
                  <IconUserCheck size={24} className="text-[#46d68c]" aria-hidden="true" />
                  {n}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Racing — the SAME "what's next" panel + big red race-check-in button a
          race booking shows on the kiosk confirmation (owner 2026-07-25). */}
      {itinerary.activities.some((a) => a.kind === "racing") && (
        // TODO(i18n): this intro carries inline <strong> emphasis (rich text); the
        // plain-string formatMessage engine can't render ICU tags, so localize
        // once rich text is supported or a native reviewer splits it. Kept English.
        <RacingWhatsNext
          fullWidth
          intro={
            <>
              You&rsquo;re checked in. When your heat is called, head to{" "}
              <strong className="text-[#ffd9d8]">
                Race Check-In — 1st floor, left of the Red Track.
              </strong>
            </>
          }
        />
      )}

      {/* Bowling lane-open — interactive only when the check-in attach gate is
          on (dark-safe: staff testing never fires a real lane / KDS ticket).
          NEVER at a FastTrax-building kiosk: the lane is at HeadPinz, so a
          note replaces the button (owner 2026-08-16). */}
      {atFtKiosk && bowlingActivities.length > 0 ? (
        <div className="k-glass p-[24px] text-[26px] text-white/55">
          <IconClock size={26} className="mr-[10px] inline text-[#2dd4ea]" aria-hidden="true" />
          {t("checkin.bowl.laneAtHp")}
        </div>
      ) : (
        bowlingActivities.map((a) => (
          <LaneOpenPanel
            key={a.neonReservationId}
            neonReservationId={a.neonReservationId as number}
            laneLabel={a.laneLabel ?? a.title}
            interactive={laneOpenEnabled}
            onBusyChange={props.onBusyChange}
          />
        ))
      )}

      <button
        type="button"
        onClick={props.onFinish}
        className="k-btn-primary k-tap h-[104px] w-full text-[34px]"
      >
        {t("checkin.done.finish")}
      </button>
    </div>
  );
}

/** Bowling lane-open on the done screen — lifts KioskConfirmation's poll+POST. */
function LaneOpenPanel(props: {
  neonReservationId: number;
  laneLabel: string;
  interactive: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const { neonReservationId, interactive } = props;
  const t = useT();
  const [phase, setPhase] = useState<"idle" | "ready" | "opening" | "open" | "failed">("idle");
  const [laneLabel, setLaneLabel] = useState(props.laneLabel);

  useEffect(() => {
    if (!interactive || phase !== "idle") return;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/bowling/v2/reservations/${neonReservationId}/checkin`, {
          cache: "no-store",
        });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { phase?: string; laneLabel?: string };
        if (!alive) return;
        if (data.phase === "ready") {
          if (data.laneLabel) setLaneLabel(data.laneLabel);
          setPhase("ready");
        } else if (data.phase === "running" || data.phase === "completed") {
          if (data.laneLabel) setLaneLabel(data.laneLabel);
          setPhase("open");
        }
      } catch {
        /* skip this tick */
      }
    };
    void poll();
    const iv = setInterval(() => void poll(), 10_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [interactive, phase, neonReservationId]);

  const openLane = async () => {
    setPhase("opening");
    props.onBusyChange(true);
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${neonReservationId}/checkin`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; lanesOpened?: number };
      if (res.ok && data.ok && (data.lanesOpened ?? 0) > 0) {
        setPhase("open");
        return;
      }
      // Verify — a partial/staff open may have succeeded anyway.
      const v = await fetch(`/api/bowling/v2/reservations/${neonReservationId}/checkin`, {
        cache: "no-store",
      });
      const vd = (await v.json().catch(() => ({}))) as { phase?: string };
      setPhase(vd.phase === "running" || vd.phase === "completed" ? "open" : "failed");
    } catch {
      setPhase("failed");
    } finally {
      props.onBusyChange(false);
    }
  };

  // Nothing to show until a lane is actually openable (or already open).
  if (phase === "idle") {
    return (
      <div className="k-glass p-[24px] text-[26px] text-white/55">
        <IconClock size={26} className="mr-[10px] inline text-[#2dd4ea]" aria-hidden="true" />
        {t("checkin.lane.idle")}
      </div>
    );
  }
  if (phase === "open") {
    return (
      <div className="k-glass border-[#46d68c]/40 p-[28px] text-[30px] text-[#a7e8c6]">
        {t("checkin.lane.open", { lane: laneLabel })}
      </div>
    );
  }
  if (phase === "failed") {
    return (
      <div className="k-glass border-[#f0b341]/40 p-[28px] text-[28px] text-[#f0b341]">
        {t("checkin.lane.failed", { lane: laneLabel })}
      </div>
    );
  }
  // ready | opening
  return (
    <div className="k-glass border-[#2dd4ea]/50 p-[32px]">
      <div className="k-display text-[36px] text-[#2dd4ea]">
        {t("checkin.lane.ready", { lane: laneLabel })}
      </div>
      <p className="mt-[8px] text-[26px] text-white/60">{t("checkin.lane.readyBody")}</p>
      <button
        type="button"
        onClick={openLane}
        disabled={phase === "opening"}
        className="k-btn-primary k-tap mt-[20px] h-[96px] w-full text-[32px] disabled:opacity-40"
      >
        {phase === "opening"
          ? t("checkin.lane.opening")
          : t("checkin.lane.openNow", { lane: laneLabel })}
      </button>
    </div>
  );
}

function ReadinessChip({ activity }: { activity: CheckinActivity }) {
  const t = useT();
  if (activity.kind === "bowling") {
    return (
      <span className="mt-[16px] inline-flex items-center gap-[10px] rounded-2xl bg-white/5 px-[22px] py-[10px] text-[24px] text-white/60">
        <IconClock size={26} aria-hidden="true" />
        {t("checkin.chip.laneOpens")}
      </span>
    );
  }
  const done = activity.readyCount >= activity.totalCount && activity.totalCount > 0;
  const label =
    activity.kind === "racing"
      ? t("checkin.chip.racersReady", {
          ready: activity.readyCount,
          total: activity.totalCount,
        })
      : t("checkin.chip.waiversSigned", {
          ready: activity.readyCount,
          total: activity.totalCount,
        });
  return (
    <span
      className={`mt-[16px] inline-flex items-center gap-[10px] rounded-2xl px-[22px] py-[10px] text-[24px] ${
        done ? "bg-[#46d68c]/15 text-[#46d68c]" : "bg-[#f0b341]/13 text-[#f0b341]"
      }`}
    >
      {label}
    </span>
  );
}
