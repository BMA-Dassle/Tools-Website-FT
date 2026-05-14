"use client";

import Image from "next/image";
import {
  formatTime,
  formatDate,
  checkinTime,
  type RaceGroup,
  type RacerConfirmation,
  type UseRacingConfirmationReturn,
} from "@/hooks/useRacingConfirmation";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { modalBackdropProps } from "@/lib/a11y";

// ── RacingHero ─────────────────────────────────────────────────────────────

export function RacingHero({
  loading,
  error,
  bookingType,
}: {
  loading: boolean;
  error?: string | null;
  bookingType: "racing" | "attraction";
}) {
  return (
    <div className="relative overflow-hidden">
      <Image
        src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg"
        alt="FastTrax Racing"
        fill
        className="object-cover object-center"
        priority
      />
      <div className="absolute inset-0 bg-gradient-to-b from-[#000418]/60 via-[#000418]/80 to-[#000418]" />
      <div className="relative z-10 pt-36 pb-16 px-4 text-center">
        {loading ? (
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
            <p className="text-white/50 text-sm">Confirming your booking...</p>
          </div>
        ) : error ? (
          <div className="space-y-4">
            <p className="text-red-400 text-lg">{error}</p>
            <a href="/book" className="text-[#00E2E5] underline">Book an experience</a>
          </div>
        ) : (
          <>
            <div className="w-20 h-20 rounded-full bg-[#00E2E5]/20 border-2 border-[#00E2E5]/50 flex items-center justify-center mx-auto mb-4">
              <svg className="w-10 h-10 text-[#00E2E5]" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="text-4xl md:text-5xl font-display uppercase tracking-widest text-white mb-2">
              {bookingType === "racing" ? "You’re on the grid!" : "You’re booked!"}
            </h1>
            <p className="text-white/50 text-sm max-w-md mx-auto">
              Your reservation is confirmed. Show your QR code at check-in when you arrive.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ── RacingWaiverBanner ─────────────────────────────────────────────────────

export function RacingWaiverBanner({ waiverUrl }: { waiverUrl: string }) {
  return (
    <div className="max-w-2xl mx-auto rounded-2xl border-2 border-red-500/60 bg-gradient-to-br from-red-500/15 via-red-500/5 to-transparent p-5 sm:p-6 mb-8 shadow-[0_0_30px_rgba(239,68,68,0.15)]">
      <div className="flex items-start gap-4 mb-4">
        <div className="w-14 h-14 rounded-full bg-red-500/20 border-2 border-red-500/50 flex items-center justify-center shrink-0 animate-pulse">
          <svg className="w-7 h-7 text-red-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <div>
          <p className="text-red-400 text-xs font-bold uppercase tracking-widest">Action Required</p>
          <h2 className="text-white font-display text-xl sm:text-2xl uppercase tracking-wider mt-1">
            Complete Your Waiver
          </h2>
        </div>
      </div>
      <p className="text-white/80 text-sm leading-relaxed mb-4 max-w-2xl">
        <strong className="text-red-400">Every guest must complete their own waiver before participating.</strong> Each person in your party needs to sign individually. Parents or guardians must register themselves first, then add any minors to their waiver.
      </p>
      <a
        href={waiverUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-8 py-4 rounded-xl font-bold text-base bg-red-500 text-white hover:bg-red-400 transition-colors shadow-lg shadow-red-500/30"
      >
        Complete Waiver Now
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </a>
      <p className="text-white/40 text-xs mt-3">Opens in a new tab. Each participant signs their own waiver. Parents: register yourself first, then add your minors.</p>
    </div>
  );
}

// ── RacingExpressLaneBanner ────────────────────────────────────────────────

export function RacingExpressLaneBanner() {
  return (
    <div
      className="max-w-2xl mx-auto mb-6 rounded-2xl overflow-hidden border-2 border-emerald-400 animate-[expressGlow_3s_ease-in-out_infinite]"
      style={{ background: "linear-gradient(135deg, rgba(16,185,129,0.12), rgba(16,185,129,0.04))", boxShadow: "0 0 30px rgba(16,185,129,0.25), 0 0 60px rgba(16,185,129,0.1)" }}
    >
      <div className="px-6 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-emerald-500/25 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <p className="text-emerald-400 text-base sm:text-lg font-bold uppercase tracking-widest">Express Lane</p>
        </div>
        {/* Skip these */}
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-500/15 border border-red-500/30">
            <svg className="w-3.5 h-3.5 text-red-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            <span className="text-red-400 text-xs font-bold line-through">Guest Services</span>
          </span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-500/15 border border-red-500/30">
            <svg className="w-3.5 h-3.5 text-red-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            <span className="text-red-400 text-xs font-bold line-through">Event Check-In</span>
          </span>
        </div>
        {/* Go here */}
        <div className="flex items-center gap-2">
          <svg className="w-6 h-6 text-emerald-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
          <p className="text-emerald-400 text-lg sm:text-xl font-black uppercase tracking-wide">Head straight to Karting!</p>
        </div>
        <p className="text-white/50 text-sm">1st Floor — Arrive 5 min before your race. Have this page ready on your phone.</p>
      </div>
    </div>
  );
}

/** The keyframe animation for express lane glow — inject once. */
export function ExpressGlowStyle() {
  return (
    <style>{`
      @keyframes expressGlow {
        0%, 100% { box-shadow: 0 0 15px rgba(16,185,129,0.3), 0 0 30px rgba(16,185,129,0.15), 0 0 60px rgba(16,185,129,0.05); border-color: rgba(16,185,129,0.5); }
        33% { box-shadow: 0 0 40px rgba(16,185,129,0.8), 0 0 80px rgba(16,185,129,0.4), 0 0 140px rgba(16,185,129,0.2); border-color: rgba(16,185,129,1); }
        66% { box-shadow: 0 0 25px rgba(16,185,129,0.5), 0 0 60px rgba(16,185,129,0.25), 0 0 100px rgba(16,185,129,0.1); border-color: rgba(16,185,129,0.7); }
      }
    `}</style>
  );
}

// ── RacingHeatCard (express lane variant) ──────────────────────────────────

export function RacingHeatCard({
  group,
  expressLane,
  qr,
  checkInLocation,
  isMyHeat,
  onQrClick,
}: {
  group: RaceGroup;
  expressLane: boolean;
  qr: string | null;
  checkInLocation: "fasttrax" | "headpinz";
  isMyHeat: boolean;
  onQrClick: (src: string, resNumber: string) => void;
}) {
  const trackName = group.track === "Red" ? "Red Track" : group.track === "Blue" ? "Blue Track" : group.track === "Mega" ? "Mega Track" : null;
  const trackColor = group.track === "Red" ? "#E53935" : group.track === "Blue" ? "#004AAD" : group.track === "Mega" ? "#8B5CF6" : "#00E2E5";
  const raceType = /pro/i.test(group.product) ? "Pro"
    : /intermediate/i.test(group.product) ? "Intermediate"
    : "Starter";
  const heatNum = group.heatName?.match(/\d+/)?.[0] || "";

  return (
    <div
      className={`rounded-2xl overflow-hidden ${
        expressLane
          ? "border-2 border-emerald-400 animate-[expressGlow_3s_ease-in-out_infinite]"
          : "border border-white/10 bg-white/[0.03]"
      }`}
      style={expressLane ? { background: "linear-gradient(135deg, rgba(16,185,129,0.08), rgba(16,185,129,0.02))", boxShadow: "0 0 20px rgba(16,185,129,0.15), 0 0 40px rgba(16,185,129,0.07)" } : undefined}
    >
      <div className="p-5 sm:p-6">
        {/* YOUR HEAT banner */}
        {isMyHeat && (
          <div className="mb-3 rounded-lg bg-amber-500/20 border border-amber-500/50 px-4 py-2">
            <p className="text-amber-400 font-bold text-sm uppercase tracking-wider text-center">
              🏁 Your Heat Is Now Checking In!
            </p>
          </div>
        )}

        {/* Track badge */}
        {trackName && (
          <div className="mb-3">
            <span
              className="text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full"
              style={{ color: trackColor, backgroundColor: `${trackColor}20`, border: `1px solid ${trackColor}40` }}
            >
              {group.track || "Race"} {raceType}{heatNum ? ` ${heatNum}` : ""}
            </span>
          </div>
        )}

        {/* Racer names */}
        <div>
          {group.racers.map((name, ri) => (
            <p key={ri} className="text-white font-display uppercase tracking-wider leading-none" style={{ fontSize: "clamp(36px, 10vw, 60px)" }}>{name}</p>
          ))}
        </div>

        {/* Time */}
        {group.heatStart && (
          <div className="mt-3">
            {expressLane ? (
              <>
                <p className="text-emerald-400 text-xs font-bold uppercase tracking-wider">Race Time</p>
                <p className="text-white font-display uppercase tracking-wider leading-none" style={{ fontSize: "clamp(48px, 14vw, 72px)" }}>{formatTime(group.heatStart)}</p>
                <p className="text-emerald-400/60 text-xs mt-1">Arrive 5 min before — go straight to Karting, 1st Floor</p>
              </>
            ) : (
              <>
                <p className="text-red-400 text-xs font-bold uppercase tracking-wider">Check In By</p>
                <p className="text-white font-display text-3xl sm:text-4xl uppercase tracking-widest">{checkinTime(group.heatStart)}</p>
                <p className="text-white/30 text-xs">{checkInLocation === "fasttrax" ? "FastTrax — Guest Services, 2nd Floor" : "HeadPinz — Guest Services"}</p>
              </>
            )}
          </div>
        )}

        {/* Date, address, reservation number */}
        {group.heatStart && <p className="text-white/40 text-xs mt-2">{formatDate(group.heatStart)}</p>}
        <p className="text-white/20 text-xs">14501 Global Parkway, Fort Myers</p>
        <p className={`font-bold text-xs mt-2 ${expressLane ? "text-emerald-400/50" : "text-[#00E2E5]/50"}`}>{group.resNumber}</p>
      </div>

      {/* QR (non-express only) */}
      {qr && !expressLane && (
        <div className="border-t border-white/[0.06] px-5 py-4 flex justify-center">
          <button className="cursor-pointer" onClick={() => onQrClick(qr, group.resNumber)}>
            <div className="rounded-lg bg-white p-1.5 hover:shadow-lg hover:shadow-[#00E2E5]/20 transition-shadow">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt={`QR ${group.resNumber}`} width={100} height={100} className="w-[80px] h-[80px]" />
            </div>
            <p className="text-white/20 text-xs text-center mt-1">Tap to enlarge</p>
          </button>
        </div>
      )}
    </div>
  );
}

// ── RacingPovCodes ─────────────────────────────────────────────────────────

export function RacingPovCodes({ codes }: { codes: string[] }) {
  if (codes.length === 0) return null;
  return (
    <div className="lg:col-span-2 mt-6 rounded-2xl border border-purple-500/20 bg-purple-500/5 p-6 sm:p-8">
      <h3 className="font-display text-white text-xl uppercase tracking-widest mb-4">Your ViewPoint POV Camera Codes</h3>

      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 mb-3 flex items-start gap-3">
        <span aria-hidden="true" className="text-xl leading-none">📨</span>
        <div>
          <p className="text-emerald-300 text-sm font-semibold mb-0.5">
            Heads-up sent automatically
          </p>
          <p className="text-white/60 text-xs leading-relaxed">
            About 5–10 minutes after your race, you&apos;ll get an <strong className="text-white/80">email and text</strong> letting you know your video is ready.
            Use the codes below to redeem it.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 mt-4">
        {codes.map((code, i) => (
          <div key={i} className="bg-white/10 border border-purple-500/30 rounded-lg px-5 py-3">
            <p className="text-purple-300 text-xs font-semibold uppercase tracking-wider mb-1">Code {i + 1}</p>
            <p className="text-white font-mono text-xl font-bold tracking-wider">{code}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── RacingRookiePackCard ───────────────────────────────────────────────────

export function RacingRookiePackCard() {
  return (
    <div className="lg:col-span-2 mt-6 rounded-2xl border-2 border-amber-400/50 bg-amber-500/10 overflow-hidden">
      <div className="p-5 sm:p-8 grid gap-6 lg:grid-cols-[minmax(0,1fr),minmax(0,360px)] lg:items-center">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span aria-hidden="true" className="text-2xl">🍴</span>
            <p className="text-amber-300 text-xs font-bold uppercase tracking-widest">
              Rookie Pack — Included
            </p>
          </div>
          <h3 className="text-2xl font-display uppercase tracking-widest text-white mb-2">
            Your Free Appetizer
          </h3>
          <p className="text-white/70 text-sm leading-relaxed mb-4">
            Join us upstairs at <strong className="text-white">Nemo&apos;s</strong> before
            or after your race. Show this code at the bar — one free appetizer per group.
          </p>
          <div className="space-y-1.5 text-xs text-white/60">
            <p className="font-semibold text-white/80">Choose one:</p>
            <ul className="ml-4 space-y-0.5 list-disc list-inside marker:text-amber-400/60">
              <li>Bruschetta</li>
              <li>GF Mac &amp; Cheese Bites</li>
              <li>Fried Zucchini Sticks</li>
            </ul>
            <p className="text-white/40 pt-2">One per group · Dine-in only · Race day only</p>
          </div>
        </div>
        <div className="space-y-3">
          <div className="rounded-lg bg-amber-400/10 border border-amber-400/30 px-3 py-2">
            <p className="text-amber-200 text-xs font-bold uppercase tracking-wider text-center">
              ⏰ Valid Race Day Only
            </p>
          </div>
          <div className="rounded-xl bg-black/30 border border-amber-400/40 px-4 py-5 text-center">
            <p className="text-[10px] uppercase tracking-widest text-amber-300/70 mb-1">Coupon Code</p>
            <p className="font-mono font-bold text-amber-300 text-3xl sm:text-4xl tracking-[0.2em]">
              RACEAPP
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── RacerJourneySteps ──────────────────────────────────────────────────────

const JOURNEY_STEPS = [
  {
    num: "1",
    title: "ARRIVE 30 MINUTES EARLY",
    subtitle: "",
    desc: "Give yourself the \"Pre-Race Window.\" Arriving early gives you time for any unexpected lines at check-in so you're cleared for the pits without losing a second of track time.",
    color: "rgb(228,28,29)",
  },
  {
    num: "2",
    title: "THE PIT GATE",
    subtitle: "Guest Services — 2nd Floor",
    desc: "STOP HERE FIRST. This is where we verify waivers, check heights/ages, and issue your racing credentials. On weekends, additional team members are at our event check-in desk on the 1st floor.",
    color: "rgb(0,74,173)",
  },
  {
    num: "3",
    title: "TRACKSIDE CHECK-IN",
    subtitle: "1st Floor Karting Counter",
    desc: "Your race time is the close of karting check-in for your heat — not the start. Be at the 1st floor karting counter at least 5 minutes before your scheduled time to rent your POV camera and enter the safety briefing.",
    color: "rgb(134,82,255)",
  },
];

function dotColor(status: string) {
  return status === "ok" ? "bg-green-400" : status === "delayed" ? "bg-yellow-400" : "bg-red-400";
}

export function RacerJourneySteps({
  liveStatus,
}: {
  liveStatus: ReturnType<typeof useTrackStatus>;
}) {
  const trackData = liveStatus?.trackStatus ?? null;
  const currentRaces = liveStatus?.currentRaces ?? null;

  return (
    <div className="space-y-4">
      <div className="text-center mb-2">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          The Racer&apos;s Journey
        </h2>
        <p className="text-white/40 text-sm">Arrive to Drive</p>
      </div>

      {trackData && (
        <div className="space-y-1.5">
          <p className="text-white/30 text-xs uppercase tracking-wider font-semibold">Live Track Status</p>
          {trackData.tracks.map((t) => {
            const key = t.trackName.toLowerCase().replace(/\s+track/i, "") as "blue" | "red" | "mega";
            const race = currentRaces?.[key] ?? null;
            return (
              <div
                key={t.trackName}
                className="px-3 py-2 rounded-lg"
                style={{ backgroundColor: "rgba(1,10,32,0.6)", border: `1px solid ${t.colors.trackIdentity}50` }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold" style={{ color: t.colors.trackIdentity }}>{t.trackName}</span>
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${dotColor(t.status)}`} />
                    <span className="text-white/70 text-xs">{t.delayFormatted}</span>
                  </div>
                </div>
                {race && (() => {
                  let time = "";
                  try { time = race.scheduledStart ? new Date(race.scheduledStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : ""; } catch { /* skip */ }
                  return (
                    <p className="text-amber-400 text-[11px] font-bold mt-1">
                      Now Checking In: {race.raceType} #{race.heatNumber}{time ? ` · ${time}` : ""}
                    </p>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-3">
        {JOURNEY_STEPS.map((s) => (
          <div
            key={s.num}
            className="flex gap-3 items-start p-3 rounded-2xl"
            style={{ backgroundColor: "rgba(7,16,39,0.6)", border: `1.5px dashed ${s.color}40` }}
          >
            <div
              className="shrink-0 flex items-center justify-center font-display text-white text-lg rounded-md"
              style={{ backgroundColor: s.color, width: "36px", height: "48px" }}
            >
              {s.num}
            </div>
            <div>
              <h3 className="font-display uppercase text-sm" style={{ color: s.color }}>{s.title}</h3>
              {s.subtitle && <p className="text-white/40 text-[13px]">{s.subtitle}</p>}
              <p className="text-white/70 text-xs leading-relaxed mt-1">{s.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── ExpressTrackStatus ─────────────────────────────────────────────────────

export function ExpressTrackStatus({
  liveStatus,
}: {
  liveStatus: ReturnType<typeof useTrackStatus>;
}) {
  if (!liveStatus) return null;
  const { trackStatus: trackData, currentRaces } = liveStatus;
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <p className="text-white/40 text-xs uppercase tracking-wider font-semibold mb-3">Live Track Status</p>
      <div className="space-y-2">
        {trackData.tracks.map((t) => {
          const key = t.trackName.toLowerCase().replace(/\s+track/i, "") as "blue" | "red" | "mega";
          const race = currentRaces[key] || null;
          return (
            <div
              key={t.trackName}
              className="px-4 py-2.5 rounded-lg"
              style={{ backgroundColor: "rgba(1,10,32,0.6)", border: `1px solid ${t.colors.trackIdentity}50` }}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold" style={{ color: t.colors.trackIdentity }}>{t.trackName}</span>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${dotColor(t.status)}`} />
                  <span className="text-white/70 text-sm">{t.delayFormatted}</span>
                </div>
              </div>
              {race && (() => {
                let time = "";
                try { time = race.scheduledStart ? new Date(race.scheduledStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : ""; } catch { /* skip */ }
                return (
                  <p className="text-amber-400 text-xs font-bold mt-1">
                    Now Checking In: {race.raceType} #{race.heatNumber}{time ? ` · ${time}` : ""}
                  </p>
                );
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── FullscreenQrModal ──────────────────────────────────────────────────────

export function FullscreenQrModal({
  src,
  resNumber,
  onClose,
}: {
  src: string;
  resNumber: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-white flex flex-col items-center justify-center"
      {...modalBackdropProps(onClose)}
    >
      <div className="text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="QR Code" className="w-[280px] h-[280px] sm:w-[350px] sm:h-[350px] mx-auto" />
        <p className="text-black font-bold text-3xl mt-6">{resNumber}</p>
        <p className="text-gray-500 text-sm mt-2">Tap anywhere to close</p>
      </div>
    </div>
  );
}
