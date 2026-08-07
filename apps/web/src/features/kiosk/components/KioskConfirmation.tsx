"use client";

/**
 * Kiosk confirmation — the guest's receipt IS their phone (email + SMS were
 * sent by the reserve path; there is no printer). Shows the booking code,
 * auto-resets to the attract screen after 60s so the kiosk is never left
 * on a stranger's confirmation.
 *
 * `src` carries the ORIGINAL web confirmation URL produced by CheckoutStep
 * (e.g. /hp/book/bowling/confirmation?code=XXXX) — we surface its code and
 * keep a stable seam for the bowl-now live-lane display to hook into.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useKioskConfig } from "../KioskConfigContext";
import { resetToKiosk } from "../version";
import { BrandLogo } from "./BrandLogo";
import { readGzFulfillment, type GzFulfillmentPayload } from "../service/gz-fulfillment";
import { KioskGzFulfillment } from "./KioskGzFulfillment";
import { KioskLicenceOffer } from "./KioskLicenceOffer";
import { useIsRacingBooking } from "~/features/racing/components/useLicenceOffer";
import {
  readRacePackConfirmation,
  clearRacePackConfirmation,
  type RacePackConfirmLine,
} from "../service/race-pack-confirmation";
import { clarityEvent } from "~/lib/clarity";
import { readPovConfirmation, clearPovConfirmation } from "../service/pov-confirmation";
import {
  readVipVoucherConfirmation,
  clearVipVoucherConfirmation,
  type VipVoucherConfirmation,
} from "../service/vip-voucher-confirmation";
import { formatVoucherCode } from "~/features/game-cards/vouchers/codes";
import { readKioskHasRacing, clearKioskHasRacing } from "../service/racing-confirmation";
import { useT } from "../i18n";
import PovVoucherBlock from "@/components/booking/PovVoucherBlock";

const AUTO_RESET_SECONDS = 60;

// Racing "what's next" popup content. Copy mirrors the web v2 confirmation's
// arrival guidance (1st floor, 5 min early, e-ticket open and ready).
// TODO(i18n): these step bodies carry inline <strong> emphasis (rich text) and
// read as a cohesive instructional unit with their titles. The formatMessage
// engine returns plain strings only, so translating just the titles would leave
// a half-Spanish popup. Localize the whole RACE_CHECKIN_STEPS unit in a later
// pass once the engine supports ICU rich-text tags (or a native reviewer splits
// each body safely). Kept English for now — do not guess.
const RACE_ICON_PROPS = {
  width: 40,
  height: 40,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "#e53935",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

const RACE_CHECKIN_STEPS: { title: string; body: ReactNode; icon: ReactNode }[] = [
  {
    title: "eTicket by text",
    body: (
      <>
        Arrives shortly after checkout.{" "}
        <strong className="text-white">Have it open at Race Check-In.</strong>
      </>
    ),
    icon: (
      <svg {...RACE_ICON_PROPS}>
        <path d="M21 11.5a8.38 8.38 0 0 1-9 8.35 8.5 8.5 0 0 1-3.4-.7L3 20l1.1-4.1A8.38 8.38 0 0 1 3 11.5a8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 9.5 8.5z" />
      </svg>
    ),
  },
  {
    title: "Where",
    body: (
      <>
        <strong className="text-white">1st floor, left side of the Red Track.</strong> All tracks
        and race types check in there.
      </>
    ),
    icon: (
      <svg {...RACE_ICON_PROPS}>
        <path d="M12 21s-7-5.3-7-11a7 7 0 0 1 14 0c0 5.7-7 11-7 11z" />
        <circle cx="12" cy="10" r="2.6" />
      </svg>
    ),
  },
  {
    title: "When",
    body: (
      <>
        Be there <strong className="text-white">about 5 minutes before your race</strong> —
        we&rsquo;ll text you and call it over the intercom. It&rsquo;s live racing, so delays can
        happen.
      </>
    ),
    icon: (
      <svg {...RACE_ICON_PROPS}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </svg>
    ),
  },
  {
    title: "Allow about 30 minutes",
    body: <>Briefing video, lockers for your stuff (in the briefing room), and safety gear.</>,
    icon: (
      <svg {...RACE_ICON_PROPS}>
        <path d="M12 3a9 9 0 0 1 9 9c0 1.5-.6 2-2 2h-3.5l-1 4h-5l-1-4H5c-1.4 0-2-.5-2-2a9 9 0 0 1 9-9z" />
        <path d="M8 12h8" />
      </svg>
    ),
  },
  {
    title: "Keep your head sock",
    body: (
      <>
        It&rsquo;s included with your license —{" "}
        <strong className="text-white">replacements cost extra.</strong>
      </>
    ),
    icon: (
      <svg {...RACE_ICON_PROPS}>
        <path d="M9 3h6v4a3 3 0 0 1-3 3 3 3 0 0 1-3-3z" />
        <path d="M9 5c-2 1-3.5 3.5-3.5 7 0 5 2 9 6.5 9s6.5-4 6.5-9c0-3.5-1.5-6-3.5-7" />
      </svg>
    ),
  },
];

function codeFromSrc(src: string | null): string | null {
  if (!src) return null;
  try {
    const url = new URL(src, "https://kiosk.local");
    return url.searchParams.get("code");
  } catch {
    return null;
  }
}

// Bowling bookings carry the Neon reservation id in the web confirmation URL —
// the handle for the same GET/POST /checkin API the web confirmation uses for
// self-service lane open. Null for non-bowling bookings (race, attractions).
/** The web confirmation URL carries `billId` (checkout builds it), which is the
 *  handle the licence-offer endpoint keys on — so the kiosk reuses exactly the
 *  same fetch and the same login-code warming as the web page. */
