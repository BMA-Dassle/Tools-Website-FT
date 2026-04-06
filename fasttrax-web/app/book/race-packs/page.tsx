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

interface FoundAccount {
  personId: string;
  fullName: string;
  lastSeen: string;
  races: number;
  memberships: string[];
}

const RELEVANT_MEMBERSHIPS = ["license fee", "qualified intermediate", "qualified pro", "turbo pass", "employee pass", "race credit"];

type ModalPhase = "closed" | "lookup" | "looking" | "found" | "new-person" | "summary" | "paying";

// ── Component ───────────────────────────────────────────────────────────────

export default function RacePacksPage() {
  const [selectedPack, setSelectedPack] = useState<RacePack | null>(null);
  const [modalPhase, setModalPhase] = useState<ModalPhase>("closed");
  const [person, setPerson] = useState<FoundPerson | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [lookupMode, setLookupMode] = useState<"phone" | "email" | "code" | "new">("phone");
  const [phoneInput, setPhoneInput] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [smsError, setSmsError] = useState("");
  const [smsSent, setSmsSent] = useState(false);
  const [searchResults, setSearchResults] = useState<FoundAccount[]>([]);
  const [newPerson, setNewPerson] = useState({ firstName: "", lastName: "", email: "", phone: "", dob: "" });
  const [emailSmsSent, setEmailSmsSent] = useState(false);
  const [emailSmsCode, setEmailSmsCode] = useState("");
  const [disclaimersAccepted, setDisclaimersAccepted] = useState<boolean[]>([]);
  const [error, setError] = useState("");
  const [paying, setPaying] = useState(false);
  const [payingStatus, setPayingStatus] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);

  function handleBuyNow(pack: RacePack) {
    trackBookingStep("Race Pack Selected", { pack: pack.name, type: pack.type, price: pack.price });
    setSelectedPack(pack);
    setPerson(null);
    setEmailInput("");
    setCodeInput("");
    setError("");
    setSearchResults([]);
    setNewPerson({ firstName: "", lastName: "", email: "", phone: "", dob: "" });
    setLookupMode("phone");
    setPhoneInput("");
    setSmsCode("");
    setSmsError("");
    setSmsSent(false);
    setEmailSmsSent(false);
    setEmailSmsCode("");
    setDisclaimersAccepted([]);
    setModalPhase("lookup");
    setTimeout(() => emailRef.current?.focus(), 200);
  }

  async function searchAndFetchAccounts(query: string): Promise<FoundAccount[]> {
    const searchRes = await fetch(`/api/bmi-office?action=search&q=${encodeURIComponent(query)}&max=200`);
    const results = await searchRes.json();
    if (!Array.isArray(results) || results.length === 0) return [];

    const withMem = (results as { localId: string; description: string }[]).filter(r => r.description.includes("Memberships:"));
    const byName = new Map<string, { localId: string; description: string }>();
    for (const r of (withMem.length > 0 ? withMem : results) as { localId: string; description: string }[]) {
      const nameMatch = r.description.match(/^([^(]+?)(?:\s*\(|$|\s+phone:|\s+Last seen:)/);
      const name = nameMatch ? nameMatch[1].trim() : r.description.split(" phone:")[0].trim();
      if (!byName.has(name)) byName.set(name, r);
    }
    const uniqueEntries = [...byName.values()].slice(0, 10);

    const detailPromises = uniqueEntries.map(async (r) => {
      try {
        const res = await fetch(`/api/bmi-office?action=person&id=${r.localId}`);
        const p = await res.json();
        const memberships = (p.memberships || [])
          .filter((m: { stops: string; name: string }) =>
            (!m.stops || new Date(m.stops) > new Date()) &&
            RELEVANT_MEMBERSHIPS.some(rel => m.name.toLowerCase().includes(rel))
          )
          .map((m: { name: string }) => m.name)
          .filter((name: string, i: number, arr: string[]) => arr.indexOf(name) === i);
        const lastSeen = p.lastLineUp
          ? new Date(p.lastLineUp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
          : "";
        return {
          personId: String(p.id),
          fullName: `${p.firstName || ""} ${p.name || ""}`.trim(),
          lastSeen,
          races: (p.tags || []).length,
          memberships,
        } as FoundAccount;
      } catch { return null; }
    });
    const allDetails = (await Promise.all(detailPromises)).filter((d): d is FoundAccount => d !== null);
    allDetails.sort((a, b) => {
      if (a.memberships.length > 0 && b.memberships.length === 0) return -1;
      if (a.memberships.length === 0 && b.memberships.length > 0) return 1;
      return (b.lastSeen || "").localeCompare(a.lastSeen || "");
    });
    return allDetails.slice(0, 5);
  }

  async function handleEmailSearch() {
    const trimmed = emailInput.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) return;
    setError("");
    setModalPhase("looking");

    try {
      const accounts = await searchAndFetchAccounts(trimmed);
      if (accounts.length === 0) {
        setError("No accounts found. Try a login code or enter as new person.");
        setModalPhase("lookup");
        return;
      }
      setSearchResults(accounts);

      // Send OTP email
      const otpRes = await fetch("/api/sms-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const otpData = await otpRes.json();
      if (!otpData.sent) {
        setError(otpData.error || "Failed to send verification code");
        setModalPhase("lookup");
        return;
      }
      setEmailSmsSent(true);
      setModalPhase("lookup");
    } catch {
      setError("Search failed. Please try again.");
      setModalPhase("lookup");
    }
  }

  async function handleEmailOtpVerify() {
    const trimmed = emailSmsCode.trim();
    if (!trimmed || trimmed.length !== 6) { setSmsError("Enter the 6-digit code"); return; }
    setSmsError("");
    const email = emailInput.trim().toLowerCase();
    try {
      const res = await fetch("/api/sms-verify", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code: trimmed }),
      });
      const data = await res.json();
      if (data.verified) {
        setModalPhase("found");
      } else {
        setSmsError(data.error || "Incorrect code");
      }
    } catch {
      setSmsError("Verification failed");
    }
  }

  function handleSelectAccount(account: FoundAccount) {
    setPerson({ personId: account.personId, fullName: account.fullName, email: "" });
    setDisclaimersAccepted(selectedPack!.type === "weekday" ? [false, false, false] : [false, false]);
    setModalPhase("summary");
  }

  async function handleSelectPersonById(localId: string) {
    setModalPhase("looking");
    try {
      const res = await fetch(`/api/bmi-office?action=person&id=${localId}`);
      const p = await res.json();
      const fullName = `${p.firstName || ""} ${p.name || ""}`.trim();
      const email = p.addresses?.[0]?.email || "";
      setPerson({ personId: String(p.id), fullName, email });
      setDisclaimersAccepted(selectedPack!.type === "weekday" ? [false, false, false] : [false, false]);
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
      await handleSelectPersonById(results[0].localId);
    } catch {
      setError("Verification failed.");
      setModalPhase("lookup");
    }
  }

  function formatPhoneInput(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  async function handlePhoneSearch() {
    const digits = phoneInput.replace(/\D/g, "").replace(/^1/, "");
    if (digits.length !== 10) return;
    setError("");
    setSmsError("");
    setModalPhase("looking");

    try {
      const accounts = await searchAndFetchAccounts(digits);
      if (accounts.length === 0) {
        setError("No accounts found with that phone number.");
        setModalPhase("lookup");
        return;
      }
      setSearchResults(accounts);

      // Send SMS code
      const smsRes = await fetch("/api/sms-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: digits }),
      });
      const smsData = await smsRes.json();
      if (!smsData.sent) {
        setError(smsData.error || "Failed to send code");
        setModalPhase("lookup");
        return;
      }
      setSmsSent(true);
      setModalPhase("lookup");
    } catch {
      setError("Search failed. Please try again.");
      setModalPhase("lookup");
    }
  }

  async function handleSmsVerify() {
    const trimmed = smsCode.trim();
    if (!trimmed || trimmed.length !== 6) { setSmsError("Enter the 6-digit code"); return; }
    setSmsError("");
    const digits = phoneInput.replace(/\D/g, "").replace(/^1/, "");
    try {
      const res = await fetch("/api/sms-verify", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: digits, code: trimmed }),
      });
      const data = await res.json();
      if (data.verified) {
        setModalPhase("found");
      } else {
        setSmsError(data.error || "Incorrect code");
      }
    } catch {
      setSmsError("Verification failed");
    }
  }

  function handleNewPerson() {
    if (!newPerson.firstName || !newPerson.lastName || !newPerson.email || !newPerson.phone || !newPerson.dob) {
      setError("Please fill in all fields.");
      return;
    }
    setPerson({
      personId: "",
      fullName: `${newPerson.firstName} ${newPerson.lastName}`,
      email: newPerson.email,
    });
    setDisclaimersAccepted(selectedPack!.type === "weekday" ? [false, false, false] : [false, false]);
    setModalPhase("summary");
  }

  async function handleCheckout() {
    if (!selectedPack || !person) return;
    setPaying(true);
    setModalPhase("paying");

    try {
      const firstName = person.fullName.split(" ")[0] || "";
      const lastName = person.fullName.split(" ").slice(1).join(" ") || "";
      const phone = newPerson.phone || "";
      let linkedPersonId = person.personId;

      // For new customers, create person via Pandora (BMI Firebird) first
      if (!linkedPersonId) {
        setPayingStatus("Creating your racer account...");
        const createRes = await fetch("/api/pandora", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ firstName, lastName, email: person.email, phone, birthdate: newPerson.dob || undefined }),
        });
        const createData = await createRes.json();
        if (createData.personId) {
          linkedPersonId = createData.personId;
          // Wait for person to sync from Firebird to BMI cloud (poll up to 30s)
          setPayingStatus("Setting up your account...");
          for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 5000));
            // Test if person is synced by attempting a sell
            const testSell = await fetch("/api/bmi?endpoint=booking%2Fsell", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: `{"ProductId":${selectedPack.productId},"PageId":${PAGE_ID},"Quantity":1,"personId":${linkedPersonId}}`,
            });
            const testText = await testSell.text();
            const testBillMatch = testText.match(/"orderId"\s*:\s*(\d+)/);
            if (testBillMatch) {
              // Person synced — cancel this test bill, we'll create the real one below
              await fetch(`/api/bmi?endpoint=bill/${testBillMatch[1]}/cancel`, { method: "DELETE" });
              break;
            }
          }
        }
      }

      setPayingStatus("Preparing your race pack...");

      // 1. Sell the pack WITH personId — this tells BMI to assign credits
      let sellJson = JSON.stringify({
        ProductId: Number(selectedPack.productId),
        PageId: Number(PAGE_ID),
        Quantity: 1,
        OrderId: null,
        ParentOrderItemId: null,
        DynamicLines: [],
      });
      if (linkedPersonId) {
        sellJson = sellJson.slice(0, -1) + `,"personId":${linkedPersonId}}`;
      }
      const sellRes = await fetch("/api/bmi?endpoint=booking%2Fsell", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: sellJson,
      });
      const sellData = await sellRes.text();
      const sell = JSON.parse(sellData);
      if (!sell.success && sell.success !== undefined) throw new Error(sell.errorMessage || "Sell failed");

      const billIdMatch = sellData.match(/"orderId"\s*:\s*(\d+)/);
      const billId = billIdMatch ? billIdMatch[1] : String(sell.orderId);
      if (!billId || billId === "undefined") throw new Error("No bill ID returned");

      // 2. Register contact person with personId
      const regBody: Record<string, unknown> = { firstName, lastName, email: person.email, phone: phone.replace(/\D/g, "") };
      if (linkedPersonId) {
        const regJson = `{"orderId":${billId},"personId":${linkedPersonId},` + JSON.stringify(regBody).slice(1);
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
          raceName: `${selectedPack.raceCount}-Race Pack (${selectedPack.type === "weekday" ? "Mon-Thu" : "Anytime"})`,
          catalogObjectId: "5FINJYYPPELXTERF2THUDCPT",
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
      setPayingStatus("Redirecting to payment...");
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

      {/* Warning banner */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 mb-6 mt-4">
        <div className="rounded-xl border-2 border-amber-500/50 bg-amber-500/10 p-4 flex items-start gap-3">
          <svg className="w-6 h-6 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <div>
            <p className="text-amber-400 font-bold text-sm">This is NOT a race booking</p>
            <p className="text-white/60 text-xs mt-0.5">
              Race packs add credits to your account. You still need to <a href="/book/race" className="text-[#00E2E5] underline hover:text-white">book a race</a> separately to reserve a heat time. Credits are applied automatically at checkout.
            </p>
          </div>
        </div>
      </div>

      {/* Pack grid */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pb-16">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4 py-6" onClick={() => !paying && setModalPhase("closed")}>
          <div
            className="w-full max-w-md bg-[#0a0e1a] border border-white/10 rounded-2xl p-5 sm:p-6 max-h-[85vh] overflow-y-auto"
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
                <p className="text-white/50 text-sm">
                  {payingStatus || "Heading to payment..."}
                </p>
              </div>
            )}

            {/* Lookup phase */}
            {modalPhase === "lookup" && (
              <div className="space-y-4">
                <p className="text-white font-semibold text-sm">Who is this pack for?</p>

                {/* Mode tabs */}
                <div className="flex gap-1 bg-white/5 rounded-lg p-1">
                  {(["phone", "email", "code", "new"] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => { setLookupMode(m); setError(""); setSmsError(""); }}
                      className={`flex-1 py-2 rounded-md text-xs font-semibold transition-colors ${lookupMode === m ? "bg-[#00E2E5] text-[#000418]" : "text-white/40 hover:text-white/60"}`}
                    >
                      {m === "phone" ? "Phone" : m === "email" ? "Email" : m === "code" ? "Code" : "New"}
                    </button>
                  ))}
                </div>

                {lookupMode === "phone" && !smsSent && (
                  <div className="space-y-3">
                    <input
                      type="tel"
                      value={phoneInput}
                      onChange={e => setPhoneInput(formatPhoneInput(e.target.value))}
                      onKeyDown={e => e.key === "Enter" && handlePhoneSearch()}
                      placeholder="(239) 555-1234"
                      className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white text-sm text-center tracking-wider placeholder:text-white/25 placeholder:tracking-normal focus:border-[#00E2E5]/50 focus:outline-none"
                      autoFocus
                    />
                    <button
                      onClick={handlePhoneSearch}
                      disabled={phoneInput.replace(/\D/g, "").length !== 10}
                      className="w-full py-3 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors disabled:opacity-40"
                    >
                      Send Verification Code
                    </button>
                  </div>
                )}

                {lookupMode === "phone" && smsSent && (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-green-500/30 bg-green-500/8 p-3 text-center">
                      <p className="text-green-400 font-semibold text-xs">Code sent to {phoneInput}</p>
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={smsCode}
                      onChange={e => { setSmsCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setSmsError(""); }}
                      onKeyDown={e => e.key === "Enter" && handleSmsVerify()}
                      placeholder="000000"
                      className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white text-center text-xl tracking-[0.4em] font-mono placeholder:text-white/20 focus:border-[#00E2E5]/50 focus:outline-none"
                      autoFocus
                    />
                    {smsError && <p className="text-red-400 text-xs text-center">{smsError}</p>}
                    <button
                      onClick={handleSmsVerify}
                      disabled={smsCode.length !== 6}
                      className="w-full py-3 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors disabled:opacity-40"
                    >
                      Verify Code
                    </button>
                    <button onClick={() => { setSmsSent(false); setSmsCode(""); }} className="w-full text-white/30 text-xs hover:text-white/50 py-1">
                      Resend code
                    </button>
                  </div>
                )}

                {lookupMode === "email" && !emailSmsSent && (
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
                    <button onClick={handleEmailSearch} disabled={!emailInput.includes("@")} className="w-full py-3 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors disabled:opacity-40">
                      Send Verification Code
                    </button>
                  </div>
                )}

                {lookupMode === "email" && emailSmsSent && (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-green-500/30 bg-green-500/8 p-3 text-center">
                      <p className="text-green-400 font-semibold text-xs">Code sent to {emailInput}</p>
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={emailSmsCode}
                      onChange={e => { setEmailSmsCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setSmsError(""); }}
                      onKeyDown={e => e.key === "Enter" && handleEmailOtpVerify()}
                      placeholder="000000"
                      className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white text-center text-xl tracking-[0.4em] font-mono placeholder:text-white/20 focus:border-[#00E2E5]/50 focus:outline-none"
                      autoFocus
                    />
                    {smsError && <p className="text-red-400 text-xs text-center">{smsError}</p>}
                    <button
                      onClick={handleEmailOtpVerify}
                      disabled={emailSmsCode.length !== 6}
                      className="w-full py-3 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors disabled:opacity-40"
                    >
                      Verify Code
                    </button>
                    <button onClick={() => { setEmailSmsSent(false); setEmailSmsCode(""); }} className="w-full text-white/30 text-xs hover:text-white/50 py-1">
                      Resend code
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
                    <input value={newPerson.phone} onChange={e => setNewPerson(p => ({ ...p, phone: e.target.value }))} placeholder="Phone" type="tel" className="w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-white text-sm placeholder:text-white/25 focus:border-[#00E2E5]/50 focus:outline-none" />
                    <div>
                      <label className="text-white/40 text-xs mb-1 block">Date of Birth</label>
                      <input value={newPerson.dob} onChange={e => setNewPerson(p => ({ ...p, dob: e.target.value }))} type="date" className="w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-white text-sm focus:border-[#00E2E5]/50 focus:outline-none [color-scheme:dark]" />
                    </div>
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
                <p className="text-white/40 text-xs">Select your account:</p>
                {searchResults.map(a => (
                  <button
                    key={a.personId}
                    onClick={() => handleSelectAccount(a)}
                    className="w-full rounded-xl border border-white/10 bg-white/5 hover:border-[#00E2E5]/50 hover:bg-[#00E2E5]/5 p-4 text-left transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-white font-semibold text-sm">{a.fullName}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {a.memberships.slice(0, 3).map((m, i) => (
                            <span key={i} className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-white/10 text-white/50">{m}</span>
                          ))}
                        </div>
                        {a.lastSeen && <p className="text-white/30 text-[10px] mt-1">Last seen: {a.lastSeen}</p>}
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <p className="text-[#00E2E5] font-bold text-lg">{a.races}</p>
                        <p className="text-white/30 text-[9px] uppercase">visits</p>
                      </div>
                    </div>
                  </button>
                ))}
                <button onClick={() => { setModalPhase("lookup"); setError(""); }} className="text-white/30 text-xs hover:text-white/50 transition-colors">
                  ← Back to search
                </button>
              </div>
            )}

            {/* Summary */}
            {modalPhase === "summary" && person && (() => {
              const disclaimers = [
                ...(selectedPack.type === "weekday" ? ["This pack is only valid Monday through Thursday"] : []),
                "Race pack is non-transferable",
                "This does not book you a race. It is highly suggested you complete a reservation after purchase.",
              ];
              const allAccepted = disclaimersAccepted.length >= disclaimers.length && disclaimersAccepted.slice(0, disclaimers.length).every(Boolean);
              return (
                <div className="space-y-4">
                  {/* Pack info */}
                  <div className="rounded-xl border border-[#00E2E5]/20 bg-[#00E2E5]/5 p-4 text-center">
                    <p className="text-[#00E2E5] text-[10px] font-bold uppercase tracking-widest">{selectedPack.type === "weekday" ? "Monday – Thursday" : "Anytime"}</p>
                    <p className="text-white font-display text-xl uppercase tracking-wider mt-1">{selectedPack.raceCount}-Race Pack</p>
                    <p className="text-white/50 text-xs mt-1">{selectedPack.raceCount} race credits · ${(selectedPack.price / selectedPack.raceCount).toFixed(2)}/race</p>
                  </div>

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

                  {/* Disclaimers */}
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
                    <p className="text-amber-400 font-bold text-xs uppercase tracking-wider">Please acknowledge</p>
                    {disclaimers.map((text, i) => (
                      <label key={i} className="flex items-start gap-3 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={disclaimersAccepted[i] || false}
                          onChange={() => setDisclaimersAccepted(prev => {
                            const next = [...prev];
                            next[i] = !next[i];
                            return next;
                          })}
                          className="mt-0.5 w-4 h-4 rounded border-white/30 bg-white/5 accent-[#00E2E5] shrink-0"
                        />
                        <span className="text-white/70 text-xs leading-relaxed group-hover:text-white/90 transition-colors">{text}</span>
                      </label>
                    ))}
                  </div>

                  <button
                    onClick={handleCheckout}
                    disabled={paying || !allAccepted}
                    className="w-full py-3.5 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {allAccepted ? `Pay $${total.toFixed(2)} →` : "Accept all terms to continue"}
                  </button>

                  <button onClick={() => { setPerson(null); setModalPhase("lookup"); setError(""); setDisclaimersAccepted([]); }} className="w-full text-white/30 text-xs hover:text-white/50 transition-colors">
                    ← Change person
                  </button>
                </div>
              );
            })()}
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
        <span className="text-white/30 text-sm ml-2 hidden sm:inline">${perRace}/race</span>
        <p className="text-white/30 text-xs sm:hidden mt-0.5">${perRace}/race</p>
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
