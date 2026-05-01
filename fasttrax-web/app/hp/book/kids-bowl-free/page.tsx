"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import HeadPinzNav from "@/components/headpinz/Nav";
import ClickwrapCheckbox from "@/components/booking/ClickwrapCheckbox";
import { CURRENT_POLICY_VERSION } from "@/lib/clickwrap";
import {
  bookableDateRange,
  isKbfBookableDate,
  isKbfPreLaunchPeriod,
  KBF_PROGRAM_START_YMD,
} from "@/lib/kbf-schedule";
import {
  setBookingLocation,
  syncLocationFromUrl,
} from "@/lib/booking-location";

/**
 * Kids Bowl Free booking wizard.
 *
 *   1. lookup     — explainer + email/phone form
 *   2. verify     — 6-digit OTP + optional "save phone for SMS 2FA"
 *   3. bowlers    — checkbox cards per kid/adult, with shoe + bumper
 *                   toggles (default ON, prefs auto-fill)
 *   4. center     — FM or Naples
 *   5. date-time  — pick a slot from the KBF web offers (Regular vs VIP)
 *   6. review     — clickwrap + parent contact + go
 *   7. confirm    — server redirect → /hp/book/kids-bowl-free/confirmation
 *
 * Mirrors the bowling wizard (`/hp/book/bowling`) for visual consistency.
 * Lane math, time-window enforcement, and price totals are all handled
 * server-side by /api/kbf/{offers,reserve} so this file stays focused
 * on UX state.
 */

const CORAL = "#fd5b56";
const GOLD = "#FFD700";
const BG = "#0a1628";

// ── Center metadata ─────────────────────────────────────────────────────────

const CENTERS: { id: string; locationKey: "headpinz" | "naples"; name: string; address: string }[] = [
  {
    id: "9172",
    locationKey: "headpinz",
    name: "HeadPinz Fort Myers",
    address: "14513 Global Pkwy, Fort Myers",
  },
  {
    id: "3148",
    locationKey: "naples",
    name: "HeadPinz Naples",
    address: "8525 Radio Ln, Naples",
  },
];

// ── Types mirroring lib/kbf-prefs.ts ────────────────────────────────────────

interface MemberPref {
  shoeSizeId: number | null;
  shoeSizeLabel: string | null;
  wantShoes: boolean | null;
  wantBumpers: boolean | null;
  lastUsedCenter: string | null;
}
interface Member {
  id: number;
  passId: number;
  relation: "kid" | "family";
  slot: number;
  firstName: string;
  lastName: string;
  birthday: string;
  prefs: MemberPref | null;
}
interface PassWithMembers {
  id: number;
  email: string;
  centerName: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  preferred2fa: "sms" | "email";
  isTest: boolean;
  fpass: boolean;
  members: Member[];
}

// Each card the parent can toggle as a bowler
interface BowlerKey {
  /** "parent" | "kid:passId:slot" | "family:passId:slot" */
  key: string;
  passId: number; // 0 for parent
  memberSlot: number; // 0 for parent
  relation: "parent" | "kid" | "family";
  displayName: string;
  isParent: boolean;
}

interface BowlerSelection {
  selected: boolean;
  wantShoes: boolean;
  shoeSizeId: number | null;
  shoeSizeLabel: string | null;
  wantBumpers: boolean;
}

// ── QAMF response types (subset we touch) ──────────────────────────────────

interface QamfTariff {
  Id: number;
  Name: string;
  Price: number;
  Duration?: string;
}
interface QamfReservationOption {
  Datetime: string;
}
interface QamfOffer {
  OfferId: number;
  Name: string;
  Tariffs?: QamfTariff[];
  ReservationOptions?: QamfReservationOption[];
}

// ── Step keys ───────────────────────────────────────────────────────────────

type Step = "lookup" | "verify" | "bowlers" | "center" | "datetime" | "review" | "submitting";

// ── Component ──────────────────────────────────────────────────────────────

