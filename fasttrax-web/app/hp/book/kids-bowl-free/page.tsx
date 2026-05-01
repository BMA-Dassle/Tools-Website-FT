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
  getBookingLocation,
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
// Each Item is a (tariff, slot) tuple — ItemId doubles as the
// WebOfferTariffId we send on book-for-later. Mirrors the bowling
// page's `interface OfferItem`.

interface QamfOfferItem {
  ItemId: number;
  Quantity: number;
  QuantityType: string;
  Time: string;          // "17:00" — HH:MM ET local
  Total: number;
  Remaining: number;
  Lanes: number;
}
interface QamfOffer {
  OfferId: number;
  Name: string;
  Description?: string;
  Items?: QamfOfferItem[];
}

// ── Step keys ───────────────────────────────────────────────────────────────

type Step = "lookup" | "verify" | "bowlers" | "datetime" | "review" | "submitting";

// ── Component ──────────────────────────────────────────────────────────────

export default function KidsBowlFreePage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Sync ?location=naples on mount so we can preselect the center.
  // KBF auto-detects the center — no UI step. Priority: ?location=
  // query param > sessionStorage from prior page > default Fort Myers.
  useEffect(() => {
    syncLocationFromUrl();
    const fromUrl = searchParams.get("location");
    let resolved: string | null = null;
    if (fromUrl === "naples") resolved = "3148";
    else if (fromUrl === "fortmyers" || fromUrl === "fort-myers") resolved = "9172";
    else {
      const stored = getBookingLocation();
      if (stored === "naples") resolved = "3148";
      else if (stored === "headpinz") resolved = "9172";
    }
    setCenterId(resolved ?? "9172"); // default Fort Myers
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Center + date + offer. `date` defaults to the first bookable
  // option (opening day during pre-launch, today otherwise) so the
  // wizard never lands on a blank date selector.
  const [centerId, setCenterId] = useState<string>("");
  const [date, setDate] = useState<string>(() => bookableDateRange()[0] ?? "");
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

  // Does any pass have family-pass status? Drives whether the
  // account holder can put themselves on a lane — KBF Regular passes
  // only cover the registered kids; the parent only bowls free if
  // they upgraded to Families Bowl Free.
  const hasFamilyPass = useMemo(() => passes.some((p) => p.fpass), [passes]);

  // Always available so we can render the booking-guest header even
  // when the parent isn't a bowler.
  const accountHolderName = useMemo(() => {
    const primary = passes[0];
    if (!primary) return "";
    return `${primary.firstName} ${primary.lastName}`.trim();
  }, [passes]);

  // Build the bowler list from passes. The account holder is only
  // surfaced as a selectable bowler when they have Families Bowl Free;
  // otherwise the wizard renders them as the booking guest only.
  const bowlerKeys: BowlerKey[] = useMemo(() => {
    if (passes.length === 0) return [];
    const list: BowlerKey[] = [];
    const primary = passes[0];
    if (hasFamilyPass) {
      list.push({
        key: "parent",
        passId: 0,
        memberSlot: 0,
        relation: "parent",
        displayName: `${primary.firstName} ${primary.lastName}`.trim(),
        isParent: true,
      });
    }
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
  }, [passes, hasFamilyPass]);

  // Initialize bowler selections when passes load. Defaults:
  //   selected: false (parent must opt themselves in)
  //   wantShoes: from saved pref OR true (auto-add all)
  //   wantBumpers: from saved pref OR true for kids, false for adults
  useEffect(() => {
    if (passes.length === 0) return;
    const init: Record<string, BowlerSelection> = {};
    const primary = passes[0];
    // Only seed a "parent" selection when they have Families Bowl Free.
    // Without it, the parent only appears as the booking guest.
    if (hasFamilyPass) {
      init["parent"] = {
        selected: false,
        wantShoes: true,
        shoeSizeId: null,
        shoeSizeLabel: null,
        wantBumpers: false,
      };
    }
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
  }, [passes, hasFamilyPass]);

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

  // No center step — auto-resolve on mount. After the bowlers step we
  // jump straight into datetime (calendar + tariff cards + time grid).
  // Default date = first bookable date (which is opening day during
  // the pre-launch promo, then today + 0/1/2 once we're past launch).

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

  /**
   * From bowlers → datetime. Auto-defaults the date to the first
   * bookable option (opening day during pre-launch, today otherwise),
   * pulls the shoe catalog, and fetches offers in one shot.
   */
  const handleBowlersContinue = useCallback(async () => {
    if (selectedBowlers.length === 0) {
      setError("Pick at least one bowler");
      return;
    }
    setError(null);
    const resolvedCenter = centerId || "9172";
    const resolvedDate = date || dateOptions[0] || "";
    if (!resolvedDate) {
      setError("No bookable dates right now. Check back tomorrow.");
      return;
    }
    await goToDateTime(resolvedCenter, resolvedDate);
  }, [centerId, date, dateOptions, goToDateTime, selectedBowlers.length]);

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
      // selectedTariffId is the chosen Item's ItemId — pull the
      // matching Item to recover price + slot duration.
      const item = offer?.Items?.find(
        (i) => i.ItemId === selectedTariffId && i.Time === selectedTime,
      );
      if (!offer || !item) {
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
          tariffId: item.ItemId,
          offerName: offer.Name,
          tariffPrice: item.Total,
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

      // Stash reservation context for the bowling confirmation page —
      // it reads `qamf_reservation` for the headline summary and
      // `qamf_confirm_data` to know which reservation key to status-poll.
      // Mirrors the keys bowling itself sets.
      if (typeof window !== "undefined" && data.reservationKey) {
        const center = CENTERS.find((c) => c.id === data.centerId);
        sessionStorage.setItem(
          "qamf_reservation",
          JSON.stringify({
            key: data.reservationKey,
            centerId: data.centerId,
            centerName: center?.name ?? "",
            offer: offer.Name,
            date,
            time: selectedTime,
            players: selectedBowlers.length,
            tariffPrice: item.Total,
            shoes: false,
            shoePrice: 0,
            addons: [],
            guestName,
            guestEmail,
          }),
        );
        sessionStorage.setItem(
          "qamf_confirm_data",
          JSON.stringify({ key: data.reservationKey, center: data.centerId, transactionId: "" }),
        );
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
              accountHolderName={accountHolderName}
              hasFamilyPass={hasFamilyPass}
              onContinue={handleBowlersContinue}
              onBack={() => setStep("verify")}
            />
          )}

          {step === "datetime" && (
            <DateTimeStep
              offers={offers}
              centerId={centerId}
              setCenterId={setCenterId}
              dateOptions={dateOptions}
              date={date}
              onChangeDate={async (ymd) => {
                setSelectedOfferId(null);
                setSelectedTariffId(null);
                setSelectedTime("");
                await goToDateTime(centerId, ymd);
              }}
              selectedOfferId={selectedOfferId}
              setSelectedOfferId={setSelectedOfferId}
              selectedTariffId={selectedTariffId}
              setSelectedTariffId={setSelectedTariffId}
              selectedTime={selectedTime}
              setSelectedTime={setSelectedTime}
              onContinue={goToReview}
              onBack={() => setStep("bowlers")}
              busy={busy}
            />
          )}

          {step === "review" && (
            <ReviewStep
              centerId={centerId}
              date={date}
              time={selectedTime}
              offerName={offers.find((o) => o.OfferId === selectedOfferId)?.Name ?? ""}
              tariffName={(() => {
                const offer = offers.find((o) => o.OfferId === selectedOfferId);
                const item = offer?.Items?.find(
                  (i) => i.ItemId === selectedTariffId && i.Time === selectedTime,
                );
                return item ? `${item.Quantity} ${item.QuantityType}` : "";
              })()}
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

/**
 * Compact on/off pill — used inside the bowler-selection card for
 * "Need shoes" + "Bumpers" toggles. Matches the visual rhythm of the
 * tariff pills below (filled accent when on, faded outline when off).
 */
function PillToggle({
  label,
  on,
  onChange,
  accent,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  accent: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="rounded-full px-3 py-2 text-xs font-bold uppercase tracking-wider transition-colors"
      style={{
        backgroundColor: on ? accent : "rgba(255,255,255,0.04)",
        color: on ? "#0a1628" : "rgba(255,255,255,0.55)",
        border: on ? `1px solid ${accent}` : "1px solid rgba(255,255,255,0.10)",
      }}
    >
      {on ? `✓ ${label}` : label}
    </button>
  );
}

function Header({ step, preLaunch }: { step: Step; preLaunch: boolean }) {
  const stepLabels: Record<Step, string> = {
    lookup: "Sign in",
    verify: "Verify",
    bowlers: "Who's bowling?",
    datetime: "When & where",
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
  accountHolderName,
  hasFamilyPass,
  onContinue,
  onBack,
}: {
  bowlerKeys: BowlerKey[];
  selections: Record<string, BowlerSelection>;
  setSelections: (s: Record<string, BowlerSelection>) => void;
  shoeCatalog: { id: number; label: string; categoryName: string }[];
  accountHolderName: string;
  hasFamilyPass: boolean;
  onContinue: () => void;
  onBack: () => void;
}) {
  const update = (key: string, patch: Partial<BowlerSelection>) => {
    setSelections({ ...selections, [key]: { ...selections[key], ...patch } });
  };
  const selectedCount = bowlerKeys.filter((b) => selections[b.key]?.selected).length;

  // Initials for the avatar pip (e.g. "Ava Test" → "AT").
  const initialsOf = (name: string): string => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    const first = parts[0]?.[0] ?? "";
    const last = parts[parts.length - 1]?.[0] ?? "";
    return (first + last).toUpperCase();
  };

  // Color the avatar by relation so kids/family/parent are visually distinct.
  const accentFor = (rel: BowlerKey["relation"]): string =>
    rel === "kid" ? CORAL : rel === "family" ? GOLD : "#7dd3fc";

  return (
    <div className="space-y-4">
      {/* Program eyebrow — Kids Bowl Free vs Families Bowl Free */}
      <div
        className="rounded-2xl px-4 py-3 flex items-center gap-3"
        style={{
          backgroundColor: hasFamilyPass
            ? "rgba(255,215,0,0.08)"
            : "rgba(253,91,86,0.06)",
          border: hasFamilyPass
            ? "1.78px solid rgba(255,215,0,0.40)"
            : "1.78px solid rgba(253,91,86,0.30)",
        }}
      >
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center font-heading font-black"
          style={{
            backgroundColor: hasFamilyPass ? "rgba(255,215,0,0.20)" : "rgba(253,91,86,0.18)",
            color: hasFamilyPass ? GOLD : CORAL,
          }}
        >
          ★
        </div>
        <div className="flex-1 min-w-0">
          <div
            className="font-heading uppercase tracking-[3px] text-[10px] mb-0.5"
            style={{ color: hasFamilyPass ? GOLD : CORAL }}
          >
            {hasFamilyPass ? "Families Bowl Free" : "Kids Bowl Free"}
          </div>
          <div className="text-white/85 text-sm font-semibold truncate">
            {accountHolderName || "Booking guest"}
          </div>
        </div>
      </div>

      {/* Helper copy + family-pass upgrade nudge */}
      <p className="text-white/65 text-sm leading-relaxed">
        Check who&apos;s bowling. Shoe rental and bumpers default to on — uncheck
        as needed. Saved sizes auto-fill from your last visit.
      </p>
      {!hasFamilyPass && (
        <p className="text-white/45 text-xs leading-relaxed">
          Kids Bowl Free covers your registered kids. Add{" "}
          <a
            href="https://www.kidsbowlfree.com/family.php"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white"
          >
            Families Bowl Free
          </a>{" "}
          to put yourself on a lane too.
        </p>
      )}

      <div className="space-y-2">
        {bowlerKeys.map((b) => {
          const sel = selections[b.key];
          if (!sel) return null;
          const isOn = sel.selected;
          const accent = accentFor(b.relation);
          const relationLabel =
            b.relation === "parent"
              ? "Account holder"
              : b.relation === "kid"
                ? "Kid"
                : "Family pass adult";
          return (
            <div
              key={b.key}
              className="rounded-2xl border bg-white/[0.02] transition-all"
              style={{
                borderColor: isOn ? `${accent}80` : "rgba(255,255,255,0.10)",
                backgroundColor: isOn
                  ? `${accent}12`
                  : "rgba(255,255,255,0.025)",
                boxShadow: isOn ? `0 0 22px ${accent}20` : undefined,
              }}
            >
              {/* Header row — clickable, big tappable area */}
              <button
                type="button"
                onClick={() => update(b.key, { selected: !isOn })}
                aria-label={`Toggle bowler ${b.displayName || "unnamed"}`}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left"
              >
                {/* Avatar */}
                <div
                  className="w-11 h-11 rounded-full flex items-center justify-center font-heading font-black text-sm shrink-0"
                  style={{
                    backgroundColor: `${accent}22`,
                    color: accent,
                    border: `1.78px solid ${accent}55`,
                  }}
                >
                  {initialsOf(b.displayName)}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="text-white font-semibold text-sm truncate">
                    {b.displayName || "(no name on file)"}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <span
                      className="inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                      style={{
                        backgroundColor: `${accent}22`,
                        color: accent,
                      }}
                    >
                      {relationLabel}
                    </span>
                    {sel.shoeSizeLabel && (
                      <span className="inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-white/10 text-white/60">
                        Shoe {sel.shoeSizeLabel}
                      </span>
                    )}
                    {sel.wantBumpers && (
                      <span className="inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-white/10 text-white/60">
                        Bumpers
                      </span>
                    )}
                  </div>
                </div>

                {/* State pill — replaces the bare checkbox with a clearer
                    BOWLING / TAP TO ADD pill that mirrors the race-pack
                    "Select" affordance. */}
                <div
                  className="text-[10px] uppercase tracking-[2px] font-bold px-3 py-1.5 rounded-full shrink-0"
                  style={{
                    backgroundColor: isOn ? accent : "rgba(255,255,255,0.06)",
                    color: isOn ? "#0a1628" : "rgba(255,255,255,0.45)",
                    border: isOn ? "none" : "1px solid rgba(255,255,255,0.10)",
                  }}
                >
                  {isOn ? "Bowling" : "Add"}
                </div>
              </button>

              {/* Expanded controls — only when selected. Tighter
                  visuals than before: shoe + bumpers as pill toggles
                  side by side; size selector below as a separate row. */}
              {isOn && (
                <div className="border-t border-white/10 px-4 py-3 space-y-2.5">
                  <div className="grid grid-cols-2 gap-2">
                    <PillToggle
                      label="Need shoes"
                      on={sel.wantShoes}
                      onChange={(v) => update(b.key, { wantShoes: v })}
                      accent={accent}
                    />
                    <PillToggle
                      label="Bumpers"
                      on={sel.wantBumpers}
                      onChange={(v) => update(b.key, { wantBumpers: v })}
                      accent={accent}
                    />
                  </div>

                  {sel.wantShoes && shoeCatalog.length > 0 && (
                    <label className="block">
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
                        style={{
                          backgroundColor: "#0a1628",
                          color: "#fff",
                          colorScheme: "dark",
                        }}
                        className="w-full rounded-md border border-white/15 px-2 py-1.5 text-sm focus:outline-none focus:border-white/35"
                      >
                        <option value="" style={{ backgroundColor: "#0a1628", color: "#fff" }}>
                          — pick a size —
                        </option>
                        {shoeCatalog.map((s) => (
                          <option
                            key={s.id}
                            value={s.id}
                            style={{ backgroundColor: "#0a1628", color: "#fff" }}
                          >
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

      <div className="text-xs text-white/55 text-center">
        {selectedCount} bowler{selectedCount === 1 ? "" : "s"} selected
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

// ── Step: datetime (calendar + tariff cards + time grid) ──────────────────

/**
 * Date pills + Center toggle + Regular/VIP cards + time grid in one
 * step. Mirrors the lane-type/offer/date pattern from /book/bowling.
 */
function DateTimeStep({
  offers,
  centerId,
  setCenterId,
  dateOptions,
  date,
  onChangeDate,
  selectedOfferId,
  setSelectedOfferId,
  selectedTariffId,
  setSelectedTariffId,
  selectedTime,
  setSelectedTime,
  onContinue,
  onBack,
  busy,
}: {
  offers: QamfOffer[];
  centerId: string;
  setCenterId: (id: string) => void;
  dateOptions: string[];
  date: string;
  onChangeDate: (ymd: string) => Promise<void>;
  selectedOfferId: number | null;
  setSelectedOfferId: (n: number | null) => void;
  selectedTariffId: number | null;
  setSelectedTariffId: (n: number | null) => void;
  selectedTime: string;
  setSelectedTime: (s: string) => void;
  onContinue: () => void;
  onBack: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* Date pills — only the bookable days during the rolling window
          (or opening week during pre-launch). Tap to switch dates. */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white text-sm uppercase tracking-wider font-bold">
            Date
          </h3>
          <span className="text-[11px] text-white/40 uppercase tracking-wider">
            {CENTERS.find((c) => c.id === centerId)?.name ?? ""}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {dateOptions.length === 0 && (
            <div className="text-white/50 text-sm">
              No bookable dates right now. Check back tomorrow.
            </div>
          )}
          {dateOptions.map((ymd) => {
            const on = date === ymd;
            const d = new Date(`${ymd}T12:00:00`);
            const wk = d.toLocaleDateString("en-US", { weekday: "short" });
            const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
            const isOpening = ymd === KBF_PROGRAM_START_YMD;
            return (
              <button
                key={ymd}
                type="button"
                disabled={busy || !isKbfBookableDate(ymd)}
                onClick={() => onChangeDate(ymd)}
                className="rounded-xl border px-3.5 py-2.5 text-left transition-colors disabled:opacity-40"
                style={{
                  borderColor: on ? `${CORAL}90` : "rgba(255,255,255,0.10)",
                  backgroundColor: on ? `${CORAL}14` : "rgba(255,255,255,0.02)",
                  minWidth: "112px",
                }}
              >
                <div className="text-white/55 text-[10px] uppercase tracking-[2px]">{wk}</div>
                <div className="text-white font-semibold text-sm">{md}</div>
                {isOpening && (
                  <div
                    className="text-[10px] uppercase tracking-wider mt-0.5"
                    style={{ color: GOLD }}
                  >
                    Opening day
                  </div>
                )}
              </button>
            );
          })}
        </div>
        {/* Compact center toggle (auto-detected, but user can override) */}
        <div className="mt-4 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[2px] text-white/35">
            Center
          </span>
          <div className="flex gap-1 bg-white/5 rounded-lg p-1">
            {CENTERS.map((c) => {
              const on = centerId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setCenterId(c.id);
                    setBookingLocation(c.locationKey);
                    setSelectedOfferId(null);
                    setSelectedTariffId(null);
                    setSelectedTime("");
                    if (date) void onChangeDate(date);
                  }}
                  className="px-3 py-1.5 rounded-md text-[11px] font-semibold transition-colors"
                  style={{
                    backgroundColor: on ? CORAL : "transparent",
                    color: on ? "#fff" : "rgba(255,255,255,0.55)",
                  }}
                >
                  {c.locationKey === "naples" ? "Naples" : "Fort Myers"}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Tariff (Regular / VIP) + time grid */}
      <OfferTimeStepBody
        offers={offers}
        selectedOfferId={selectedOfferId}
        setSelectedOfferId={setSelectedOfferId}
        selectedTariffId={selectedTariffId}
        setSelectedTariffId={setSelectedTariffId}
        selectedTime={selectedTime}
        setSelectedTime={setSelectedTime}
        busy={busy}
        date={date}
      />

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
    </div>
  );
}

// ── Tariff cards + time grid (extracted for reuse from DateTimeStep) ───────

/**
 * Tariff/time picker — mirrors the visual treatment of the bowling
 * page's `lane-type` step. Two big horizontal cards (Regular / VIP),
 * each showing what's included, a "FREE" badge on Regular, and a
 * time-slot grid that filters to the selected tariff.
 */
function OfferTimeStepBody({
  offers,
  selectedOfferId,
  setSelectedOfferId,
  selectedTariffId,
  setSelectedTariffId,
  selectedTime,
  setSelectedTime,
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
  busy: boolean;
  date: string;
}) {
  // Pin Regular first, VIP second by inferring from the offer name.
  const ordered = [...offers].sort((a, b) => {
    const av = /vip/i.test(a.Name) ? 1 : 0;
    const bv = /vip/i.test(b.Name) ? 1 : 0;
    return av - bv;
  });

  const selectedOffer = offers.find((o) => o.OfferId === selectedOfferId);

  return (
    <div className="space-y-6">
      {offers.length === 0 && !busy && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center">
          <p className="text-white/55 text-sm">
            No Kids Bowl Free times available for that date.
          </p>
        </div>
      )}

      {/* Two big cards — Regular / VIP. Mirrors the bowling lane-type step. */}
      <div className="space-y-3">
        {ordered.map((o) => {
          const on = selectedOfferId === o.OfferId;
          const isVip = /vip/i.test(o.Name);
          const accent = isVip ? GOLD : CORAL;
          const firstItem = o.Items?.[0];
          const isFree = !!firstItem && firstItem.Total === 0;
          const slotCount = o.Items?.length ?? 0;
          const features = isVip
            ? [
                "VIP lounge & dedicated lanes",
                "NeoVerse video walls",
                "Priority check-in",
                "Up to 6 bowlers per lane",
              ]
            : [
                "Standard HeadPinz lanes",
                "Up to 6 bowlers per lane",
                "Glow lighting in the evenings",
                "Bring your KBF coupon to check in",
              ];
          return (
            <button
              key={o.OfferId}
              type="button"
              onClick={() => {
                setSelectedOfferId(o.OfferId);
                setSelectedTariffId(firstItem?.ItemId ?? null);
                setSelectedTime("");
              }}
              className="w-full text-left rounded-2xl border overflow-hidden transition-all hover:scale-[1.005]"
              style={{
                borderColor: on ? `${accent}90` : "rgba(255,255,255,0.10)",
                backgroundColor: on
                  ? `${accent}14`
                  : "rgba(255,255,255,0.025)",
                boxShadow: on ? `0 0 24px ${accent}25` : undefined,
              }}
            >
              <div className="flex gap-4 p-5">
                {/* Accent bar */}
                <div
                  className="hidden sm:block w-1 rounded-full"
                  style={{ backgroundColor: accent }}
                />
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <h3
                      className="font-heading uppercase text-white text-base tracking-wider"
                      style={{ textShadow: `0 0 14px ${accent}30` }}
                    >
                      {isVip ? "Kids Bowl Free VIP" : "Kids Bowl Free Regular"}
                    </h3>
                    {isFree && (
                      <span
                        className="text-[10px] uppercase tracking-[2px] px-2 py-0.5 rounded-full font-bold"
                        style={{
                          backgroundColor: "rgba(34,197,94,0.18)",
                          color: "#4ade80",
                          border: "1px solid rgba(74,222,128,0.4)",
                        }}
                      >
                        Free
                      </span>
                    )}
                    {!isFree && firstItem && (
                      <span
                        className="text-[10px] uppercase tracking-[2px] px-2 py-0.5 rounded-full font-bold"
                        style={{
                          backgroundColor: `${accent}26`,
                          color: accent,
                          border: `1px solid ${accent}55`,
                        }}
                      >
                        ${firstItem.Total.toFixed(2)} / lane
                      </span>
                    )}
                    <span className="text-[11px] uppercase tracking-wider text-white/45">
                      {firstItem
                        ? `${firstItem.Quantity} ${firstItem.QuantityType.toLowerCase()}`
                        : ""}
                    </span>
                  </div>
                  <p className="font-body text-white/55 text-xs leading-relaxed mb-3">
                    {isVip
                      ? "Upgrade your free bowling to the VIP suite — same coupon, premium lanes."
                      : "Two free games per kid per day on participating weekdays."}
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {features.map((f) => (
                      <span key={f} className="flex items-center gap-1.5">
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: accent }}
                        />
                        <span className="font-body text-white/45 text-xs">{f}</span>
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 text-[11px] uppercase tracking-wider" style={{ color: accent }}>
                    {slotCount === 0
                      ? "Sold out"
                      : on
                        ? `Selected · pick a time below`
                        : `${slotCount} time${slotCount === 1 ? "" : "s"} available →`}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Time grid for the chosen tariff */}
      {selectedOffer && (selectedOffer.Items ?? []).length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h3 className="text-white text-sm uppercase tracking-wider font-bold mb-3">
            Pick a start time
          </h3>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {(selectedOffer.Items ?? []).map((item) => {
              const on = selectedTime === item.Time && selectedTariffId === item.ItemId;
              const [hh, mm] = item.Time.split(":");
              const display = new Date(`${date}T${hh}:${mm}:00`).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              });
              const accent = /vip/i.test(selectedOffer.Name) ? GOLD : CORAL;
              return (
                <button
                  key={`${item.ItemId}:${item.Time}`}
                  type="button"
                  onClick={() => {
                    setSelectedTariffId(item.ItemId);
                    setSelectedTime(item.Time);
                  }}
                  className="rounded-lg border px-2 py-2.5 text-sm transition-colors"
                  style={{
                    borderColor: on ? accent : "rgba(255,255,255,0.10)",
                    backgroundColor: on ? `${accent}20` : "rgba(255,255,255,0.02)",
                    color: on ? "#fff" : "rgba(255,255,255,0.7)",
                    fontWeight: on ? 700 : 500,
                  }}
                >
                  {display}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {date && (
        <div className="text-[11px] text-white/35 text-center">
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
