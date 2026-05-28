"use client";

import { useEffect, useState } from "react";
import {
  RACE_PACK_VARIANTS,
  type RacePackVariant,
  packTax,
  packTotal,
} from "~/features/booking/data/race-packs";
import { purchasePack } from "~/features/booking/service/credit-pack";
import {
  ReturningRacerLookup,
  type PersonData,
} from "~/components/features/booking/steps/race/ReturningRacerLookup";
import PaymentForm from "@/components/square/PaymentForm";
import ClickwrapCheckbox from "@/components/booking/ClickwrapCheckbox";

type Step = "select" | "racer" | "checkout";

interface NewRacerForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
}

const EMPTY_FORM: NewRacerForm = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  dob: "",
};

const RACE_COUNTS = [3, 5, 10] as const;

interface Props {
  brand: "fasttrax" | "headpinz";
}

export default function RacePackFlow({ brand }: Props) {
  const [step, setStep] = useState<Step>("select");
  const [selectedPack, setSelectedPack] = useState<RacePackVariant | null>(null);
  const [racerMode, setRacerMode] = useState<"choose" | "returning" | "new">(
    "choose",
  );
  const [person, setPerson] = useState<PersonData | null>(null);
  const [newRacer, setNewRacer] = useState<NewRacerForm>(EMPTY_FORM);
  const [isNewRacer, setIsNewRacer] = useState(false);
  const [clickwrapAccepted, setClickwrapAccepted] = useState(false);

  // ── URL sync ──────────────────────────────────────────────────────

  function goTo(newStep: Step, packId?: string) {
    const params = new URLSearchParams();
    if (newStep !== "select") params.set("step", newStep);
    const pid = packId || selectedPack?.id;
    if (pid) params.set("packId", pid);
    const qs = params.toString();
    window.history.pushState(
      {},
      "",
      `/book/race-pack/v2${qs ? `?${qs}` : ""}`,
    );
    setStep(newStep);
    window.scrollTo(0, 0);
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pid = params.get("packId");
    if (pid) {
      const p = RACE_PACK_VARIANTS.find((v) => v.id === pid);
      if (p) setSelectedPack(p);
    }
    const s = params.get("step") as Step | null;
    if (s === "racer" && pid) setStep("racer");

    function onPop() {
      const p = new URLSearchParams(window.location.search);
      const nextStep = (p.get("step") || "select") as Step;
      const id = p.get("packId");
      if (id) {
        const pack = RACE_PACK_VARIANTS.find((v) => v.id === id);
        if (pack) setSelectedPack(pack);
      }
      setStep(nextStep === "checkout" ? "select" : nextStep);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ──────────────────────────────────────────────────────

  function handleSelectPack(pack: RacePackVariant) {
    setSelectedPack(pack);
    setClickwrapAccepted(false);
    goTo("racer", pack.id);
  }

  function handleVerified(p: PersonData) {
    setPerson(p);
    setIsNewRacer(false);
    goTo("checkout");
  }

  function handleNewRacerContinue() {
    if (
      !newRacer.firstName ||
      !newRacer.lastName ||
      !newRacer.email ||
      !newRacer.phone
    )
      return;
    setIsNewRacer(true);
    setPerson(null);
    goTo("checkout");
  }

  function getContact() {
    if (person) {
      const parts = person.fullName.split(" ");
      return {
        firstName: parts[0] || "",
        lastName: parts.slice(1).join(" ") || "",
        email: person.email,
        phone: person.phone || "",
      };
    }
    return {
      firstName: newRacer.firstName,
      lastName: newRacer.lastName,
      email: newRacer.email,
      phone: newRacer.phone,
    };
  }

  async function handleTokenize(params: {
    cardNonce: string | null;
    savedCardId: string | null;
    giftCardNonce: string | null;
  }) {
    const contact = getContact();
    const result = await purchasePack({
      packId: selectedPack!.id,
      personId: person?.personId,
      newPerson: isNewRacer
        ? {
            firstName: newRacer.firstName,
            lastName: newRacer.lastName,
            email: newRacer.email,
            phone: newRacer.phone,
            dob: newRacer.dob || undefined,
          }
        : undefined,
      cardNonce: params.cardNonce ?? undefined,
      savedCardId: params.savedCardId ?? undefined,
      giftCardNonce: params.giftCardNonce ?? undefined,
      contact,
      racerName:
        person?.fullName || `${newRacer.firstName} ${newRacer.lastName}`,
      loginCode: person?.loginCode,
    });

    sessionStorage.setItem(
      `payment_${result.billId}`,
      JSON.stringify({ depositCreditFailed: result.depositCreditPending }),
    );
    window.location.href = `/book/race-packs/confirmation?billId=${encodeURIComponent(result.billId)}`;
  }

  // ── Step 1: Select Pack ───────────────────────────────────────────

  if (step === "select") {
    return (
      <div className="max-w-2xl mx-auto px-4 pb-20">
        <div className="text-center mb-8">
          <h1 className="text-3xl sm:text-4xl font-display uppercase tracking-widest text-white">
            Race Packs
          </h1>
          <p className="text-white/50 text-sm mt-2">
            Buy race credits in bulk and save. Credits are linked to your racer
            account.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="text-center text-[10px] font-bold uppercase tracking-widest text-white/30">
            Mon – Thu
          </div>
          <div className="text-center text-[10px] font-bold uppercase tracking-widest text-white/30">
            Anytime
          </div>
        </div>

        {RACE_COUNTS.map((count) => {
          const weekday = RACE_PACK_VARIANTS.find(
            (v) => v.raceCount === count && v.type === "weekday",
          )!;
          const anytime = RACE_PACK_VARIANTS.find(
            (v) => v.raceCount === count && v.type === "anytime",
          )!;
          return (
            <div key={count} className="grid grid-cols-2 gap-3 mb-3">
              <PackCard pack={weekday} onSelect={handleSelectPack} />
              <PackCard pack={anytime} onSelect={handleSelectPack} />
            </div>
          );
        })}

        <p className="text-white/30 text-xs text-center mt-6">
          All prices exclude 6.5% FL sales tax, calculated at checkout.
        </p>
      </div>
    );
  }

  // ── Step 2: Identify Racer ────────────────────────────────────────

  if (step === "racer" && selectedPack) {
    return (
      <div className="max-w-md mx-auto px-4 pb-20">
        <BackButton onClick={() => goTo("select")} />

        <div className="text-center mb-6">
          <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-widest mb-1">
            {selectedPack.squareLineItemName}
          </p>
          <h2 className="text-2xl font-display uppercase tracking-widest text-white">
            Who is this for?
          </h2>
          <p className="text-white/40 text-xs mt-1">
            Credits are tied to a racer account.
          </p>
        </div>

        {racerMode === "choose" && (
          <div className="space-y-3">
            <button
              onClick={() => setRacerMode("returning")}
              className="w-full p-4 rounded-xl border border-white/10 bg-white/[0.03] hover:border-[#00E2E5]/40 hover:bg-[#00E2E5]/5 transition-all text-left"
            >
              <p className="text-white font-semibold text-sm">
                I have a racer account
              </p>
              <p className="text-white/40 text-xs mt-0.5">
                Look up by phone, email, or login code
              </p>
            </button>
            <button
              onClick={() => setRacerMode("new")}
              className="w-full p-4 rounded-xl border border-white/10 bg-white/[0.03] hover:border-[#00E2E5]/40 hover:bg-[#00E2E5]/5 transition-all text-left"
            >
              <p className="text-white font-semibold text-sm">
                I&apos;m a new racer
              </p>
              <p className="text-white/40 text-xs mt-0.5">
                Create an account and add credits
              </p>
            </button>
          </div>
        )}

        {racerMode === "returning" && (
          <div>
            <button
              onClick={() => setRacerMode("choose")}
              className="text-white/40 hover:text-white text-xs mb-4 flex items-center gap-1"
            >
              <span>&larr;</span> Different option
            </button>
            <ReturningRacerLookup
              onVerified={handleVerified}
              onSwitchToNew={() => setRacerMode("new")}
            />
          </div>
        )}

        {racerMode === "new" && (
          <div>
            <button
              onClick={() => setRacerMode("choose")}
              className="text-white/40 hover:text-white text-xs mb-4 flex items-center gap-1"
            >
              <span>&larr;</span> Different option
            </button>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  placeholder="First name"
                  value={newRacer.firstName}
                  onChange={(e) =>
                    setNewRacer({ ...newRacer, firstName: e.target.value })
                  }
                  className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-[#00E2E5]/50"
                />
                <input
                  type="text"
                  placeholder="Last name"
                  value={newRacer.lastName}
                  onChange={(e) =>
                    setNewRacer({ ...newRacer, lastName: e.target.value })
                  }
                  className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-[#00E2E5]/50"
                />
              </div>
              <input
                type="email"
                placeholder="Email"
                value={newRacer.email}
                onChange={(e) =>
                  setNewRacer({ ...newRacer, email: e.target.value })
                }
                className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-[#00E2E5]/50"
              />
              <input
                type="tel"
                placeholder="Phone"
                value={newRacer.phone}
                onChange={(e) =>
                  setNewRacer({ ...newRacer, phone: e.target.value })
                }
                className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-[#00E2E5]/50"
              />
              <input
                type="date"
                placeholder="Date of birth"
                value={newRacer.dob}
                onChange={(e) =>
                  setNewRacer({ ...newRacer, dob: e.target.value })
                }
                className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-[#00E2E5]/50 [color-scheme:dark]"
              />
              <button
                onClick={handleNewRacerContinue}
                disabled={
                  !newRacer.firstName ||
                  !newRacer.lastName ||
                  !newRacer.email ||
                  !newRacer.phone
                }
                className="w-full py-3 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Continue to Review
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Step 3: Review & Pay ──────────────────────────────────────────

  if (step === "checkout" && selectedPack) {
    const contact = getContact();
    const racerName =
      person?.fullName || `${newRacer.firstName} ${newRacer.lastName}`;
    const subtotal = selectedPack.price;
    const tax = packTax(subtotal);
    const total = packTotal(subtotal);
    const perRace = (subtotal / selectedPack.raceCount).toFixed(2);

    return (
      <div className="max-w-md mx-auto px-4 pb-20">
        <BackButton onClick={() => goTo("racer")} />

        <div className="text-center mb-6">
          <h2 className="text-2xl font-display uppercase tracking-widest text-white">
            Review &amp; Pay
          </h2>
        </div>

        {/* Pack summary */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-white font-semibold text-sm">
              {selectedPack.name}
            </h3>
            <span
              className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                selectedPack.type === "anytime"
                  ? "bg-[#00E2E5]/15 text-[#00E2E5]"
                  : "bg-amber-500/15 text-amber-400"
              }`}
            >
              {selectedPack.type === "anytime" ? "Anytime" : "Mon–Thu"}
            </span>
          </div>
          <div className="text-white/40 text-xs space-y-0.5">
            <p>
              {selectedPack.raceCount} races &middot; ${perRace}/race
            </p>
          </div>
          <button
            onClick={() => goTo("select")}
            className="text-[#00E2E5] text-xs mt-2 hover:underline"
          >
            Change pack
          </button>
        </div>

        {/* Racer */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white font-semibold text-sm">{racerName}</p>
              <p className="text-white/40 text-xs">{contact.email}</p>
            </div>
            {isNewRacer && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">
                New
              </span>
            )}
          </div>
          <button
            onClick={() => goTo("racer")}
            className="text-[#00E2E5] text-xs mt-2 hover:underline"
          >
            Change racer
          </button>
        </div>

        {/* Price breakdown */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-white/50">Subtotal</span>
            <span className="text-white">${subtotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-white/50">Tax (6.5%)</span>
            <span className="text-white">${tax.toFixed(2)}</span>
          </div>
          <div className="border-t border-white/10 pt-2 flex justify-between text-sm font-bold">
            <span className="text-white">Total</span>
            <span className="text-[#00E2E5]">${total.toFixed(2)}</span>
          </div>
        </div>

        {/* Disclaimers */}
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 mb-4 space-y-2">
          {selectedPack.type === "weekday" && (
            <p className="text-amber-400/80 text-xs">
              Weekday pack credits are valid Monday through Thursday only.
            </p>
          )}
          <p className="text-white/30 text-xs">
            Credits are non-transferable and tied to the racer account above.
            To use credits, book a race online and they will be applied
            automatically at checkout.
          </p>
        </div>

        {/* Clickwrap */}
        <div className="mb-6">
          <ClickwrapCheckbox
            checked={clickwrapAccepted}
            onChange={setClickwrapAccepted}
          />
        </div>

        {/* Payment */}
        {clickwrapAccepted && (
          <PaymentForm
            amount={total}
            itemName={selectedPack.squareLineItemName}
            billId="pack-pending"
            contact={contact}
            locationId="fasttrax"
            onSuccess={() => {}}
            onError={() => {}}
            onTokenize={handleTokenize}
          />
        )}

        {!clickwrapAccepted && (
          <p className="text-white/20 text-xs text-center">
            Accept the cancellation policy above to continue to payment.
          </p>
        )}
      </div>
    );
  }

  return null;
}

// ── Helper Components ─────────────────────────────────────────────

function PackCard({
  pack,
  onSelect,
}: {
  pack: RacePackVariant;
  onSelect: (p: RacePackVariant) => void;
}) {
  const perRace = (pack.price / pack.raceCount).toFixed(2);
  return (
    <button
      onClick={() => onSelect(pack)}
      className="w-full rounded-xl border border-white/10 bg-white/[0.03] p-4 hover:border-[#00E2E5]/40 hover:bg-[#00E2E5]/5 transition-all text-left group"
    >
      <p className="text-white font-display text-lg uppercase tracking-wider">
        {pack.raceCount}
        <span className="text-white/40 text-xs font-sans normal-case tracking-normal ml-1">
          races
        </span>
      </p>
      <p className="text-[#00E2E5] font-bold text-xl mt-1">
        ${pack.price.toFixed(2)}
      </p>
      <p className="text-white/30 text-[11px] mt-0.5">
        ${perRace}/race
      </p>
    </button>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 text-white/40 hover:text-white text-sm mb-6 transition-colors"
    >
      <svg
        className="w-4 h-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15 19l-7-7 7-7"
        />
      </svg>
      Back
    </button>
  );
}