export default function KidsBowlFreePage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Sync ?location=naples on mount so we can preselect the center.
  useEffect(() => {
    syncLocationFromUrl();
  }, []);

  // ── Top-level state ────────────────────────────────────────────
  const [step, setStep] = useState<Step>("lookup");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Lookup + verify
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [channel, setChannel] = useState<"email" | "sms" | null>(null);
  const [maskedDest, setMaskedDest] = useState<string>("");
  const [savePhoneOptIn, setSavePhoneOptIn] = useState(false);
  const [savePhoneValue, setSavePhoneValue] = useState("");

  // Family roster from /api/kbf/verify
  const [passes, setPasses] = useState<PassWithMembers[]>([]);
  const [bowlerSelections, setBowlerSelections] = useState<Record<string, BowlerSelection>>({});

  // Center + date + offer
  const [centerId, setCenterId] = useState<string>("");
  const [date, setDate] = useState<string>("");
  const [offers, setOffers] = useState<QamfOffer[]>([]);
  const [selectedOfferId, setSelectedOfferId] = useState<number | null>(null);
  const [selectedTariffId, setSelectedTariffId] = useState<number | null>(null);
  const [selectedTime, setSelectedTime] = useState<string>("");
  const [shoeCatalog, setShoeCatalog] = useState<{ id: number; label: string; categoryName: string }[]>([]);

  // Review
  const [clickwrapAccepted, setClickwrapAccepted] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");

  // ── Derived ────────────────────────────────────────────────────
  const preLaunch = useMemo(() => isKbfPreLaunchPeriod(), []);
  const dateOptions = useMemo(() => bookableDateRange(), []);

  // Build the bowler list from passes (parent + kids + adults)
  const bowlerKeys: BowlerKey[] = useMemo(() => {
    if (passes.length === 0) return [];
    const list: BowlerKey[] = [];
    const primary = passes[0];
    list.push({
      key: "parent",
      passId: 0,
      memberSlot: 0,
      relation: "parent",
      displayName: `${primary.firstName} ${primary.lastName}`.trim(),
      isParent: true,
    });
    for (const p of passes) {
      for (const m of p.members) {
        list.push({
          key: `${m.relation}:${p.id}:${m.slot}`,
          passId: p.id,
          memberSlot: m.slot,
          relation: m.relation,
          displayName: `${m.firstName} ${m.lastName}`.trim(),
          isParent: false,
        });
      }
    }
    return list;
  }, [passes]);

  // Initialize bowler selections when passes load. Defaults:
  //   selected: false (parent must opt themselves in)
  //   wantShoes: from saved pref OR true (auto-add all)
  //   wantBumpers: from saved pref OR true for kids, false for adults
  useEffect(() => {
    if (passes.length === 0) return;
    const init: Record<string, BowlerSelection> = {};
    const primary = passes[0];
    init["parent"] = {
      selected: false,
      wantShoes: true,
      shoeSizeId: null,
      shoeSizeLabel: null,
      wantBumpers: false,
    };
    for (const p of passes) {
      for (const m of p.members) {
        const key = `${m.relation}:${p.id}:${m.slot}`;
        const pref = m.prefs;
        init[key] = {
          selected: false,
          wantShoes: pref?.wantShoes ?? true,
          shoeSizeId: pref?.shoeSizeId ?? null,
          shoeSizeLabel: pref?.shoeSizeLabel ?? null,
          wantBumpers: pref?.wantBumpers ?? (m.relation === "kid"),
        };
      }
    }
    setBowlerSelections(init);

    // Pre-fill guest info from the primary pass.
    setGuestName(`${primary.firstName} ${primary.lastName}`.trim());
    setGuestEmail(primary.email);
    setGuestPhone(primary.phone ?? "");
  }, [passes]);

  const selectedBowlers = useMemo(
    () => bowlerKeys.filter((b) => bowlerSelections[b.key]?.selected),
    [bowlerKeys, bowlerSelections],
  );
  const playerCount = selectedBowlers.length;

  // ── Step transitions ───────────────────────────────────────────

  const handleLookup = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/kbf/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: contact.trim() }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setError(data.error || "Lookup failed");
        return;
      }
      // Test-account / opt-in bypass — skip OTP and proceed straight to bowlers.
      if (data.bypass) {
        setPasses(data.passes ?? []);
        setStep("bowlers");
        return;
      }
      setChannel(data.channel ?? "email");
      setMaskedDest(data.maskedDestination ?? "");
      setStep("verify");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  }, [contact]);

  const handleVerify = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        contact: contact.trim(),
        code: code.trim(),
      };
      if (savePhoneOptIn && savePhoneValue) {
        body.savePhone = { phone: savePhoneValue.trim() };
      }
      const res = await fetch("/api/kbf/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.verified) {
        setError(data.error || "Incorrect code");
        return;
      }
      setPasses(data.passes ?? []);
      setStep("bowlers");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }, [contact, code, savePhoneOptIn, savePhoneValue]);

  const goToCenterStep = useCallback(() => {
    if (selectedBowlers.length === 0) {
      setError("Pick at least one bowler");
      return;
    }
    setError(null);

    // Pre-select center if URL param hinted one, or if the parent's
    // pass row is for a specific center.
    if (!centerId) {
      const urlLoc = searchParams.get("location");
      if (urlLoc === "naples") setCenterId("3148");
      else if (urlLoc === "fortmyers" || urlLoc === "fort-myers") setCenterId("9172");
      else {
        // Inherit from the parent's pass center.
        const cn = passes[0]?.centerName?.toLowerCase() || "";
        if (cn.includes("naples")) setCenterId("3148");
        else if (cn.includes("fort myers")) setCenterId("9172");
      }
    }
    setStep("center");
  }, [centerId, passes, searchParams, selectedBowlers.length]);

  const loadOffers = useCallback(
    async (chosenCenterId: string, chosenDate: string) => {
      setBusy(true);
      setError(null);
      try {
        const url = `/api/kbf/offers?center=${chosenCenterId}&date=${encodeURIComponent(chosenDate)}&players=${playerCount || 1}`;
        const res = await fetch(url, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Couldn't load offers");
          setOffers([]);
          return;
        }
        if (data.gateReason) {
          setError(data.gateReason);
          setOffers([]);
          return;
        }
        setOffers(Array.isArray(data.offers) ? data.offers : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load offers");
        setOffers([]);
      } finally {
        setBusy(false);
      }
    },
    [playerCount],
  );

  // Lazy-load shoe catalog the first time we hit the center step.
  const loadShoeCatalog = useCallback(async (chosenCenterId: string) => {
    try {
      const res = await fetch(`/api/qamf/centers/${chosenCenterId}/ShoesSize`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const flat: { id: number; label: string; categoryName: string }[] = [];
      const cats: Array<{ Id?: number; DisplayName?: string; ShoesSize?: unknown }> =
        data?.CategoriesShoesSizes || [];
      for (const c of cats) {
        const sizes = Array.isArray(c.ShoesSize) ? c.ShoesSize : [];
        for (const s of sizes) {
          if (typeof s === "object" && s && "Id" in s && "Name" in s) {
            const obj = s as { Id?: number; Name?: string };
            if (typeof obj.Id === "number" && typeof obj.Name === "string") {
              flat.push({
                id: obj.Id,
                label: obj.Name,
                categoryName: c.DisplayName ?? "",
              });
            }
          }
        }
      }
      setShoeCatalog(flat);
    } catch {
      // Non-fatal — shoe size remains a free-text label.
    }
  }, []);

  const goToDateTime = useCallback(
    async (chosenCenterId: string, chosenDate: string) => {
      setCenterId(chosenCenterId);
      setDate(chosenDate);
      // Persist for nav consistency
      const center = CENTERS.find((c) => c.id === chosenCenterId);
      if (center) setBookingLocation(center.locationKey);
      await loadShoeCatalog(chosenCenterId);
      await loadOffers(chosenCenterId, chosenDate);
      setStep("datetime");
    },
    [loadOffers, loadShoeCatalog],
  );

  const goToReview = useCallback(() => {
    if (!selectedOfferId || !selectedTariffId || !selectedTime) {
      setError("Pick a time slot");
      return;
    }
    setError(null);
    setStep("review");
  }, [selectedOfferId, selectedTariffId, selectedTime]);

  const submitReservation = useCallback(async () => {
    setBusy(true);
    setStep("submitting");
    setError(null);
    try {
      const offer = offers.find((o) => o.OfferId === selectedOfferId);
      const tariff = offer?.Tariffs?.find((t) => t.Id === selectedTariffId);
      if (!offer || !tariff) {
        setError("Couldn't resolve selected offer");
        setStep("review");
        return;
      }

      const bowlersPayload = selectedBowlers.map((b) => {
        const sel = bowlerSelections[b.key];
        return {
          passId: b.passId,
          memberSlot: b.memberSlot,
          relation: b.relation,
          name: b.displayName,
          wantShoes: sel.wantShoes,
          shoeSizeId: sel.shoeSizeId,
          shoeSizeLabel: sel.shoeSizeLabel,
          wantBumpers: sel.wantBumpers,
        };
      });

      // Fire-and-forget clickwrap log (non-fatal)
      void fetch("/api/clickwrap/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ts: new Date().toISOString(),
          email: guestEmail,
          phone: guestPhone,
          firstName: guestName.split(" ")[0] || guestName,
          amountCents: 0,
          bookingType: "attractions",
          policyVersion: CURRENT_POLICY_VERSION,
        }),
      }).catch(() => {});

      const res = await fetch("/api/kbf/reserve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          centerId,
          date,
          time: selectedTime,
          offerId: offer.OfferId,
          tariffId: tariff.Id,
          offerName: offer.Name,
          tariffPrice: tariff.Price,
          bowlers: bowlersPayload,
          guest: {
            firstName: guestName.split(" ")[0] || guestName,
            lastName: guestName.split(" ").slice(1).join(" ") || "",
            email: guestEmail,
            phone: guestPhone,
          },
          primaryPassId: passes[0]?.id,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Reservation failed");
        setStep("review");
        return;
      }
      // Server returns either an internal redirect (zero-balance) or
      // an external Square URL (paid extras). Either way, navigate.
      if (typeof window !== "undefined") {
        window.location.href = data.redirect;
      } else {
        router.push(data.redirect);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reservation failed");
      setStep("review");
    } finally {
      setBusy(false);
    }
  }, [
    bowlerSelections,
    centerId,
    date,
    guestEmail,
    guestName,
    guestPhone,
    offers,
    passes,
    router,
    selectedBowlers,
    selectedOfferId,
    selectedTariffId,
    selectedTime,
  ]);

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div style={{ backgroundColor: BG }} className="min-h-screen">
      <HeadPinzNav />

      <main className="pt-28 sm:pt-36 pb-20 px-4">
        <div className="max-w-2xl mx-auto">
          <Header step={step} preLaunch={preLaunch} />

          {error && (
            <div className="mb-4 rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}

          {step === "lookup" && (
            <LookupStep
              contact={contact}
              setContact={setContact}
              busy={busy}
              onSubmit={handleLookup}
              preLaunch={preLaunch}
            />
          )}

          {step === "verify" && (
            <VerifyStep
              channel={channel}
              maskedDest={maskedDest}
              code={code}
              setCode={setCode}
              busy={busy}
              onSubmit={handleVerify}
              onBack={() => setStep("lookup")}
              savePhoneOptIn={savePhoneOptIn}
              setSavePhoneOptIn={setSavePhoneOptIn}
              savePhoneValue={savePhoneValue}
              setSavePhoneValue={setSavePhoneValue}
            />
          )}

          {step === "bowlers" && (
            <BowlersStep
              bowlerKeys={bowlerKeys}
              selections={bowlerSelections}
              setSelections={setBowlerSelections}
              shoeCatalog={shoeCatalog}
              onContinue={goToCenterStep}
              onBack={() => setStep("verify")}
            />
          )}

          {step === "center" && (
            <CenterStep
              centerId={centerId}
              setCenterId={(id) => setCenterId(id)}
              dateOptions={dateOptions}
              date={date}
              setDate={setDate}
              onContinue={async () => {
                if (!centerId || !date) {
                  setError("Pick a center and a date");
                  return;
                }
                setError(null);
                await goToDateTime(centerId, date);
              }}
              onBack={() => setStep("bowlers")}
              busy={busy}
            />
          )}

          {step === "datetime" && (
            <OfferTimeStep
              offers={offers}
              selectedOfferId={selectedOfferId}
              setSelectedOfferId={setSelectedOfferId}
              selectedTariffId={selectedTariffId}
              setSelectedTariffId={setSelectedTariffId}
              selectedTime={selectedTime}
              setSelectedTime={setSelectedTime}
              onContinue={goToReview}
              onBack={() => setStep("center")}
              busy={busy}
              date={date}
            />
          )}

          {step === "review" && (
            <ReviewStep
              centerId={centerId}
              date={date}
              time={selectedTime}
              offerName={offers.find((o) => o.OfferId === selectedOfferId)?.Name ?? ""}
              tariffName={
                offers
                  .find((o) => o.OfferId === selectedOfferId)
                  ?.Tariffs?.find((t) => t.Id === selectedTariffId)?.Name ?? ""
              }
              bowlerCount={playerCount}
              guestName={guestName}
              setGuestName={setGuestName}
              guestEmail={guestEmail}
              setGuestEmail={setGuestEmail}
              guestPhone={guestPhone}
              setGuestPhone={setGuestPhone}
              clickwrapAccepted={clickwrapAccepted}
              setClickwrapAccepted={setClickwrapAccepted}
              busy={busy}
              onSubmit={submitReservation}
              onBack={() => setStep("datetime")}
            />
          )}

          {step === "submitting" && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
              <div className="text-white/70">Reserving your lane…</div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ── Header ─────────────────────────────────────────────────────────────────

function Header({ step, preLaunch }: { step: Step; preLaunch: boolean }) {
  const stepLabels: Record<Step, string> = {
    lookup: "Sign in",
    verify: "Verify",
    bowlers: "Who's bowling?",
    center: "When & where",
    datetime: "Pick a time",
    review: "Review",
    submitting: "Confirming…",
  };
  return (
    <div className="mb-6">
      <div
        className="uppercase font-bold mb-2"
        style={{ color: CORAL, fontSize: "11px", letterSpacing: "3px" }}
      >
        Kids Bowl Free
      </div>
      <h1
        className="font-heading font-black uppercase italic text-white"
        style={{
          fontSize: "clamp(28px, 5vw, 40px)",
          lineHeight: 1.05,
          letterSpacing: "-0.5px",
        }}
      >
        {stepLabels[step]}
      </h1>
      {preLaunch && step === "lookup" && (
        <div
          className="mt-3 rounded-xl px-4 py-3"
          style={{
            backgroundColor: "rgba(255,215,0,0.08)",
            border: "1.78px solid rgba(255,215,0,0.45)",
          }}
        >
          <p className="font-body text-white/85 text-xs sm:text-sm">
            <strong className="text-white">Special — Opening Day.</strong> Book{" "}
            <strong className="text-white">{KBF_PROGRAM_START_YMD}</strong> right
            now. Normally Kids Bowl Free reservations open 48 hours in advance.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Step: lookup ───────────────────────────────────────────────────────────

function LookupStep({
  contact,
  setContact,
  busy,
  onSubmit,
  preLaunch,
}: {
  contact: string;
  setContact: (s: string) => void;
  busy: boolean;
  onSubmit: () => void;
  preLaunch: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7">
      <p className="text-white/70 text-sm mb-4 leading-relaxed">
        Kids Bowl Free is a summer program — kids 15 and under bowl two free
        games per day, Mon–Thu open to close, Fri until 5pm. Sign in with the
        email or phone on your KBF account.
      </p>
      <label className="block">
        <span className="block text-xs uppercase tracking-wider text-white/55 mb-1.5">
          Email or phone
        </span>
        <input
          type="text"
          autoComplete="email"
          inputMode="email"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          placeholder="parent@example.com or 2391234567"
          className="w-full rounded-lg bg-white/[0.05] border border-white/10 px-3 py-3 text-white text-sm focus:outline-none focus:border-white/30"
        />
      </label>
      <button
        type="button"
        onClick={onSubmit}
        disabled={busy || !contact.trim()}
        className="mt-5 w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50"
        style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
      >
        {busy ? "Looking up…" : "Continue"}
      </button>

      <div className="mt-6 pt-5 border-t border-white/10 text-xs text-white/55">
        Don&apos;t have a Kids Bowl Free account yet?{" "}
        <Link href="/hp/kids-bowl-free/register" className="underline hover:text-white">
          Sign up at kidsbowlfree.com
        </Link>{" "}
        — new accounts take ~24h to show up here, except during opening day{" "}
        {preLaunch ? "(today: book opening day directly!)" : "promotions"}.
      </div>
    </div>
  );
}

// ── Step: verify ───────────────────────────────────────────────────────────

function VerifyStep({
  channel,
  maskedDest,
  code,
  setCode,
  busy,
  onSubmit,
  onBack,
  savePhoneOptIn,
  setSavePhoneOptIn,
  savePhoneValue,
  setSavePhoneValue,
}: {
  channel: "email" | "sms" | null;
  maskedDest: string;
  code: string;
  setCode: (s: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onBack: () => void;
  savePhoneOptIn: boolean;
  setSavePhoneOptIn: (b: boolean) => void;
  savePhoneValue: string;
  setSavePhoneValue: (s: string) => void;
}) {
  const channelLabel = channel === "sms" ? "phone" : "email";
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7">
      <p className="text-white/70 text-sm mb-4 leading-relaxed">
        We sent a 6-digit code to your {channelLabel}{" "}
        <strong className="text-white">{maskedDest}</strong>.
      </p>
      <label className="block mb-4">
        <span className="block text-xs uppercase tracking-wider text-white/55 mb-1.5">
          Verification code
        </span>
        <input
          type="text"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          placeholder="123456"
          className="w-full rounded-lg bg-white/[0.05] border border-white/10 px-3 py-3 text-white text-lg font-mono tracking-[0.4em] focus:outline-none focus:border-white/30"
        />
      </label>

      {channel === "email" && (
        <div className="mb-5 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <label className="flex items-start gap-2.5 text-sm text-white/80 cursor-pointer">
            <input
              type="checkbox"
              checked={savePhoneOptIn}
              onChange={(e) => setSavePhoneOptIn(e.target.checked)}
              className="mt-1 accent-coral"
            />
            <span>
              Save my phone for faster login next time (we&apos;ll text the code
              instead of email).
            </span>
          </label>
          {savePhoneOptIn && (
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={savePhoneValue}
              onChange={(e) => setSavePhoneValue(e.target.value)}
              placeholder="(239) 123-4567"
              className="mt-2 w-full rounded-lg bg-white/[0.05] border border-white/10 px-3 py-2 text-white text-sm focus:outline-none focus:border-white/30"
            />
          )}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || code.length !== 6}
          className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50"
          style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
        >
          {busy ? "Verifying…" : "Verify"}
        </button>
      </div>
    </div>
  );
}

// ── Step: bowlers ──────────────────────────────────────────────────────────

function BowlersStep({
  bowlerKeys,
  selections,
  setSelections,
  shoeCatalog,
  onContinue,
  onBack,
}: {
  bowlerKeys: BowlerKey[];
  selections: Record<string, BowlerSelection>;
  setSelections: (s: Record<string, BowlerSelection>) => void;
  shoeCatalog: { id: number; label: string; categoryName: string }[];
  onContinue: () => void;
  onBack: () => void;
}) {
  const update = (key: string, patch: Partial<BowlerSelection>) => {
    setSelections({ ...selections, [key]: { ...selections[key], ...patch } });
  };
  const selectedCount = bowlerKeys.filter((b) => selections[b.key]?.selected).length;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7">
      <p className="text-white/70 text-sm mb-4 leading-relaxed">
        Check who&apos;s bowling. Shoe rental defaults to on for everyone — uncheck
        if a kid is bringing their own. Saved sizes auto-fill from your last visit.
      </p>

      <div className="space-y-2.5">
        {bowlerKeys.map((b) => {
          const sel = selections[b.key];
          if (!sel) return null;
          const isOn = sel.selected;
          return (
            <div
              key={b.key}
              className="rounded-xl border bg-white/[0.02] p-3.5 transition-colors"
              style={{
                borderColor: isOn ? `${CORAL}60` : "rgba(255,255,255,0.10)",
                backgroundColor: isOn ? "rgba(253,91,86,0.06)" : "rgba(255,255,255,0.02)",
              }}
            >
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isOn}
                  onChange={(e) => update(b.key, { selected: e.target.checked })}
                  aria-label={`Bowling: ${b.displayName || "unnamed bowler"}`}
                  className="w-5 h-5 accent-coral"
                />
                <div className="flex-1">
                  <div className="text-white font-semibold text-sm">
                    {b.displayName || "(no name on file)"}
                  </div>
                  <div className="text-white/45 text-xs uppercase tracking-wider mt-0.5">
                    {b.relation === "parent"
                      ? "Account holder"
                      : b.relation === "kid"
                        ? "Kid"
                        : "Family pass adult"}
                    {sel.shoeSizeLabel && (
                      <>
                        <span className="mx-1.5 text-white/25">·</span>
                        Saved shoe: <span className="text-white/70">{sel.shoeSizeLabel}</span>
                      </>
                    )}
                  </div>
                </div>
              </label>

              {isOn && (
                <div className="mt-3 pl-8 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <label className="flex items-center gap-2 text-xs text-white/75 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sel.wantShoes}
                      onChange={(e) => update(b.key, { wantShoes: e.target.checked })}
                      className="w-4 h-4 accent-coral"
                    />
                    <span>Need rental shoes</span>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-white/75 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sel.wantBumpers}
                      onChange={(e) => update(b.key, { wantBumpers: e.target.checked })}
                      className="w-4 h-4 accent-coral"
                    />
                    <span>Bumpers</span>
                  </label>

                  {sel.wantShoes && shoeCatalog.length > 0 && (
                    <label className="col-span-1 sm:col-span-2 block">
                      <span className="block text-[10px] uppercase tracking-wider text-white/45 mb-1">
                        Shoe size
                      </span>
                      <select
                        value={sel.shoeSizeId ?? ""}
                        onChange={(e) => {
                          const id = parseInt(e.target.value, 10);
                          const found = shoeCatalog.find((s) => s.id === id);
                          update(b.key, {
                            shoeSizeId: Number.isFinite(id) ? id : null,
                            shoeSizeLabel: found ? found.label : null,
                          });
                        }}
                        className="w-full rounded-md bg-white/[0.05] border border-white/15 px-2 py-1.5 text-sm text-white focus:outline-none focus:border-white/35"
                      >
                        <option value="">— pick a size —</option>
                        {shoeCatalog.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.categoryName ? `${s.categoryName}: ` : ""}
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 text-xs text-white/55">
        {selectedCount} bowler{selectedCount === 1 ? "" : "s"} selected
      </div>

      <div className="mt-5 flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={selectedCount === 0}
          className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50"
          style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

// ── Step: center ───────────────────────────────────────────────────────────

function CenterStep({
  centerId,
  setCenterId,
  dateOptions,
  date,
  setDate,
  onContinue,
  onBack,
  busy,
}: {
  centerId: string;
  setCenterId: (id: string) => void;
  dateOptions: string[];
  date: string;
  setDate: (s: string) => void;
  onContinue: () => void;
  onBack: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7">
      <h3 className="text-white text-sm uppercase tracking-wider font-bold mb-3">
        Center
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-5">
        {CENTERS.map((c) => {
          const on = centerId === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setCenterId(c.id)}
              className="rounded-xl border p-4 text-left transition-colors"
              style={{
                borderColor: on ? `${CORAL}80` : "rgba(255,255,255,0.10)",
                backgroundColor: on ? "rgba(253,91,86,0.08)" : "rgba(255,255,255,0.02)",
              }}
            >
              <div className="text-white font-semibold text-sm">{c.name}</div>
              <div className="text-white/45 text-xs mt-0.5">{c.address}</div>
            </button>
          );
        })}
      </div>

      <h3 className="text-white text-sm uppercase tracking-wider font-bold mb-3">
        Date
      </h3>
      <div className="flex flex-col gap-2 mb-5">
        {dateOptions.length === 0 && (
          <div className="text-white/50 text-sm">
            No bookable dates right now. Check back tomorrow.
          </div>
        )}
        {dateOptions.map((ymd) => {
          const on = date === ymd;
          const display = new Date(`${ymd}T12:00:00`).toLocaleDateString("en-US", {
            weekday: "long",
            month: "short",
            day: "numeric",
          });
          return (
            <button
              key={ymd}
              type="button"
              onClick={() => setDate(ymd)}
              className="rounded-xl border px-4 py-3 text-left transition-colors"
              style={{
                borderColor: on ? `${CORAL}80` : "rgba(255,255,255,0.10)",
                backgroundColor: on ? "rgba(253,91,86,0.08)" : "rgba(255,255,255,0.02)",
              }}
            >
              <div className="text-white font-semibold text-sm">{display}</div>
              {ymd === KBF_PROGRAM_START_YMD && (
                <div
                  className="text-xs uppercase tracking-wider mt-0.5"
                  style={{ color: GOLD }}
                >
                  Opening day
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={busy || !centerId || !date || !isKbfBookableDate(date)}
          className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50"
          style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
        >
          {busy ? "Loading…" : "See times"}
        </button>
      </div>
    </div>
  );
}

// ── Step: offer + time ─────────────────────────────────────────────────────

function OfferTimeStep({
  offers,
  selectedOfferId,
  setSelectedOfferId,
  selectedTariffId,
  setSelectedTariffId,
  selectedTime,
  setSelectedTime,
  onContinue,
  onBack,
  busy,
  date,
}: {
  offers: QamfOffer[];
  selectedOfferId: number | null;
  setSelectedOfferId: (n: number | null) => void;
  selectedTariffId: number | null;
  setSelectedTariffId: (n: number | null) => void;
  selectedTime: string;
  setSelectedTime: (s: string) => void;
  onContinue: () => void;
  onBack: () => void;
  busy: boolean;
  date: string;
}) {
  const selectedOffer = offers.find((o) => o.OfferId === selectedOfferId);
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7">
      <h3 className="text-white text-sm uppercase tracking-wider font-bold mb-3">
        Tariff
      </h3>
      {offers.length === 0 && !busy && (
        <div className="text-white/55 text-sm mb-4">
          No Kids Bowl Free times available for that date.
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-5">
        {offers.map((o) => {
          const on = selectedOfferId === o.OfferId;
          const firstTariff = o.Tariffs?.[0];
          return (
            <button
              key={o.OfferId}
              type="button"
              onClick={() => {
                setSelectedOfferId(o.OfferId);
                setSelectedTariffId(firstTariff?.Id ?? null);
                setSelectedTime("");
              }}
              className="rounded-xl border p-4 text-left transition-colors"
              style={{
                borderColor: on ? `${CORAL}80` : "rgba(255,255,255,0.10)",
                backgroundColor: on ? "rgba(253,91,86,0.08)" : "rgba(255,255,255,0.02)",
              }}
            >
              <div className="text-white font-semibold text-sm">{o.Name}</div>
              {firstTariff && (
                <div className="text-white/55 text-xs mt-0.5">
                  {firstTariff.Name}
                  {firstTariff.Price > 0 ? ` · $${firstTariff.Price.toFixed(2)}` : " · Free"}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {selectedOffer && (
        <>
          <h3 className="text-white text-sm uppercase tracking-wider font-bold mb-3">
            Time
          </h3>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-5">
            {(selectedOffer.ReservationOptions ?? []).length === 0 && (
              <div className="col-span-full text-white/50 text-sm">
                No bookable times for that selection.
              </div>
            )}
            {(selectedOffer.ReservationOptions ?? []).map((slot) => {
              const time = slot.Datetime.split("T")[1] || "";
              const on = selectedTime === time;
              const display = new Date(slot.Datetime).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              });
              return (
                <button
                  key={slot.Datetime}
                  type="button"
                  onClick={() => setSelectedTime(time)}
                  className="rounded-lg border px-2 py-2 text-sm transition-colors"
                  style={{
                    borderColor: on ? `${CORAL}80` : "rgba(255,255,255,0.10)",
                    backgroundColor: on ? "rgba(253,91,86,0.10)" : "rgba(255,255,255,0.02)",
                    color: on ? "#fff" : "rgba(255,255,255,0.7)",
                    fontWeight: on ? 700 : 500,
                  }}
                >
                  {display}
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={busy || !selectedOfferId || !selectedTariffId || !selectedTime}
          className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50"
          style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
        >
          Continue
        </button>
      </div>

      {date && (
        <div className="mt-4 text-[11px] text-white/35 text-center">
          {new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </div>
      )}
    </div>
  );
}

// ── Step: review ───────────────────────────────────────────────────────────

function ReviewStep({
  centerId,
  date,
  time,
  offerName,
  tariffName,
  bowlerCount,
  guestName,
  setGuestName,
  guestEmail,
  setGuestEmail,
  guestPhone,
  setGuestPhone,
  clickwrapAccepted,
  setClickwrapAccepted,
  busy,
  onSubmit,
  onBack,
}: {
  centerId: string;
  date: string;
  time: string;
  offerName: string;
  tariffName: string;
  bowlerCount: number;
  guestName: string;
  setGuestName: (s: string) => void;
  guestEmail: string;
  setGuestEmail: (s: string) => void;
  guestPhone: string;
  setGuestPhone: (s: string) => void;
  clickwrapAccepted: boolean;
  setClickwrapAccepted: (b: boolean) => void;
  busy: boolean;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const center = CENTERS.find((c) => c.id === centerId);
  const dateLabel = date
    ? new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : "";
  const timeLabel = time
    ? new Date(`${date}T${time}:00`).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7">
      <div className="mb-5 rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-1.5 text-sm">
        <Row label="Center" value={center?.name ?? ""} />
        <Row label="Date" value={dateLabel} />
        <Row label="Time" value={timeLabel} />
        <Row label="Tariff" value={`${offerName}${tariffName ? ` — ${tariffName}` : ""}`} />
        <Row label="Bowlers" value={`${bowlerCount}`} />
      </div>

      <h3 className="text-white text-sm uppercase tracking-wider font-bold mb-2">
        Guest contact
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
        <input
          type="text"
          autoComplete="name"
          value={guestName}
          onChange={(e) => setGuestName(e.target.value)}
          placeholder="Name"
          className="rounded-lg bg-white/[0.05] border border-white/10 px-3 py-2.5 text-white text-sm focus:outline-none focus:border-white/30"
        />
        <input
          type="tel"
          autoComplete="tel"
          value={guestPhone}
          onChange={(e) => setGuestPhone(e.target.value)}
          placeholder="Phone"
          className="rounded-lg bg-white/[0.05] border border-white/10 px-3 py-2.5 text-white text-sm focus:outline-none focus:border-white/30"
        />
        <input
          type="email"
          autoComplete="email"
          value={guestEmail}
          onChange={(e) => setGuestEmail(e.target.value)}
          placeholder="Email"
          className="sm:col-span-2 rounded-lg bg-white/[0.05] border border-white/10 px-3 py-2.5 text-white text-sm focus:outline-none focus:border-white/30"
        />
      </div>

      <div className="mb-5">
        <ClickwrapCheckbox
          checked={clickwrapAccepted}
          onChange={setClickwrapAccepted}
          cancellationHours={1}
        />
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || !clickwrapAccepted || !guestName || !guestEmail || !guestPhone}
          className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50"
          style={{
            backgroundColor: CORAL,
            boxShadow: `0 0 18px ${CORAL}40`,
          }}
          title={!clickwrapAccepted ? "Please agree to the policy first" : undefined}
        >
          {busy ? "Booking…" : "Confirm reservation"}
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-white/80">
      <span className="text-white/50">{label}</span>
      <span className="text-white text-right">{value}</span>
    </div>
  );
}
