"use client";

import { useState, useRef } from "react";
import Image from "next/image";
import { calculateTax, calculateTotal } from "../race/data";
import { trackBookingStep } from "@/lib/analytics";

// ── Pack catalog ────────────────────────────────────────────────────────────

interface RacePack {
  productId: string;
  name: string;
  raceCount: number;
  type: "weekday" | "anytime";
  price: number;
}

const PACKS: RacePack[] = [
  { productId: "13079165", name: "3-Race Pack", raceCount: 3, type: "weekday", price: 49.99 },
  { productId: "13079678", name: "3-Race Pack", raceCount: 3, type: "anytime", price: 59.99 },
  { productId: "12754550", name: "5-Race Pack", raceCount: 5, type: "weekday", price: 79.99 },
  { productId: "13079686", name: "5-Race Pack", raceCount: 5, type: "anytime", price: 99.99 },
  { productId: "12754573", name: "10-Race Pack", raceCount: 10, type: "weekday", price: 159.99 },
  { productId: "13079694", name: "10-Race Pack", raceCount: 10, type: "anytime", price: 199.99 },
];

const PAGE_ID = "42960253";

// ── Person lookup types ─────────────────────────────────────────────────────

interface FoundPerson {
  personId: string;
  fullName: string;
  email: string;
}

type ModalPhase = "closed" | "lookup" | "looking" | "found" | "new-person" | "summary" | "paying";

// ── Component ───────────────────────────────────────────────────────────────