function billIdFromSrc(src: string | null): string | null {
  if (!src) return null;
  try {
    const id = new URL(src, "https://kiosk.local").searchParams.get("billId");
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function bowlingNeonIdFromSrc(src: string | null): number | null {
  if (!src) return null;
  try {
    const url = new URL(src, "https://kiosk.local");
    const isBowling =
      url.pathname.includes("/book/bowling/confirmation") ||
      url.pathname.includes("/book/kids-bowl-free/confirmation") ||
      // FastTrax duckpin standalone confirmation route.
      url.pathname.includes("/book/bowling-confirmation");
    if (!isBowling) return null;
    const neonId = parseInt(url.searchParams.get("neonId") ?? "", 10);
    return Number.isFinite(neonId) && neonId > 0 ? neonId : null;
  } catch {
    return null;
  }
}

// Lane-open prompt lifecycle. "idle" keeps polling (lane not ready yet);
// "ready" asks the guest; "open" covers both self-opened and already-Running
// (staff opened it first); "declined"/"failed" are terminal for this screen.
type LanePhase = "idle" | "ready" | "opening" | "open" | "declined" | "failed";

export function KioskConfirmation({ src }: { src: string | null }) {
  const router = useRouter();
  const { config } = useKioskConfig();
  const t = useT();
  const [secondsLeft, setSecondsLeft] = useState(AUTO_RESET_SECONDS);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  // Game Zone cards bought WITH the booking — checkout stashed the charged row
  // pointers; this screen fulfills them (dispense/load) alongside the booking
  // confirmation (owner: "combining the you're-booked and card-dispense screen").
  // Read client-side after mount (sessionStorage) to keep hydration clean.
  const [gzPayload, setGzPayload] = useState<GzFulfillmentPayload | null>(null);
  const [gzBusy, setGzBusy] = useState(false);
  // Race packs bought with the booking — display-only outcome lines
  // ("1 race today · 2 banked to Eric's account"); credits already granted
  // server-side, so the stash is read-once + cleared.
  const [racePacks, setRacePacks] = useState<RacePackConfirmLine[] | null>(null);
  // POV video codes claimed with the booking (unified-reserve → checkout stash)
  // — display nicety; the durable copies are the guest email + reservation memo.
  const [povCodes, setPovCodes] = useState<string[] | null>(null);
  // V2 combo voucher minted with the booking — display nicety; the durable
  // copies are the guest email (code + QR) and the vouchers registry.
  const [vipVoucher, setVipVoucher] = useState<VipVoucherConfirmation | null>(null);
  // Checkout included a booked race (heats, not race-pack credits) — show the
  // racing "what's next" banner with the race check-in details popup.
  const [includesRacing, setIncludesRacing] = useState(false);
  const [raceInfoOpen, setRaceInfoOpen] = useState(false);
  // Kiosk funnel bottom: a paid booking reached the confirmation screen.
  // (ClarityAnalytics also fires the shared "booking:confirmed" for this path —
  // this one is the kiosk-only smart event.)
  useEffect(() => {
    clarityEvent("kiosk:confirmed");
  }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.resolve(); // defer past the sync effect body (lint + hydration)
      if (!alive) return;
      const p = readGzFulfillment();
      if (p) {
        setGzPayload(p);
        setGzBusy(true);
      }
      const packs = readRacePackConfirmation();
      if (packs) {
        setRacePacks(packs);
        clearRacePackConfirmation();
      }
      const codes = readPovConfirmation();
      if (codes) {
        setPovCodes(codes);
        clearPovConfirmation();
      }
      const voucher = readVipVoucherConfirmation();
      if (voucher) {
        setVipVoucher(voucher);
        clearVipVoucherConfirmation();
      }
      if (readKioskHasRacing()) {
        setIncludesRacing(true);
        clearKioskHasRacing();
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const code = codeFromSrc(src);

  // ── Bowling lane-open prompt ────────────────────────────────────────
  // Kiosk bookings are usually for right now, so the checkin GET's
  // self-service gate (within 30 min of booked time + physical lane Closed)
  // often says "ready" immediately. When it does, ask the guest if they'd
  // like the lane opened on the spot — same Arrived → Ready → Running POST
  // the web confirmation's check-in uses.
  const laneNeonId = useMemo(() => bowlingNeonIdFromSrc(src), [src]);
  const billId = useMemo(() => billIdFromSrc(src), [src]);
  // `includesRacing` comes from a sessionStorage flag written during checkout,
  // so it is false in any tab that did not just run the flow and would be lost
  // on a kiosk reset. The booking record answers the same question from data.
  const racingFromBooking = useIsRacingBooking(billId);
  const showRacing = includesRacing || racingFromBooking;
  const [lanePhase, setLanePhase] = useState<LanePhase>("idle");
  const [laneLabel, setLaneLabel] = useState("");

  useEffect(() => {
    if (!laneNeonId || lanePhase !== "idle") return;
    let alive = true;
    async function poll() {
      try {
        const res = await fetch(`/api/bowling/v2/reservations/${laneNeonId}/checkin`, {
          cache: "no-store",
        });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { phase?: string; laneLabel?: string };
        if (!alive) return;
        if (data.phase === "ready") {
          setLaneLabel(data.laneLabel ?? "");
          setLanePhase("ready");
        } else if (data.phase === "running" || data.phase === "completed") {
          setLaneLabel(data.laneLabel ?? "");
          setLanePhase("open");
        }
        // not_ready / cancelled → stay idle and keep polling until reset
      } catch {
        // Non-fatal — skip this tick
      }
    }
    void poll();
    const iv = setInterval(() => void poll(), 10_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [laneNeonId, lanePhase]);

  const lanePanelVisible = lanePhase !== "idle" && lanePhase !== "declined";

  async function handleOpenLane() {
    if (!laneNeonId) return;
    setLanePhase("opening");
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${laneNeonId}/checkin`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        lanesOpened?: number;
        laneLabel?: string;
      };
      if (res.ok && data.ok && (data.lanesOpened ?? 0) > 0) {
        if (data.laneLabel) setLaneLabel(data.laneLabel);
        setLanePhase("open");
        return;
      }
    } catch {
      // fall through to the verify GET
    }
    // Like the web check-in page: the lane may have opened anyway (staff /
    // partial success) — verify before telling the guest to see the desk.
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${laneNeonId}/checkin`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as { phase?: string; laneLabel?: string };
        if (data.phase === "running" || data.phase === "completed") {
          if (data.laneLabel) setLaneLabel(data.laneLabel);
          setLanePhase("open");
          return;
        }
      }
    } catch {
      // fall through to failed
    }
    setLanePhase("failed");
  }

  // Encode the CONFIRMATION URL (brand short link) as the QR so a guest can scan
  // it with their phone and land on their confirmation — the same /s/{code}
  // target the SMS + email use. Domain follows the kiosk brand (FastTrax →
  // fasttraxent.com, HeadPinz → headpinz.com); the short link redirects to
  // whichever confirmation route that booking uses. Was encoding the bare code,
  // which scanned to useless plain text.
  useEffect(() => {
    if (!code) return;
    const domain =
      config?.brand === "headpinz" ? "https://headpinz.com" : "https://fasttraxent.com";
    const qrTarget = `${domain}/s/${code}`;
    let cancelled = false;
    QRCode.toDataURL(qrTarget, {
      width: 360,
      margin: 1,
      color: { dark: "#04252b", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [code, config?.brand]);

  useEffect(() => {
    // NEVER auto-reset while cards are still dispensing/loading — the reset
    // unmounts the fulfillment mid-hardware-cycle. Countdown restarts fresh
    // when fulfillment reports done. Same for a lane-open POST in flight.
    // lanePhase in the deps also restarts the 60s countdown when the
    // lane-open prompt appears, so the guest gets the full window to answer.
    if (gzBusy || lanePhase === "opening") return;
    setSecondsLeft(AUTO_RESET_SECONDS);
    const iv = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(iv);
          // Self-update if a newer deploy is live, else soft nav (keeps fullscreen).
          void resetToKiosk(() => router.replace("/kiosk"));
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    const onTouch = () => setSecondsLeft(AUTO_RESET_SECONDS);
    document.addEventListener("pointerdown", onTouch, { passive: true });
    return () => {
      clearInterval(iv);
      document.removeEventListener("pointerdown", onTouch);
    };
  }, [router, gzBusy, lanePhase]);

  return (
    <div
      // With a card-fulfillment panel the column can exceed the canvas — scroll
      // from the top instead of center-clipping.
      className={`absolute inset-0 flex flex-col items-center gap-[36px] bg-[#000418] px-[64px] text-center ${
        gzPayload || racePacks || povCodes || lanePanelVisible || showRacing
          ? "justify-start overflow-y-auto py-[56px]"
          : "justify-center overflow-hidden"
      }`}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(70% 45% at 50% 22%, rgba(0,226,229,0.16), transparent 65%)",
        }}
      />
      <svg
        width="180"
        height="180"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#46d68c"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="relative"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="m7.5 12.5 3 3 6-7" />
      </svg>
      <h1 className="k-display relative text-[124px] leading-none">{t("confirmation.booked")}</h1>
      {/* RACING BOOKINGS DROP THIS. The racing panel below already explains
          what happens next, and the licence card offers the wallet pass
          explicitly INSTEAD of a text — so telling the same guest their links
          are on their way by text contradicts the thing we are asking them to
          do (owner 2026-08-06). Every other booking type still needs it. */}
      {!showRacing && (
        <p className="relative max-w-[30ch] text-[34px] text-white/60">
          {t("confirmation.receiptNote")}
        </p>
      )}
      {showRacing && (
        // Racing "what's next" — deliberately first panel so a racing guest
        // reads it before anything else; racing red to stand out from the
        // cyan/amber panels below.
        <div className="relative w-full max-w-[860px] rounded-[24px] border border-[#e53935]/45 bg-gradient-to-b from-[#e53935]/10 to-white/[0.03] p-[32px] text-left">
          <div className="k-eyebrow flex items-center gap-[14px] text-[#e53935]">
            <svg
              width="30"
              height="30"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#e53935"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 21V4" />
              <path d="M4 4c3-1.5 6 1.5 9 0s5-1 7 0v9c-2-1-4-1.5-7 0s-6-1.5-9 0" />
            </svg>
            {t("confirmation.racing.eyebrow")}
          </div>
          {/* TODO(i18n): inline <strong> emphasis (rich text) — the plain-string
              formatMessage engine can't render ICU tags. Localize in a later
              pass with rich-text support or a native reviewer. Kept English. */}
          <p className="mt-[14px] text-[31px] leading-snug">
            Your race <strong className="text-[#ffd9d8]">eTicket arrives by text</strong> in a few
            minutes — have it open at{" "}
            <strong className="text-[#ffd9d8]">
              Race Check-In: 1st floor, left of the Red Track.
            </strong>
          </p>
          <button
            type="button"
            onClick={() => {
              setRaceInfoOpen(true);
              clarityEvent("kiosk:race-info-open");
            }}
            // k-btn-primary recolored to racing red (its cyan bg/ink/glow are
            // the only things swapped); flex reset as on the Done button.
            style={{
              flex: "0 0 auto",
              background: "#e53935",
              color: "#fff",
              boxShadow: "0 12px 44px rgba(229,57,53,0.35)",
            }}
            className="k-btn-primary k-tap mt-[26px] w-full"
          >
            {t("confirmation.racing.howButton")}
            <svg
              width="34"
              height="34"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#fff"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
        </div>
      )}
      {lanePanelVisible && (
        <div
          className={`relative w-full max-w-[860px] rounded-[24px] border bg-white/[0.04] p-[32px] text-left ${
            lanePhase === "open"
              ? "border-[#46d68c]/40"
              : lanePhase === "failed"
                ? "border-[#f0b341]/40"
                : "border-[#00e2e5]/40"
          }`}
        >
          {(lanePhase === "ready" || lanePhase === "opening") && (
            <>
              <div className="k-eyebrow text-[#00e2e5]">
                {laneLabel
                  ? t("confirmation.lane.readyTitle", { lane: laneLabel })
                  : t("confirmation.lane.readyTitleGeneric")}
              </div>
              <p className="mt-[12px] text-[32px] leading-snug">
                {t("confirmation.lane.readyPrompt")}
              </p>
              <div className="mt-[28px] flex items-center gap-[20px]">
                <button
                  type="button"
                  disabled={lanePhase === "opening"}
                  onClick={() => void handleOpenLane()}
                  className="k-btn-primary k-tap whitespace-nowrap text-[30px]"
                >
                  {lanePhase === "opening"
                    ? t("confirmation.lane.opening")
                    : t("confirmation.lane.openButton")}
                </button>
                <button
                  type="button"
                  disabled={lanePhase === "opening"}
                  onClick={() => setLanePhase("declined")}
                  className="k-btn-ghost k-tap"
                >
                  {t("confirmation.lane.later")}
                </button>
              </div>
            </>
          )}
          {lanePhase === "open" && (
            <>
              <div className="k-eyebrow text-[#46d68c]">
                {laneLabel
                  ? t("confirmation.lane.openTitle", { lane: laneLabel })
                  : t("confirmation.lane.openTitleGeneric")}
              </div>
              <p className="mt-[12px] text-[32px] leading-snug">
                {config?.brand === "fasttrax"
                  ? t("confirmation.lane.openBody.fasttrax")
                  : t("confirmation.lane.openBody.headpinz")}
              </p>
            </>
          )}
          {lanePhase === "failed" && (
            <>
              <div className="k-eyebrow text-[#f0b341]">{t("confirmation.lane.failedTitle")}</div>
              <p className="mt-[12px] text-[32px] leading-snug">
                {t("confirmation.lane.failedBody")}
              </p>
            </>
          )}
        </div>
      )}
      {racePacks && (
        <div className="relative w-full max-w-[860px] rounded-[24px] border border-[#f0b341]/40 bg-white/[0.04] p-[32px] text-left">
          <div className="k-eyebrow text-[#f0b341]">{t("confirmation.racePacks.eyebrow")}</div>
          {/* TODO(i18n): the per-member outcome lines below are conditional,
              count-interpolated business-rule messages with inline bold (rich
              text) — "N races today · M banked", "N races banked", "Credits are
              loading…". Localize in a later pass with ICU plurals + rich-text
              support once available (and a native reviewer). Kept English so the
              numbers/wording aren't guessed. */}
          <div className="mt-[12px] space-y-[10px]">
            {racePacks.map((p, i) => (
              <div
                key={`${p.memberName}-${i}`}
                className="flex items-center justify-between gap-[16px] rounded-2xl border border-white/12 bg-white/[0.03] px-[24px] py-[16px]"
              >
                <div className="min-w-0">
                  <div className="text-[26px] font-bold">{p.memberName}</div>
                  <div className="text-[20px] text-white/50">{p.label}</div>
                </div>
                <div className="text-right text-[22px] leading-snug">
                  {p.granted ? (
                    p.usedToday > 0 ? (
                      <span className="text-[#46d68c]">
                        {p.usedToday} race{p.usedToday === 1 ? "" : "s"} today ·{" "}
                        <span className="font-extrabold">{p.banked} banked</span>
                      </span>
                    ) : (
                      <span className="text-[#46d68c]">
                        <span className="font-extrabold">{p.raceCount} races banked</span> — ready
                        any visit
                      </span>
                    )
                  ) : (
                    <span className="text-amber-300/90">
                      Credits are loading onto their account — ready in a few minutes
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {povCodes && (
        // Same purple voucher card the web confirmation + e-ticket show, zoomed
        // to kiosk scale (web-rem-sized component on the 1080px canvas).
        <div className="kiosk-zoom relative w-full max-w-[860px] text-left">
          <PovVoucherBlock
            codes={povCodes}
            // TODO(i18n): caption carries inline <strong> emphasis (rich text) —
            // the plain-string formatMessage engine can't render ICU tags.
            // Localize in a later pass with rich-text support. Kept English.
            caption={
              <>
                These codes were also <strong className="text-white/80">emailed to you</strong> —
                after your race, use them to redeem your POV video.
              </>
            }
          />
        </div>
      )}
      {vipVoucher && (
        // V2 VIP grant — the code the guest will scan back in on a later
        // visit. Product proper nouns stay English (same rule as combo names);
        // the email carries the scannable QR + full terms.
        <div className="relative w-full max-w-[860px] rounded-[24px] border-2 border-[#B8860B] bg-[#B8860B]/10 px-[48px] py-[28px] text-left">
          <div className="k-eyebrow text-[#f0b341]">Your VIP Voucher</div>
          <div className="k-display mt-2 text-[52px] tracking-widest text-white">
            {formatVoucherCode(vipVoucher.code)}
          </div>
          <p className="mt-2 text-[22px] leading-snug text-white/70">
            Game Zone cards, Laser Tag or Gel Blaster, and your Shuffly hour live on this one code
            — it was <strong className="text-white/90">emailed to you</strong> with a scannable QR.
            Valid 1 year from your race date. Not transferable.
          </p>
        </div>
      )}
      {gzPayload && (
        <KioskGzFulfillment payload={gzPayload} onBusyChange={(busy) => setGzBusy(busy)} />
      )}
      {qrDataUrl ? (
        <div className="relative rounded-[24px] bg-white p-[20px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrDataUrl}
            alt={t("confirmation.qr.alt")}
            width={300}
            height={300}
            className="block"
          />
        </div>
      ) : null}
      {/* Racing licence — below the booking QR, so the code they need right now
          stays the hero and this reads as an offer, not an instruction.

          GATED ON THE DATA, NOT ON sessionStorage. This was behind
          `includesRacing`, which reads a `kiosk:has-racing` flag written during
          checkout — so it rendered nothing in any tab that had not just been
          through the flow, and would have vanished on a real booking too if the
          kiosk had reset or storage were unavailable. The offer endpoint reads
          `racers[]` off the booking record, which IS the race-participant list,
          so a non-racing booking returns nobody and the component renders null
          on its own. */}
      <KioskLicenceOffer billId={billId} brand={config?.brand} />
      {code ? (
        <div className="relative rounded-[24px] border border-white/15 bg-white/[0.04] px-[48px] py-[24px]">
          <div className="k-eyebrow text-white/45">{t("confirmation.bookingCode")}</div>
          <div className="k-display text-[64px] tracking-widest">{code}</div>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => {
          // Don't let Done unmount the fulfillment mid-dispense — the card is
          // still in the machine until gzBusy clears.
          if (gzBusy) return;
          void resetToKiosk(() => router.replace("/kiosk"));
        }}
        disabled={gzBusy}
        // k-btn-primary is flex:1 for the wizard's action ROW; here it sits in a
        // flex COLUMN, where flex:1 stretched it into a full-height arch. Reset to
        // its intended fixed height (inline wins over the .kiosk-canvas selector).
        style={{ flex: "0 0 auto" }}
        className="k-btn-primary k-tap relative mt-[16px] h-[112px] w-full max-w-[70%] text-[36px] disabled:opacity-40"
      >
        {gzBusy ? t("confirmation.dispensing") : t("confirmation.done")}
      </button>
      <p className="relative text-[24px] text-white/40 tabular-nums">
        {gzBusy
          ? t("confirmation.dispensingHint")
          : t("confirmation.returningIn", { seconds: secondsLeft })}
      </p>
      <BrandLogo
        brand={config?.brand ?? "fasttrax"}
        className="relative h-[52px] opacity-70"
        fallbackClassName="k-display relative text-[24px] leading-none text-white/70"
      />
      {raceInfoOpen && (
        // Race check-in details popup. `fixed` resolves against the transformed
        // .kiosk-canvas ancestor, so this covers the 1080×1920 viewport even
        // when the confirmation column behind it is scrolled. The 60s auto-reset
        // keeps running (owner decision) — any tap here resets it via the
        // document-level pointerdown listener.
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#000418]/85 p-[56px]">
          <div className="max-h-full w-full overflow-y-auto rounded-[28px] border border-white/15 bg-[#071027]/95 p-[48px] text-left shadow-[0_40px_120px_rgba(0,0,0,0.6)]">
            <div className="k-eyebrow text-[#e53935]">{t("confirmation.raceCheckin.eyebrow")}</div>
            <h2 className="k-display mt-[10px] text-[64px]">
              {t("confirmation.raceCheckin.title")}
            </h2>
            <div className="mt-[30px] flex flex-col gap-[22px]">
              {RACE_CHECKIN_STEPS.map((step) => (
                <div
                  key={step.title}
                  className="flex items-start gap-[24px] rounded-[20px] border border-white/10 bg-white/[0.03] px-[28px] py-[24px]"
                >
                  <div className="flex h-[72px] w-[72px] flex-none items-center justify-center rounded-[18px] border border-[#e53935]/40 bg-[#e53935]/15">
                    {step.icon}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[30px] font-extrabold leading-tight">{step.title}</div>
                    <p className="mt-[6px] text-[26px] leading-snug text-white/70">{step.body}</p>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setRaceInfoOpen(false)}
              style={{
                flex: "0 0 auto",
                background: "#e53935",
                color: "#fff",
                boxShadow: "0 12px 44px rgba(229,57,53,0.35)",
              }}
              className="k-btn-primary k-tap mt-[34px] w-full"
            >
              {t("confirmation.raceCheckin.gotIt")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
