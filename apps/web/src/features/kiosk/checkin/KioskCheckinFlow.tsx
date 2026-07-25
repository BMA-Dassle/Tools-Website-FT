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
import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from "react";
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
} from "@tabler/icons-react";
import { emptySession, reducer, type AttractionItem } from "~/features/booking";
import { KioskAttractionPeopleStep } from "../steps/KioskPeopleStep";
import { IdleWatcher } from "../components/IdleWatcher";
import { BrandedLoader } from "../components/BrandedLoader";
import { useKioskConfig } from "../KioskConfigContext";
import { kioskId } from "../config";
import { resetToKiosk } from "../version";
import {
  bindParty,
  completeCheckin,
  confirmContactOtp,
  fetchItinerary,
  lookupBrowse,
  lookupByPhone,
  lookupByScan,
  sendContactOtp,
  sendOwnPhoneOtp,
  verifyOwnPhoneOtp,
} from "./service";
import { useWedgeScan } from "./wedge-scan";
import { resolveRaceClass } from "./category";
import type {
  CheckinActivity,
  CheckinBindMember,
  CheckinBrowseRow,
  CheckinCompleteResponse,
  CheckinItinerary,
  CheckinLookupMatch,
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
  | "browse-otp"
  | "itinerary"
  | "assign"
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
  const hydrated = useHydrated();
  const center = config?.center ?? "fort-myers";

  const [stage, setStage] = useState<Stage>("find");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Express-lane info modal — racing (FastTrax / Fort Myers) only.
  const [showExpress, setShowExpress] = useState(false);

  // Phone path
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [matches, setMatches] = useState<CheckinLookupMatch[]>([]);

  // Browse path
  const [rows, setRows] = useState<CheckinBrowseRow[]>([]);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [otpMask, setOtpMask] = useState<string>("");

  // Itinerary
  const [itinerary, setItinerary] = useState<CheckinItinerary | null>(null);
  const [proofToken, setProofToken] = useState<string | null>(null);

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
          data?.reason === "cancelled"
            ? "That reservation was cancelled — please see the front desk."
            : "We couldn't open that reservation. Please try again or see the front desk.",
        );
        return;
      }
      setItinerary(data);
      setProofToken(token);
      setStage("itinerary");
    },
    [center],
  );

  const readyMembers = session.party.filter((m) => m.bmiPersonId && m.waiverValid);
  const unboundReady = readyMembers.filter((m) => !boundIds.has(m.id));
  // A party member still mid-setup (added but no account/waiver yet) blocks
  // check-in — mirror the people step's readiness gate.
  const partyNeedsSetup = session.party.some((m) => !m.bmiPersonId || !m.waiverValid);

  // "Who is who" — the open (unfilled) purchased race slots, and the handler
  // that assigns a ready party member to one. A member holds at most one slot.
  const openRaceSlots = itinerary?.raceSlots.filter((s) => s.open) ?? [];
  const assignRace = (heatId: string, memberId: string) => {
    setAssignMap((prev) => {
      const next: Record<string, string> = {};
      for (const [h, mId] of Object.entries(prev)) {
        if (mId === memberId) continue; // release the member's previous slot
        next[h] = mId;
      }
      if (prev[heatId] === memberId) return next; // tapping the held slot clears it
      next[heatId] = memberId;
      return next;
    });
  };
  const clearRace = (heatId: string) =>
    setAssignMap((prev) => {
      const next = { ...prev };
      delete next[heatId];
      return next;
    });

  // "Check everyone in": attach any newly-added party first, then finalize
  // (schedule onto the session + -5 Arrived + memo) in one tap.
  const checkInEveryone = async () => {
    if (!proofToken || binding) return;
    setBinding(true);
    setBindMsg(null);
    if (unboundReady.length > 0) {
      const members: CheckinBindMember[] = unboundReady.map((m) => ({
        bmiPersonId: m.bmiPersonId as string,
        pandoraPersonId: m.pandoraPersonId ?? null,
        firstName: m.firstName,
        lastName: m.lastName,
        waiverValid: !!m.waiverValid,
      }));
      const b = await bindParty(center, proofToken, members, config ? kioskId(config) : undefined);
      if (!b.ok) {
        setBinding(false);
        setBindMsg("We couldn't add your group — please see the front desk.");
        return;
      }
      setBoundIds((prev) => new Set([...prev, ...unboundReady.map((m) => m.id)]));
    }
    const assignments: CheckinSlotAssignment[] = Object.entries(assignMap)
      .map(([heatId, memberId]): CheckinSlotAssignment | null => {
        const m = session.party.find((p) => p.id === memberId);
        const personId = m?.pandoraPersonId || m?.bmiPersonId;
        if (!m || !personId) return null;
        return { heatId, personId, category: resolveRaceClass(m) };
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
      setBindMsg(
        c.reason === "busy"
          ? "One moment — finishing up. Tap again."
          : "We couldn't check you in — please see the front desk.",
      );
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

  const tapBrowseRow = async (row: CheckinBrowseRow) => {
    setBusy(true);
    setError(null);
    const res = await sendContactOtp(center, row.ref);
    setBusy(false);
    if (!res.ok) {
      setError(
        res.reason === "no-contact"
          ? "No phone on that booking — please see the front desk."
          : res.reason === "rate-limited"
            ? "A code was just sent — check your texts, or wait a moment."
            : "We couldn't send a code. Please see the front desk.",
      );
      return;
    }
    setPendingRef(row.ref);
    setOtpMask(res.mask ?? "your number on file");
    setOtp("");
    setStage("browse-otp");
  };

  const onScan = async (raw: string) => {
    setBusy(true);
    setError(null);
    const res = await lookupByScan(center, raw);
    setBusy(false);
    // A signed link opens directly; an enumerable code/W# comes back as an
    // OTP-gated row → run the same text-a-code-to-the-contact flow as browse.
    if (res.ok && res.matches && res.matches[0]) {
      void openItinerary(res.matches[0].proofToken);
      return;
    }
    if (res.ok && res.rows && res.rows[0]) {
      void tapBrowseRow(res.rows[0]);
      return;
    }
    setError(
      res.reason === "cancelled"
        ? "That reservation was cancelled — please see the front desk."
        : "We couldn't find that code. Try your phone number, or see the front desk.",
    );
  };

  const wedge = useWedgeScan(onScan);

  const sendPhone = async () => {
    if (phone.replace(/\D/g, "").length < 10) {
      setError("Enter your 10-digit mobile number.");
      return;
    }
    setBusy(true);
    setError(null);
    const sent = await sendOwnPhoneOtp(phone);
    setBusy(false);
    if (!sent) {
      setError("We couldn't text that number. Please check it and try again.");
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
          ? `Incorrect code — ${v.attemptsLeft} ${v.attemptsLeft === 1 ? "try" : "tries"} left.`
          : "That code didn't work. Request a new one.",
      );
      return;
    }
    const res = await lookupByPhone(center, phone);
    setBusy(false);
    if (!res.ok || !res.matches || res.matches.length === 0) {
      setError("No reservations found for today under that number. See the front desk.");
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
    const res = await lookupBrowse(center);
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
          ? `Incorrect code — ${res.attemptsLeft} left.`
          : "That code didn't work. Go back and try again.",
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
    else if (stage === "browse-otp") setStage("browse");
    else if (stage === "assign") setStage("itinerary");
    else if (stage === "itinerary") {
      setItinerary(null);
      setStage("find");
    } else goHome();
  };

  if (!hydrated || !config) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[#000418]">
        <BrandedLoader brand="fasttrax" label="Loading…" />
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-[#000418]">
      <IdleWatcher timeoutMs={IDLE_MS} paused={busy || peopleBusy || binding} onReset={goHome} />

      {/* Header */}
      <div className="flex shrink-0 items-center gap-[24px] border-b border-white/10 px-[48px] py-[32px]">
        <button
          type="button"
          onClick={back}
          className="k-tap flex h-[88px] items-center gap-[8px] rounded-2xl border-2 border-white/15 px-[28px] text-[28px] font-bold text-white/70"
        >
          <IconChevronLeft size={36} aria-hidden="true" />
          {stage === "find" ? "Home" : "Back"}
        </button>
        <div className="min-w-0 flex-1">
          <div className="k-eyebrow text-[#00e2e5]">Check in</div>
          <div className="k-display truncate text-[52px]">
            {stage === "done"
              ? "You're checked in"
              : stage === "assign"
                ? "Who's racing?"
                : stage === "itinerary" && itinerary
                  ? `Welcome back, ${itinerary.firstName || "friend"}!`
                  : "Find your reservation"}
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

        {busy && (
          <div className="mb-[24px] flex justify-center">
            <BrandedLoader brand={config.brand} label="One moment…" />
          </div>
        )}

        {stage === "find" && (
          <FindScreen
            phone={phone}
            onPhone={setPhone}
            onSendPhone={sendPhone}
            scanArmed={wedge.armed}
            onArmScan={wedge.arm}
            onBrowse={openBrowse}
            showExpress={center === "fort-myers"}
            onExpress={() => setShowExpress(true)}
          />
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
            <p className="text-[28px] text-white/55">
              We found more than one reservation — tap the one you&rsquo;re here for.
            </p>
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
              Arriving soon at this location. Tap your booking — we&rsquo;ll text a code to the
              number on the reservation to confirm it&rsquo;s you.
            </p>
            {rows.length === 0 ? (
              <div className="k-glass p-[48px] text-center">
                <div className="k-display text-[40px]">Nothing in the next few hours</div>
                <p className="mx-auto mt-[12px] max-w-[34ch] text-[26px] text-white/50">
                  Use your phone number above, or see the front desk.
                </p>
              </div>
            ) : (
              rows.map((r) => (
                <button
                  key={r.ref}
                  type="button"
                  onClick={() => tapBrowseRow(r)}
                  className="k-glass k-tap flex w-full items-center gap-[28px] p-[28px] text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="k-display truncate text-[38px]">{r.label}</div>
                    <div className="mt-[6px] text-[26px] text-white/55">{r.activitiesLabel}</div>
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

        {stage === "itinerary" && itinerary && (
          <div className="space-y-[32px]">
            <ItineraryScreen itinerary={itinerary} />

            {/* Add your group — the people monolith (add / returning lookup /
                minor+guardian / waiver signature) + the mobile-join QR, all
                writing into the local session.party. */}
            <div className="border-t border-white/10 pt-[28px]">
              <div className="k-eyebrow mb-[10px] text-[#00e2e5]">Add your group</div>
              <p className="mb-[20px] text-[26px] text-white/55">
                Add anyone with you who still needs an account or a waiver — or have them scan the
                QR to sign in on their own phone.
              </p>
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

              {/* Racing → go to the dedicated "Who's racing?" step; otherwise
                  finalize straight from here. */}
              {openRaceSlots.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setStage("assign")}
                  disabled={partyNeedsSetup}
                  className="k-btn-primary k-tap mt-[24px] h-[112px] w-full text-[36px] disabled:opacity-40"
                >
                  Next: who&rsquo;s racing ›
                </button>
              ) : (
                <button
                  type="button"
                  onClick={checkInEveryone}
                  disabled={binding || partyNeedsSetup}
                  className="k-btn-primary k-tap mt-[24px] h-[112px] w-full text-[36px] disabled:opacity-40"
                >
                  {binding ? "Checking you in…" : "Check everyone in"}
                </button>
              )}
              {partyNeedsSetup && (
                <p className="mt-[12px] text-center text-[24px] text-white/45">
                  Finish adding everyone above first — each person needs an account and a signed
                  waiver.
                </p>
              )}
            </div>
          </div>
        )}

        {stage === "assign" && itinerary && (
          <RaceAssignScreen
            slots={openRaceSlots}
            party={readyMembers}
            assignMap={assignMap}
            onAssign={assignRace}
            onClear={clearRace}
            onCheckIn={checkInEveryone}
            binding={binding}
            bindMsg={bindMsg}
          />
        )}

        {stage === "done" && itinerary && (
          <DoneScreen
            itinerary={itinerary}
            complete={complete}
            onFinish={goHome}
            onBusyChange={setBinding}
          />
        )}
      </div>

      {showExpress && <ExpressLaneModal onClose={() => setShowExpress(false)} />}
    </div>
  );
}

// ── Express-lane info modal ───────────────────────────────────────────────────
/** Informational only — returning racers with signed waivers skip kiosk check-in
 *  and go straight to Karting Check-In. No lookup, no eligibility check. */
function ExpressLaneModal(props: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center p-[48px]">
      <button
        type="button"
        aria-label="Close"
        onClick={props.onClose}
        className="absolute inset-0 bg-black/70"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="express-title"
        className="k-glass relative z-10 max-w-[760px] p-[48px] text-center"
      >
        <div
          className="mx-auto mb-[24px] flex h-[120px] w-[120px] items-center justify-center rounded-full border-[3px] border-[#00e2e5] bg-[#00e2e5]/12"
          aria-hidden="true"
        >
          <IconBolt size={64} className="text-[#00e2e5]" />
        </div>
        <div id="express-title" className="k-display text-[48px]">
          Express Lane
        </div>
        <p className="mt-[20px] text-[30px] leading-[1.4] text-white/70">
          Already booked and your waiver&rsquo;s signed? Returning racers can skip check-in — head
          straight to{" "}
          <span className="font-bold text-white">Karting Check-In on the 1st floor</span>.
          There&rsquo;s no need to sign in here.
        </p>
        <button
          type="button"
          onClick={props.onClose}
          className="k-btn-primary k-tap mt-[36px] h-[104px] w-full text-[34px]"
        >
          Got it
        </button>
      </div>
    </div>
  );
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
  onArmScan: () => void;
  onBrowse: () => void;
  showExpress: boolean;
  onExpress: () => void;
}) {
  return (
    <div className="space-y-[28px]">
      {/* Phone — primary */}
      <div className="k-glass p-[40px]">
        <div className="mb-[20px] flex items-center gap-[20px]">
          <IconDeviceMobile size={44} className="text-[#00e2e5]" aria-hidden="true" />
          <div className="k-display text-[40px]">Use your phone number</div>
        </div>
        <p className="mb-[20px] text-[26px] text-white/55">
          Works for every booking. We&rsquo;ll text you a quick code.
        </p>
        <input
          type="tel"
          inputMode="tel"
          value={props.phone}
          onChange={(e) => props.onPhone(e.target.value)}
          placeholder="(239) 555-0123"
          aria-label="Mobile phone number"
          className="mb-[20px] h-[104px] w-full rounded-2xl border-2 border-white/15 bg-white/5 px-[32px] text-[44px] text-white placeholder:text-white/25"
        />
        <button
          type="button"
          onClick={props.onSendPhone}
          className="k-btn-primary k-tap h-[96px] w-full text-[34px]"
        >
          Text me a code
        </button>
      </div>

      {/* Scan + Browse */}
      <div className="grid grid-cols-2 gap-[24px]">
        <button
          type="button"
          onClick={props.onArmScan}
          className={`k-glass k-tap flex flex-col items-center justify-center gap-[16px] p-[40px] text-center ${
            props.scanArmed ? "border-[#00e2e5]/60" : ""
          }`}
        >
          <IconScan size={56} className="text-[#e94141]" aria-hidden="true" />
          <div className="k-display text-[32px]">
            {props.scanArmed ? "Scan now…" : "Scan my code"}
          </div>
          <div className="text-[24px] text-white/50">Email QR or W-number</div>
        </button>
        <button
          type="button"
          onClick={props.onBrowse}
          className="k-glass k-tap flex flex-col items-center justify-center gap-[16px] p-[40px] text-center"
        >
          <IconListSearch size={56} className="text-[#a78bfa]" aria-hidden="true" />
          <div className="k-display text-[32px]">Find my booking</div>
          <div className="text-[24px] text-white/50">Pick from today&rsquo;s list</div>
        </button>
      </div>

      {/* Express lane — racing only. Info modal: returning racers skip check-in. */}
      {props.showExpress && (
        <button
          type="button"
          onClick={props.onExpress}
          className="k-glass k-tap flex w-full items-center justify-center gap-[16px] p-[28px] text-center"
        >
          <IconBolt size={40} className="text-[#00e2e5]" aria-hidden="true" />
          <div className="k-display text-[30px]">Here for racing? Express lane ›</div>
        </button>
      )}
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
  return (
    <div className="k-glass mx-auto max-w-[720px] p-[48px] text-center">
      <div className="k-eyebrow text-[#00e2e5]">Verify it&rsquo;s you</div>
      <div className="k-display mt-[8px] text-[44px]">We texted a code to {props.mask}</div>
      <p className="mt-[12px] text-[28px] text-white/55">Enter the 6-digit code from your texts.</p>
      <input
        type="tel"
        inputMode="numeric"
        value={props.code}
        onChange={(e) => props.onCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="••••••"
        aria-label="6-digit verification code"
        className="my-[32px] h-[120px] w-full rounded-2xl border-2 border-white/15 bg-white/5 text-center text-[64px] tracking-[0.4em] text-white placeholder:text-white/20"
      />
      <button
        type="button"
        onClick={props.onVerify}
        disabled={props.code.length < 6}
        className="k-btn-primary k-tap h-[96px] w-full text-[34px] disabled:opacity-40"
      >
        Open my day
      </button>
    </div>
  );
}

// ── Itinerary ──────────────────────────────────────────────────────────────────
function ItineraryScreen(props: { itinerary: CheckinItinerary }) {
  const { itinerary } = props;
  return (
    <div className="space-y-[24px]">
      {itinerary.firstStop && (
        <div className="k-glass flex items-center gap-[24px] border-[#00e2e5]/40 p-[32px]">
          <IconMapPin size={48} className="shrink-0 text-[#00e2e5]" aria-hidden="true" />
          <div className="min-w-0">
            <div className="k-eyebrow text-[#00e2e5]">Start here · First stop</div>
            <div className="k-display text-[36px]">{itinerary.firstStop.building}</div>
            {itinerary.firstStop.arriveByLabel && (
              <div className="text-[28px] text-white/60">
                Arrive by {itinerary.firstStop.arriveByLabel}
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
              <ReadinessChip activity={a} />
            </div>
            <div className="k-display text-[44px] text-white">{a.timeLabel}</div>
          </div>
        </div>
      ))}

      {itinerary.dueAtCenterCents > 0 && (
        <div className="k-glass border-[#f0b341]/40 p-[28px] text-[28px] text-[#f0b341]">
          ${(itinerary.dueAtCenterCents / 100).toFixed(2)} due at the front desk — nothing is
          charged here.
        </div>
      )}

      {/* Who's already on the reservation — identified people only (unfilled
          slots are handled in the "Who's racing?" step, never shown here). */}
      {itinerary.roster.length > 0 && (
        <div>
          <div className="k-eyebrow mb-[14px] text-white/40">Already on this reservation</div>
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
function racerName(m: PartyMember): string {
  return `${m.firstName}${m.lastName ? ` ${m.lastName}` : ""}`.trim() || "Racer";
}

/** The whole assignment step: a card per open race with a "Choose racer" picker
 *  that only offers class-eligible, ready people. */
function RaceAssignScreen(props: {
  slots: CheckinRaceSlot[];
  party: PartyMember[];
  assignMap: Record<string, string>;
  onAssign: (heatId: string, memberId: string) => void;
  onClear: (heatId: string) => void;
  onCheckIn: () => void;
  binding: boolean;
  bindMsg: string | null;
}) {
  const { slots, party, assignMap, onAssign, onClear, onCheckIn, binding, bindMsg } = props;
  const [pickFor, setPickFor] = useState<CheckinRaceSlot | null>(null);
  const assignedCount = slots.filter((s) => assignMap[s.heatId]).length;

  return (
    <div className="space-y-[24px]">
      <p className="text-[28px] text-white/60">
        Tap each race to choose who&rsquo;s driving it. Junior races only list junior racers.
      </p>

      {slots.map((slot) => {
        const assigned = party.find((m) => m.id === assignMap[slot.heatId]);
        return (
          <div key={slot.heatId} className="k-glass p-[32px]">
            <div className="flex items-center justify-between gap-[20px]">
              <div className="min-w-0">
                <div className="k-display text-[36px]">{slot.classLabel}</div>
                <div className="mt-[4px] text-[26px] text-white/55">
                  {slot.track ? `${slot.track} · ` : ""}
                  {slot.timeLabel}
                </div>
              </div>
              {assigned ? (
                <div className="flex shrink-0 items-center gap-[20px]">
                  <span className="flex items-center gap-[10px] text-[30px] text-[#46d68c]">
                    <IconUserCheck size={30} aria-hidden="true" />
                    {racerName(assigned)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPickFor(slot)}
                    className="k-tap text-[26px] font-bold text-[#00e2e5]"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setPickFor(slot)}
                  className="k-btn-primary k-tap h-[80px] shrink-0 px-[36px] text-[28px]"
                >
                  Choose racer
                </button>
              )}
            </div>
          </div>
        );
      })}

      {bindMsg && (
        <div className="rounded-2xl border-2 border-[#e94141]/40 bg-[#e94141]/10 px-[28px] py-[20px] text-[26px] text-[#ffb4b4]">
          {bindMsg}
        </div>
      )}

      <button
        type="button"
        onClick={onCheckIn}
        disabled={binding}
        className="k-btn-primary k-tap h-[112px] w-full text-[36px] disabled:opacity-40"
      >
        {binding ? "Checking you in…" : "Check everyone in"}
      </button>
      {assignedCount === 0 && (
        <p className="text-center text-[24px] text-white/45">
          You can still check in — but racers won&rsquo;t be on the grid until they&rsquo;re chosen.
        </p>
      )}

      {pickFor && (
        <RacerPickerModal
          slot={pickFor}
          party={party}
          assignMap={assignMap}
          onPick={(memberId) => {
            onAssign(pickFor.heatId, memberId);
            setPickFor(null);
          }}
          onRemove={() => {
            onClear(pickFor.heatId);
            setPickFor(null);
          }}
          onClose={() => setPickFor(null)}
        />
      )}
    </div>
  );
}

/** Picker sheet for one race — lists ONLY ready racers whose class matches the
 *  slot (the hard junior/adult check: an off-class racer is never offered). */
function RacerPickerModal(props: {
  slot: CheckinRaceSlot;
  party: PartyMember[];
  assignMap: Record<string, string>;
  onPick: (memberId: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { slot, party, assignMap, onPick, onRemove, onClose } = props;
  const currentId = assignMap[slot.heatId];
  const eligible = party.filter((m) => resolveRaceClass(m) === slot.category);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center p-[48px]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/70"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pick-title"
        className="k-glass relative z-10 max-h-[82%] w-full max-w-[720px] overflow-y-auto p-[40px]"
      >
        <div id="pick-title" className="k-display text-[40px]">
          Who&rsquo;s racing the {slot.classLabel}?
        </div>
        <p className="mt-[8px] text-[26px] text-white/55">
          {slot.track ? `${slot.track} · ` : ""}
          {slot.timeLabel}
        </p>

        {eligible.length === 0 ? (
          <p className="mt-[28px] text-[28px] text-[#f0b341]">
            No {slot.category} racer is ready yet. Go back and add a {slot.category} racer with a
            signed waiver first.
          </p>
        ) : (
          <div className="mt-[28px] space-y-[14px]">
            {eligible.map((m) => {
              const selected = currentId === m.id;
              const elsewhere = !selected && Object.values(assignMap).includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onPick(m.id)}
                  className={`k-tap flex w-full items-center gap-[16px] rounded-2xl border-2 p-[24px] text-left text-[30px] ${
                    selected
                      ? "border-[#46d68c] bg-[#46d68c]/15 text-white"
                      : "border-white/15 bg-white/5 text-white"
                  }`}
                >
                  <IconUserCheck
                    size={30}
                    className={selected ? "text-[#46d68c]" : "text-white/30"}
                    aria-hidden="true"
                  />
                  <span className="flex-1">{racerName(m)}</span>
                  {elsewhere && <span className="text-[22px] text-white/40">in another race</span>}
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-[28px] flex gap-[16px]">
          {currentId && (
            <button
              type="button"
              onClick={onRemove}
              className="k-tap h-[88px] flex-1 rounded-2xl border-2 border-white/15 text-[28px] text-white/70"
            >
              Remove
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="k-tap h-[88px] flex-1 rounded-2xl border-2 border-white/15 text-[28px] text-white/70"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Done ────────────────────────────────────────────────────────────────────
function DoneScreen(props: {
  itinerary: CheckinItinerary;
  complete: CheckinCompleteResponse | null;
  onFinish: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { itinerary, complete } = props;
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
        <div className="k-display mt-[20px] text-[64px]">You&rsquo;re all checked in.</div>
        <p className="mt-[10px] text-[30px] text-white/60">
          {scheduled > 0
            ? `${scheduled} ${scheduled === 1 ? "racer" : "racers"} added to your race — head over when your heat is called.`
            : "The front desk knows you're here."}
        </p>
      </div>

      {complete?.scheduleUnlinked && complete.scheduleUnlinked.length > 0 && (
        <div className="k-glass border-[#f0b341]/40 p-[24px] text-[26px] text-[#f0b341]">
          {complete.scheduleUnlinked.join(", ")} may need a hand at the desk — a team member has
          been notified.
        </div>
      )}

      {/* What's next — the same activity cards, now as a reminder. */}
      {itinerary.activities.map((a, i) => (
        <div key={`${a.kind}-${i}`} className="k-glass relative overflow-hidden p-[28px] pl-[44px]">
          <span
            className="absolute inset-y-0 left-0 w-[12px]"
            style={{ background: ACCENT[a.kind] }}
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

      {/* Bowling lane-open — interactive only when the check-in attach gate is
          on (dark-safe: staff testing never fires a real lane / KDS ticket). */}
      {bowlingActivities.map((a) => (
        <LaneOpenPanel
          key={a.neonReservationId}
          neonReservationId={a.neonReservationId as number}
          laneLabel={a.laneLabel ?? a.title}
          interactive={laneOpenEnabled}
          onBusyChange={props.onBusyChange}
        />
      ))}

      <button
        type="button"
        onClick={props.onFinish}
        className="k-btn-primary k-tap h-[104px] w-full text-[34px]"
      >
        Done
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
        Your lane opens about 30 minutes before your time — we&rsquo;ll get it ready.
      </div>
    );
  }
  if (phase === "open") {
    return (
      <div className="k-glass border-[#46d68c]/40 p-[28px] text-[30px] text-[#a7e8c6]">
        {laneLabel} is open — shoes are on the way. Have fun!
      </div>
    );
  }
  if (phase === "failed") {
    return (
      <div className="k-glass border-[#f0b341]/40 p-[28px] text-[28px] text-[#f0b341]">
        We couldn&rsquo;t open {laneLabel} — please see the front desk and they&rsquo;ll get you
        started.
      </div>
    );
  }
  // ready | opening
  return (
    <div className="k-glass border-[#2dd4ea]/50 p-[32px]">
      <div className="k-display text-[36px] text-[#2dd4ea]">{laneLabel} is ready</div>
      <p className="mt-[8px] text-[26px] text-white/60">Open it now and head over to bowl.</p>
      <button
        type="button"
        onClick={openLane}
        disabled={phase === "opening"}
        className="k-btn-primary k-tap mt-[20px] h-[96px] w-full text-[32px] disabled:opacity-40"
      >
        {phase === "opening" ? "Opening your lane…" : `Open ${laneLabel} now`}
      </button>
    </div>
  );
}

function ReadinessChip({ activity }: { activity: CheckinActivity }) {
  if (activity.kind === "bowling") {
    return (
      <span className="mt-[16px] inline-flex items-center gap-[10px] rounded-2xl bg-white/5 px-[22px] py-[10px] text-[24px] text-white/60">
        <IconClock size={26} aria-hidden="true" />
        Lane opens about 30 minutes before your time
      </span>
    );
  }
  const done = activity.readyCount >= activity.totalCount && activity.totalCount > 0;
  const label =
    activity.kind === "racing"
      ? `${activity.readyCount} of ${activity.totalCount} racers ready`
      : `${activity.readyCount} of ${activity.totalCount} waivers signed`;
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