export default function RacePacksPage() {
  const [selectedPack, setSelectedPack] = useState<RacePack | null>(null);
  const [modalPhase, setModalPhase] = useState<ModalPhase>("closed");
  const [person, setPerson] = useState<FoundPerson | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [lookupMode, setLookupMode] = useState<"email" | "code" | "new">("email");
  const [searchResults, setSearchResults] = useState<{ localId: string; description: string }[]>([]);
  const [newPerson, setNewPerson] = useState({ firstName: "", lastName: "", email: "", phone: "" });
  const [error, setError] = useState("");
  const [paying, setPaying] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  function handleBuyNow(pack: RacePack) {
    trackBookingStep("Race Pack Selected", { pack: pack.name, type: pack.type, price: pack.price });
    setSelectedPack(pack);
    setPerson(null);
    setEmailInput("");
    setCodeInput("");
    setError("");
    setSearchResults([]);
    setNewPerson({ firstName: "", lastName: "", email: "", phone: "" });
    setLookupMode("email");
    setModalPhase("lookup");
    setTimeout(() => emailRef.current?.focus(), 200);
  }

  async function handleEmailSearch() {
    const trimmed = emailInput.trim();
    if (!trimmed || !trimmed.includes("@")) return;
    setError("");
    setModalPhase("looking");

    try {
      const res = await fetch(`/api/bmi-office?action=search&q=${encodeURIComponent(trimmed)}&max=50`);
      const results = await res.json();
      if (!Array.isArray(results) || results.length === 0) {
        setError("No accounts found. Try a login code or enter as new person.");
        setModalPhase("lookup");
        return;
      }
      // Filter to accounts with memberships, dedupe by name
      const withMem = results.filter((r: { description: string }) => r.description.includes("Memberships:"));
      const byName = new Map<string, { localId: string; description: string }>();
      for (const r of (withMem.length > 0 ? withMem : results) as { localId: string; description: string }[]) {
        const nameMatch = r.description.match(/^([^(]+?)(?:\s*\(|$|\s+phone:|\s+Last seen:)/);
        const name = nameMatch ? nameMatch[1].trim() : r.description.split(" phone:")[0].trim();
        if (!byName.has(name)) byName.set(name, r);
      }
      setSearchResults([...byName.values()].slice(0, 5));
      setModalPhase("found");
    } catch {
      setError("Search failed. Please try again.");
      setModalPhase("lookup");
    }
  }

  async function handleSelectPerson(localId: string) {
    setModalPhase("looking");
    try {
      const res = await fetch(`/api/bmi-office?action=person&id=${localId}`);
      const p = await res.json();
      const fullName = `${p.firstName || ""} ${p.name || ""}`.trim();
      const email = p.addresses?.[0]?.email || "";
      setPerson({ personId: String(p.id), fullName, email });
      setModalPhase("summary");
    } catch {
      setError("Could not load person details.");
      setModalPhase("found");
    }
  }

  async function handleCodeVerify() {
    const code = codeInput.trim();
    if (!code) return;
    setModalPhase("looking");
    try {
      const res = await fetch(`/api/bmi-office?action=search&q=${encodeURIComponent(code)}&max=1`);
      const results = await res.json();
      if (!Array.isArray(results) || results.length === 0) {
        setError("Code not recognized.");
        setModalPhase("lookup");
        return;
      }
      await handleSelectPerson(results[0].localId);
    } catch {
      setError("Verification failed.");
      setModalPhase("lookup");
    }
  }

  function handleNewPerson() {
    if (!newPerson.firstName || !newPerson.lastName || !newPerson.email) {
      setError("Please fill in name and email.");
      return;
    }
    setPerson({
      personId: "",
      fullName: `${newPerson.firstName} ${newPerson.lastName}`,
      email: newPerson.email,
    });
    setModalPhase("summary");
  }

  async function handleCheckout() {
    if (!selectedPack || !person) return;
    setPaying(true);
    setModalPhase("paying");

    try {
      // 1. Sell the pack
      const sellRes = await fetch("/api/bmi?endpoint=booking%2Fsell", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ProductId: Number(selectedPack.productId),
          PageId: Number(PAGE_ID),
          Quantity: 1,
          OrderId: null,
          ParentOrderItemId: null,
          DynamicLines: [],
        }),
      });
      const sellData = await sellRes.text();
      const sell = JSON.parse(sellData);
      if (!sell.success && sell.success !== undefined) throw new Error(sell.errorMessage || "Sell failed");

      const billIdMatch = sellData.match(/"orderId"\s*:\s*(\d+)/);
      const billId = billIdMatch ? billIdMatch[1] : String(sell.orderId);
      if (!billId || billId === "undefined") throw new Error("No bill ID returned");

      // 2. Register contact person (with personId if returning racer)
      const regBody: Record<string, unknown> = {
        firstName: person.fullName.split(" ")[0] || "",
        lastName: person.fullName.split(" ").slice(1).join(" ") || "",
        email: person.email,
        phone: newPerson.phone || "",
      };
      if (person.personId) {
        const regJson = `{"orderId":${billId},"personId":${person.personId},` + JSON.stringify(regBody).slice(1);
        await fetch("/api/bmi?endpoint=person%2FregisterContactPerson", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: regJson,
        });
      } else {
        const regJson = `{"orderId":${billId},` + JSON.stringify(regBody).slice(1);
        await fetch("/api/bmi?endpoint=person%2FregisterContactPerson", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: regJson,
        });
      }

      // 3. Store in Redis
      const total = calculateTotal(selectedPack.price);
      const bookingDetails = {
        billId,
        amount: total.toFixed(2),
        race: selectedPack.name + ` (${selectedPack.type === "weekday" ? "Mon-Thu" : "Anytime"})`,
        name: person.fullName,
        email: person.email,
        qty: String(selectedPack.raceCount),
        isCreditOrder: "false",
        type: "race-pack",
      };
      await fetch("/api/booking-store", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bookingDetails),
      });
      localStorage.setItem(`booking_${billId}`, JSON.stringify(bookingDetails));

      // 4. Square checkout
      const returnUrl = `${window.location.origin}/book/race-packs/confirmation?billId=${billId}`;
      const squareRes = await fetch("/api/square/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          billId,
          amount: total,
          raceName: "Race Pack Deposit",
          returnUrl,
          cancelUrl: `${window.location.origin}/book/race-packs`,
          buyer: {
            email: person.email,
            firstName: person.fullName.split(" ")[0] || "",
            lastName: person.fullName.split(" ").slice(1).join(" ") || "",
          },
        }),
      });
      const squareData = await squareRes.json();
      if (squareData.checkoutUrl) {
        trackBookingStep("Race Pack Payment", { pack: selectedPack.name, amount: total });
        window.location.href = squareData.checkoutUrl;
      } else {
        throw new Error(squareData.error || "Failed to create payment");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPaying(false);
      setModalPhase("summary");
    }
  }

  const tax = selectedPack ? calculateTax(selectedPack.price) : 0;
  const total = selectedPack ? calculateTotal(selectedPack.price) : 0;

  return (
    <div className="min-h-screen bg-[#000418]">
      {/* Hero */}
      <div className="relative overflow-hidden">
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg"
          alt="FastTrax Racing"
          fill
          className="object-cover object-center"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[#000418]/50 via-[#000418]/75 to-[#000418]" />
        <div className="relative z-10 pt-36 pb-20 px-4 text-center">
          <h1 className="text-4xl md:text-5xl font-display uppercase tracking-widest text-white mb-3">
            Race Packs
          </h1>
          <p className="text-white/50 text-sm max-w-lg mx-auto">
            Buy credits in bulk and save. Use them anytime or Monday–Thursday. Credits load instantly to your account.
          </p>
        </div>
      </div>

      {/* Pack grid */}
      <div className="max-w-4xl mx-auto px-4 pb-16 -mt-6">
        {/* Column headers */}
        <div className="grid grid-cols-2 gap-4 mb-3">
          <p className="text-center text-white/30 text-[10px] font-bold uppercase tracking-widest">Monday – Thursday</p>
          <p className="text-center text-white/30 text-[10px] font-bold uppercase tracking-widest">Anytime</p>
        </div>

        {/* Pack rows */}
        {[3, 5, 10].map(count => {
          const weekday = PACKS.find(p => p.raceCount === count && p.type === "weekday")!;
          const anytime = PACKS.find(p => p.raceCount === count && p.type === "anytime")!;
          return (
            <div key={count} className="grid grid-cols-2 gap-4 mb-4">
              <PackCard pack={weekday} onBuy={handleBuyNow} />
              <PackCard pack={anytime} onBuy={handleBuyNow} />
            </div>
          );
        })}

        <p className="text-center text-white/20 text-xs mt-6">
          Credits are non-refundable. Monday–Thursday packs valid Mon–Thu only. Anytime packs valid any day.
        </p>
      </div>

      {/* Modal overlay */}
      {modalPhase !== "closed" && selectedPack && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !paying && setModalPhase("closed")}>
          <div
            className="w-full sm:max-w-md bg-[#0a0e1a] border border-white/10 rounded-t-2xl sm:rounded-2xl p-5 sm:p-6 max-h-[85vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-[#00E2E5] text-[10px] font-bold uppercase tracking-widest">
                  {selectedPack.raceCount}-Race Pack · {selectedPack.type === "weekday" ? "Mon–Thu" : "Anytime"}
                </p>
                <p className="text-white font-bold text-lg">${selectedPack.price.toFixed(2)}</p>
              </div>
              {!paying && (
                <button onClick={() => setModalPhase("closed")} className="text-white/30 hover:text-white/60 transition-colors p-1">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              )}
            </div>

            {error && <p className="text-red-400 text-xs mb-3 bg-red-400/10 rounded-lg px-3 py-2">{error}</p>}

            {/* Loading */}
            {modalPhase === "looking" && (
              <div className="flex items-center justify-center gap-3 py-8">
                <div className="w-5 h-5 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
                <span className="text-white/50 text-sm">Looking up...</span>
              </div>
            )}

            {/* Paying */}
            {modalPhase === "paying" && (
              <div className="flex flex-col items-center gap-4 py-8">
                <div className="w-8 h-8 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
                <p className="text-white/50 text-sm">Heading to payment...</p>
              </div>
            )}

            {/* Lookup phase */}
            {modalPhase === "lookup" && (
              <div className="space-y-4">
                <p className="text-white font-semibold text-sm">Who is this pack for?</p>

                {/* Mode tabs */}
                <div className="flex gap-1 bg-white/5 rounded-lg p-1">
                  {(["email", "code", "new"] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => { setLookupMode(m); setError(""); }}
                      className={`flex-1 py-2 rounded-md text-xs font-semibold transition-colors ${lookupMode === m ? "bg-[#00E2E5] text-[#000418]" : "text-white/40 hover:text-white/60"}`}
                    >
                      {m === "email" ? "Email" : m === "code" ? "Code" : "New"}
                    </button>
                  ))}
                </div>

                {lookupMode === "email" && (
                  <div className="space-y-3">
                    <input
                      ref={emailRef}
                      type="email"
                      value={emailInput}
                      onChange={e => setEmailInput(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && handleEmailSearch()}
                      placeholder="racer@email.com"
                      className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white text-sm placeholder:text-white/25 focus:border-[#00E2E5]/50 focus:outline-none"
                    />
                    <button onClick={handleEmailSearch} className="w-full py-3 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors">
                      Find Account
                    </button>
                  </div>
                )}

                {lookupMode === "code" && (
                  <div className="space-y-3">
                    <input
                      type="text"
                      value={codeInput}
                      onChange={e => setCodeInput(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && handleCodeVerify()}
                      placeholder="Login code"
                      className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white text-sm placeholder:text-white/25 focus:border-[#00E2E5]/50 focus:outline-none"
                    />
                    <button onClick={handleCodeVerify} className="w-full py-3 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors">
                      Verify Code
                    </button>
                  </div>
                )}

                {lookupMode === "new" && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <input value={newPerson.firstName} onChange={e => setNewPerson(p => ({ ...p, firstName: e.target.value }))} placeholder="First name" className="bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-white text-sm placeholder:text-white/25 focus:border-[#00E2E5]/50 focus:outline-none" />
                      <input value={newPerson.lastName} onChange={e => setNewPerson(p => ({ ...p, lastName: e.target.value }))} placeholder="Last name" className="bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-white text-sm placeholder:text-white/25 focus:border-[#00E2E5]/50 focus:outline-none" />
                    </div>
                    <input value={newPerson.email} onChange={e => setNewPerson(p => ({ ...p, email: e.target.value }))} placeholder="Email" type="email" className="w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-white text-sm placeholder:text-white/25 focus:border-[#00E2E5]/50 focus:outline-none" />
                    <input value={newPerson.phone} onChange={e => setNewPerson(p => ({ ...p, phone: e.target.value }))} placeholder="Phone (optional)" type="tel" className="w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-white text-sm placeholder:text-white/25 focus:border-[#00E2E5]/50 focus:outline-none" />
                    <button onClick={handleNewPerson} className="w-full py-3 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors">
                      Continue
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Search results */}
            {modalPhase === "found" && (
              <div className="space-y-3">
                <p className="text-white/40 text-xs">Select an account:</p>
                {searchResults.map(r => {
                  const nameMatch = r.description.match(/^([^(]+?)(?:\s*\(|$|\s+phone:|\s+Last seen:)/);
                  const name = nameMatch ? nameMatch[1].trim() : r.description.split(" phone:")[0].trim();
                  return (
                    <button
                      key={r.localId}
                      onClick={() => handleSelectPerson(r.localId)}
                      className="w-full text-left rounded-xl border border-white/10 bg-white/5 hover:border-[#00E2E5]/40 hover:bg-[#00E2E5]/5 transition-colors p-3"
                    >
                      <p className="text-white font-semibold text-sm">{name}</p>
                      <p className="text-white/40 text-xs truncate">{r.description.substring(name.length)}</p>
                    </button>
                  );
                })}
                <button onClick={() => { setModalPhase("lookup"); setError(""); }} className="text-white/30 text-xs hover:text-white/50 transition-colors">
                  ← Back to search
                </button>
              </div>
            )}

            {/* Summary */}
            {modalPhase === "summary" && person && (
              <div className="space-y-4">
                {/* Person card */}
                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <p className="text-white font-bold">{person.fullName}</p>
                  <p className="text-white/40 text-xs">{person.email}</p>
                </div>

                {/* Price breakdown */}
                <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-white/60">{selectedPack.name} ({selectedPack.type === "weekday" ? "Mon–Thu" : "Anytime"})</span>
                    <span className="text-white">${selectedPack.price.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-white/60">Tax</span>
                    <span className="text-white">${tax.toFixed(2)}</span>
                  </div>
                  <div className="border-t border-white/10 pt-2 flex justify-between font-bold">
                    <span className="text-white">Total</span>
                    <span className="text-[#00E2E5] text-lg">${total.toFixed(2)}</span>
                  </div>
                </div>

                <button
                  onClick={handleCheckout}
                  disabled={paying}
                  className="w-full py-3.5 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25 disabled:opacity-50"
                >
                  Pay ${total.toFixed(2)} →
                </button>

                <button onClick={() => { setPerson(null); setModalPhase("lookup"); setError(""); }} className="w-full text-white/30 text-xs hover:text-white/50 transition-colors">
                  ← Change person
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pack Card ────────────────────────────────────────────────────────────────

function PackCard({ pack, onBuy }: { pack: RacePack; onBuy: (p: RacePack) => void }) {
  const perRace = (pack.price / pack.raceCount).toFixed(2);
  const isAnytime = pack.type === "anytime";

  return (
    <div className={`rounded-2xl border p-5 flex flex-col gap-3 transition-all hover:scale-[1.02] ${
      isAnytime
        ? "border-[#00E2E5]/30 bg-[#00E2E5]/[0.04] hover:border-[#00E2E5]/50"
        : "border-blue-500/30 bg-blue-500/[0.04] hover:border-blue-500/50"
    }`}>
      <div>
        <p className="text-white font-display text-xl uppercase tracking-wider">
          {pack.raceCount}-Race Pack
        </p>
        <p className={`text-xs font-semibold ${isAnytime ? "text-[#00E2E5]/70" : "text-blue-400/70"}`}>
          {isAnytime ? "Valid Any Day" : "Monday – Thursday"}
        </p>
      </div>

      <div>
        <span className="text-white font-bold text-3xl">${pack.price.toFixed(2)}</span>
        <span className="text-white/30 text-sm ml-2">${perRace}/race</span>
      </div>

      <button
        onClick={() => onBuy(pack)}
        className={`w-full py-3 rounded-xl font-bold text-sm transition-colors ${
          isAnytime
            ? "bg-[#00E2E5] text-[#000418] hover:bg-white"
            : "bg-blue-500 text-white hover:bg-blue-400"
        }`}
      >
        Buy Now
      </button>
    </div>
  );
}
