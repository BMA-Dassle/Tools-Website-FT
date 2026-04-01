"use client";

import { useState } from "react";
import type { RaceProduct, SmsProposal, SmsBlock } from "./data";
import type { ContactInfo } from "./components/ContactForm";
import RacePicker from "./components/RacePicker";
import DatePicker from "./components/DatePicker";
import HeatPicker from "./components/HeatPicker";
import ContactForm from "./components/ContactForm";
import OrderSummary from "./components/OrderSummary";

type Step = "race" | "date" | "heat" | "contact" | "summary";

const STEPS: Step[] = ["race", "date", "heat", "contact", "summary"];
const STEP_LABELS: Record<Step, string> = {
  race: "Race",
  date: "Date",
  heat: "Heat",
  contact: "Details",
  summary: "Pay",
};

export default function BookRacingPage() {
  const [step, setStep] = useState<Step>("race");
  const [selectedRace, setSelectedRace] = useState<RaceProduct | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [selectedProposal, setSelectedProposal] = useState<SmsProposal | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<SmsBlock | null>(null);
  const [contact, setContact] = useState<ContactInfo | null>(null);

  const currentIdx = STEPS.indexOf(step);

  function handleSelectRace(race: RaceProduct) {
    setSelectedRace(race);
    if (race.productId !== selectedRace?.productId) {
      setSelectedDate(null);
      setSelectedProposal(null);
      setSelectedBlock(null);
    }
  }

  function handleSelectDate(date: string) {
    setSelectedDate(date);
    setSelectedProposal(null);
    setSelectedBlock(null);
    setStep("heat");
  }

  function handleConfirmHeat(proposal: SmsProposal, block: SmsBlock) {
    setSelectedProposal(proposal);
    setSelectedBlock(block);
    setStep("contact");
  }

  function handleContactSubmit(info: ContactInfo) {
    setContact(info);
    setStep("summary");
  }

  function goToStep(s: Step) {
    const targetIdx = STEPS.indexOf(s);
    if (targetIdx < currentIdx) setStep(s);
  }

  return (
    <div className="min-h-screen bg-[#000418] pt-24">
      {/* Header */}
      <div className="border-b border-white/8" style={{ background: "linear-gradient(180deg, #010A20 0%, #000418 100%)" }}>
        <div className="max-w-4xl mx-auto px-4 py-6">
          <a href="/racing" className="text-white/30 hover:text-white/60 text-xs transition-colors mb-4 inline-block">
            ← Back to Racing
          </a>
          <h1 className="text-3xl sm:text-4xl font-display uppercase tracking-widest mb-1" style={{ color: "#00E2E5", textShadow: "0 0 40px rgba(0,226,229,0.4)" }}>
            Book a Race
          </h1>
          <p className="text-white/40 text-sm">FastTrax at HeadPinz Fort Myers</p>
        </div>

        {/* Step indicator */}
        <div className="max-w-4xl mx-auto px-4 pb-4">
          <div className="flex items-center gap-0">
            {STEPS.map((s, i) => {
              const isPast = i < currentIdx;
              const isCurrent = i === currentIdx;
              const isFuture = i > currentIdx;
              return (
                <div key={s} className="flex items-center">
                  <button
                    onClick={() => isPast && goToStep(s)}
                    disabled={isFuture}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${
                      isCurrent ? "text-[#00E2E5]" :
                      isPast ? "text-white/60 hover:text-white/80 cursor-pointer" :
                      "text-white/20 cursor-not-allowed"
                    }`}
                  >
                    <span className={`w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold ${
                      isCurrent ? "bg-[#00E2E5] text-[#000418]" :
                      isPast ? "bg-white/20 text-white" :
                      "bg-white/8 text-white/20"
                    }`}>
                      {isPast ? "✓" : i + 1}
                    </span>
                    {STEP_LABELS[s]}
                  </button>
                  {i < STEPS.length - 1 && <span className="text-white/15 mx-1">›</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-4xl mx-auto px-4 py-8">

        {/* STEP 1: Race */}
        {step === "race" && (
          <div className="space-y-8">
            <RacePicker selected={selectedRace} onSelect={handleSelectRace} />
            {selectedRace && (
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("date")}
                  className="inline-flex items-center gap-2 px-8 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
                >
                  Next: Pick a Date →
                </button>
              </div>
            )}
          </div>
        )}

        {/* STEP 2: Date */}
        {step === "date" && selectedRace && (
          <div className="space-y-8">
            <DatePicker race={selectedRace} selected={selectedDate} onSelect={handleSelectDate} />
            <div className="flex items-center justify-between">
              <button onClick={() => setStep("race")} className="text-sm text-white/40 hover:text-white/70 transition-colors">
                ← Change race
              </button>
              {selectedDate && (
                <button
                  onClick={() => setStep("heat")}
                  className="inline-flex items-center gap-2 px-8 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
                >
                  Next: Pick a Heat →
                </button>
              )}
            </div>
          </div>
        )}

        {/* STEP 3: Heat + Quantity */}
        {step === "heat" && selectedRace && selectedDate && (
          <HeatPicker
            race={selectedRace}
            date={selectedDate}
            quantity={quantity}
            onQuantityChange={setQuantity}
            onConfirm={handleConfirmHeat}
            onBack={() => setStep("date")}
          />
        )}

        {/* STEP 4: Contact info */}
        {step === "contact" && (
          <ContactForm
            initial={contact}
            onSubmit={handleContactSubmit}
            onBack={() => setStep("heat")}
          />
        )}

        {/* STEP 5: Order summary + payment */}
        {step === "summary" && selectedRace && selectedDate && selectedProposal && selectedBlock && contact && (
          <OrderSummary
            race={selectedRace}
            date={selectedDate}
            quantity={quantity}
            proposal={selectedProposal}
            block={selectedBlock}
            contact={contact}
            onBack={() => setStep("contact")}
          />
        )}
      </div>
    </div>
  );
}
