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
import type {
  CheckinActivity,
  CheckinBindMember,
  CheckinBrowseRow,
  CheckinItinerary,
  CheckinLookupMatch,
} from "./types";

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

type Stage = "find" | "phone-otp" | "matches" | "browse" | "browse-otp" | "itinerary";

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

  const bindGroup = async () => {
    if (!proofToken || unboundReady.length === 0) return;
    setBinding(true);
    setBindMsg(null);
    const members: CheckinBindMember[] = unboundReady.map((m) => ({
      bmiPersonId: m.bmiPersonId as string,
      pandoraPersonId: m.pandoraPersonId ?? null,
      firstName: m.firstName,
      lastName: m.lastName,
      waiverValid: !!m.waiverValid,
    }));
    const res = await bindParty(center, proofToken, members, config ? kioskId(config) : undefined);
    setBinding(false);
    if (!res.ok) {
      setBindMsg("We couldn't add your group to the reservation — please see the front desk.");
      return;
    }
    const justBound = unboundReady.map((m) => m.id);
    setBoundIds((prev) => new Set([...prev, ...justBound]));
    const n = res.results?.length ?? justBound.length;
    setBindMsg(`Added ${n} ${n === 1 ? "person" : "people"} to your reservation.`);
  };

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
            {stage === "itinerary" && itinerary
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
            <ItineraryScreen
              itinerary={itinerary}
              onNewBooking={() => router.push("/kiosk/flow")}
            />

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
                <div className="mt-[20px] rounded-2xl border-2 border-[#46d68c]/40 bg-[#46d68c]/10 px-[28px] py-[20px] text-[26px] text-[#a7e8c6]">
                  {bindMsg}
                </div>
              )}

              {unboundReady.length > 0 && (
                <button
                  type="button"
                  onClick={bindGroup}
                  disabled={binding}
                  className="k-btn-primary k-tap mt-[20px] h-[96px] w-full text-[32px] disabled:opacity-40"
                >
                  {binding
                    ? "Adding your group…"
                    : `Add ${unboundReady.length} ${
                        unboundReady.length === 1 ? "person" : "people"
                      } to my reservation`}
                </button>
              )}
            </div>
          </div>
        )}
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
function ItineraryScreen(props: { itinerary: CheckinItinerary; onNewBooking: () => void }) {
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

      {/* Who's already on the reservation (read-only; the interactive
          "Add your group" panel renders below the itinerary). */}
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

      <div className="k-glass p-[28px] text-center">
        <p className="text-[26px] text-white/55">
          Someone with you who isn&rsquo;t on this booking?
        </p>
        <button
          type="button"
          onClick={props.onNewBooking}
          className="k-tap mt-[12px] text-[30px] font-bold text-[#00e2e5]"
        >
          Start a new booking ›
        </button>
      </div>
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
