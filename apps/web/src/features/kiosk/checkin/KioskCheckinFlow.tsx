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
import { useT } from "../i18n";
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
import type {
  CheckinActivity,
  CheckinBindMember,
  CheckinBrowseRow,
  CheckinCompleteResponse,
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

type Stage = "find" | "phone-otp" | "matches" | "browse" | "browse-otp" | "itinerary" | "done";

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
  const t = useT();
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
  const [complete, setComplete] = useState<CheckinCompleteResponse | null>(null);

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
    },
    [center, t],
  );

  const readyMembers = session.party.filter((m) => m.bmiPersonId && m.waiverValid);
  const unboundReady = readyMembers.filter((m) => !boundIds.has(m.id));
  // A party member still mid-setup (added but no account/waiver yet) blocks
  // check-in — mirror the people step's readiness gate.
  const partyNeedsSetup = session.party.some((m) => !m.bmiPersonId || !m.waiverValid);

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
        setBindMsg(t("checkin.err.addFail"));
        return;
      }
      setBoundIds((prev) => new Set([...prev, ...unboundReady.map((m) => m.id)]));
    }
    const c = await completeCheckin(center, proofToken, config ? kioskId(config) : undefined);
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

  const tapBrowseRow = async (row: CheckinBrowseRow) => {
    setBusy(true);
    setError(null);
    const res = await sendContactOtp(center, row.ref);
    setBusy(false);
    if (!res.ok) {
      setError(
        res.reason === "no-contact"
          ? t("checkin.err.noPhone")
          : res.reason === "rate-limited"
            ? t("checkin.err.codeJustSent")
            : t("checkin.err.sendCodeFail"),
      );
      return;
    }
    setPendingRef(row.ref);
    setOtpMask(res.mask ?? t("checkin.otpMaskFallback"));
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
      res.reason === "cancelled" ? t("checkin.err.cancelled") : t("checkin.err.codeNotFound"),
    );
  };

  const wedge = useWedgeScan(onScan);

  const sendPhone = async () => {
    if (phone.replace(/\D/g, "").length < 10) {
      setError(t("checkin.err.enterMobile"));
      return;
    }
    setBusy(true);
    setError(null);
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
    const res = await lookupByPhone(center, phone);
    setBusy(false);
    if (!res.ok || !res.matches || res.matches.length === 0) {
      setError(t("checkin.err.noReservations"));
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
    else if (stage === "browse-otp") setStage("browse");
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
      <IdleWatcher timeoutMs={IDLE_MS} paused={busy || peopleBusy || binding} onReset={goHome} />

      {/* Header */}
      <div className="flex shrink-0 items-center gap-[24px] border-b border-white/10 px-[48px] py-[32px]">
        <button
          type="button"
          onClick={back}
          className="k-tap flex h-[88px] items-center gap-[8px] rounded-2xl border-2 border-white/15 px-[28px] text-[28px] font-bold text-white/70"
        >
          <IconChevronLeft size={36} aria-hidden="true" />
          {stage === "find" ? t("checkin.home") : t("checkin.back")}
        </button>
        <div className="min-w-0 flex-1">
          <div className="k-eyebrow text-[#00e2e5]">{t("checkin.eyebrow")}</div>
          <div className="k-display truncate text-[52px]">
            {stage === "done"
              ? t("checkin.doneTitle")
              : stage === "itinerary" && itinerary
                ? t("checkin.welcomeBack", { name: itinerary.firstName || t("checkin.friend") })
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

        {busy && (
          <div className="mb-[24px] flex justify-center">
            <BrandedLoader brand={config.brand} label={t("checkin.oneMoment")} />
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
            <p className="text-[28px] text-white/55">{t("checkin.browse.prompt")}</p>
            {rows.length === 0 ? (
              <div className="k-glass p-[48px] text-center">
                <div className="k-display text-[40px]">{t("checkin.browse.emptyTitle")}</div>
                <p className="mx-auto mt-[12px] max-w-[34ch] text-[26px] text-white/50">
                  {t("checkin.browse.emptyBody")}
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
              <div className="k-eyebrow mb-[10px] text-[#00e2e5]">
                {t("checkin.addGroup.eyebrow")}
              </div>
              <p className="mb-[20px] text-[26px] text-white/55">{t("checkin.addGroup.body")}</p>
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

              <button
                type="button"
                onClick={checkInEveryone}
                disabled={binding || partyNeedsSetup}
                className="k-btn-primary k-tap mt-[24px] h-[112px] w-full text-[36px] disabled:opacity-40"
              >
                {binding ? t("checkin.checkingIn") : t("checkin.checkEveryone")}
              </button>
              {partyNeedsSetup && (
                <p className="mt-[12px] text-center text-[24px] text-white/45">
                  {t("checkin.finishAddingFirst")}
                </p>
              )}
            </div>
          </div>
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
            props.scanArmed ? "border-[#00e2e5]/60" : ""
          }`}
        >
          <IconScan size={56} className="text-[#e94141]" aria-hidden="true" />
          <div className="k-display text-[32px]">
            {props.scanArmed ? t("checkin.find.scanNow") : t("checkin.find.scanMyCode")}
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
function ItineraryScreen(props: { itinerary: CheckinItinerary; onNewBooking: () => void }) {
  const t = useT();
  const { itinerary } = props;
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
              <ReadinessChip activity={a} />
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

      {/* Who's already on the reservation (read-only; the interactive
          "Add your group" panel renders below the itinerary). */}
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

      <div className="k-glass p-[28px] text-center">
        <p className="text-[26px] text-white/55">{t("checkin.itin.someoneNotOn")}</p>
        <button
          type="button"
          onClick={props.onNewBooking}
          className="k-tap mt-[12px] text-[30px] font-bold text-[#00e2e5]"
        >
          {t("checkin.itin.startNew")}
        </button>
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
  const t = useT();
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
        <div className="k-display mt-[20px] text-[64px]">{t("checkin.done.allCheckedIn")}</div>
        <p className="mt-[10px] text-[30px] text-white/60">
          {scheduled > 0
            ? t("checkin.done.racersAdded", { count: scheduled })
            : t("checkin.done.frontDeskKnows")}
        </p>
      </div>

      {complete?.scheduleUnlinked && complete.scheduleUnlinked.length > 0 && (
        <div className="k-glass border-[#f0b341]/40 p-[24px] text-[26px] text-[#f0b341]">
          {t("checkin.done.needHand", { names: complete.scheduleUnlinked.join(", ") })}
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
  const t = useT();
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
      ? t("checkin.chip.racersReady", { ready: activity.readyCount, total: activity.totalCount })
      : t("checkin.chip.waiversSigned", { ready: activity.readyCount, total: activity.totalCount });
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
