"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { calculateTax, calculateTotal, isRelevantMembership } from "../race/data";
import { trackBookingStep } from "@/lib/analytics";
import PaymentForm from "@/components/square/PaymentForm";
import type { PaymentResult } from "@/components/square/PaymentForm";

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

// ── Square + Pandora-deposit workaround ─────────────────────────────────────
//
// BMI's pack `booking/sell` flow has been broken since the April 9
// product-ID switchover (credits get applied at the wrong stage). While
// they fix that, we route around it: charge via Square against this
// shared catalog item (custom name override per variant), then credit
// the customer's BMI deposit balance directly through the Pandora
// workaround endpoints.
//
// Feature-flagged so we can drop back to the BMI flow instantly if
// anything goes sideways. Default ON unless the env var is the literal
// string "false". When OFF the existing BMI booking/sell flow runs
// unchanged.
const RACE_PACK_VIA_DEPOSIT =
  (process.env.NEXT_PUBLIC_RACE_PACK_VIA_DEPOSIT || "true").toLowerCase() !== "false";

// Single Square catalog product, shared by every pack variant. We
// override the line-item name on each order so receipts read e.g.
// "5-Race Pack (Mon-Thu)" instead of the generic catalog name.
const SQUARE_RACE_PACK_CATALOG_ID = "YYOV5QCHQSJKZS7DDIALGU7Z";

// Pandora deposit-kind ids for race credits — see lib/pandora-deposits.ts
// for the full catalogue + how these map to BMI's T_DEPOSIT rows.
const RACE_PACK_DEPOSIT_KIND: Record<RacePack["type"], string> = {
  weekday: "12744867", // Race-credit Mon-Thu
  anytime: "12744871", // Race-credit any day
};

function syntheticBillId(): string {
  // No real BMI bill exists for via-deposit packs, so we mint a
  // unique-enough id locally for sales-log + booking-store keying.
  // Prefix makes it instantly recognizable in admin tooling.
  return `pack-${Date.now()}-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
}

// ── Step model ──────────────────────────────────────────────────────────────
//
// Multi-step page flow (was a single modal that was too easy to
// click out of — hurt conversion). Mirrors the /book/race pattern:
// state machine + URL push so browser back/forward and refresh both
// work, content lives inline on a real page (no overlay backdrop).

type Step = "select" | "racer" | "review" | "paying";
const STEPS: Step[] = ["select", "racer", "review", "paying"];

// On the racer step, the page first shows the lookup form (phone /
// email / code / new), then swaps to the search-results list once
// the OTP verifies. Tracked as in-step substate (no URL change) —
// no reason to push to history.
type RacerView = "lookup" | "found";

function packUrlParam(p: RacePack): string {
  return `${p.type}-${p.raceCount}`;
}
function packFromUrlParam(s: string | null): RacePack | null {
  if (!s) return null;
  const [type, count] = s.split("-");
  return PACKS.find(p => p.type === type && String(p.raceCount) === count) || null;
}

// ── Person lookup types ─────────────────────────────────────────────────────

interface FoundPerson {
  personId: string;
  fullName: string;
  email: string;
  phone?: string;
  loginCode?: string;
}

interface FoundAccount {
  personId: string;
  fullName: string;
  email: string;
  lastSeen: string;
  races: number;
  memberships: string[];
  creditBalances?: { kind: string; balance: number }[];
  loginCode?: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export default function RacePacksPage() {
  // Step + selected pack ride together in the URL so refresh works
  // and the browser back button moves between steps in the expected
  // order (paying → review → racer → select).
  const [step, setStepRaw] = useState<Step>("select");
  const [selectedPack, setSelectedPack] = useState<RacePack | null>(null);
  // racer-step substates
  const [racerView, setRacerView] = useState<RacerView>("lookup");
  const [looking, setLooking] = useState(false);

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
  const [checkoutBillId, setCheckoutBillId] = useState("");
  const [checkoutTotal, setCheckoutTotal] = useState(0);
  const [payingStatus, setPayingStatus] = useState("");
  // Captured at handleCheckout time so PaymentForm props don't go
  // stale if `person` re-renders mid-flow. Only meaningful when
  // RACE_PACK_VIA_DEPOSIT is on.
  const [checkoutPersonId, setCheckoutPersonId] = useState("");
  const [checkoutIsNewRacer, setCheckoutIsNewRacer] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  /** Update step state AND push to URL. Mirrors /book/race's
   *  changeStep so browser back/forward works on refresh. */
  function changeStep(s: Step, pack: RacePack | null = selectedPack) {
    setStepRaw(s);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("step", s);
      if (pack) url.searchParams.set("pack", packUrlParam(pack));
      else url.searchParams.delete("pack");
      window.history.pushState(
        { step: s, pack: pack ? packUrlParam(pack) : null },
        "",
        url.toString(),
      );
    }
  }

  // Initial mount: hydrate from URL so refresh keeps the user where
  // they were. Steps past "select" require a saved pack — without
  // one we can't render anything meaningful, so bounce to select.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlStep = params.get("step") as Step | null;
    const urlPack = packFromUrlParam(params.get("pack"));
    if (urlStep && STEPS.includes(urlStep)) {
      if (urlStep === "select" || !urlPack) {
        setStepRaw("select");
        setSelectedPack(null);
      } else if (urlStep === "racer") {
        // Restore step + pack but reset lookup state — never resume
        // mid-OTP from a refresh, the SMS code in the user's hand is
        // already invalid by then.
        setSelectedPack(urlPack);
        setStepRaw("racer");
        setRacerView("lookup");
      } else {
        // review / paying — review is fine to restore. paying with no
        // active payment context falls back to review.
        setSelectedPack(urlPack);
        setStepRaw(urlStep === "paying" ? "review" : urlStep);
      }
    }
    window.history.replaceState(
      { step: urlStep || "select", pack: urlPack ? packUrlParam(urlPack) : null },
      "",
    );
  }, []);

  // Browser back/forward — drives the same setStepRaw + selectedPack
  // updates the user would see if they used the "← Back" link.
  useEffect(() => {
    function handlePopState(e: PopStateEvent) {
      const s = e.state?.step as Step;
      const p = packFromUrlParam(e.state?.pack ?? null);
      if (s && STEPS.includes(s)) {
        setStepRaw(s);
        if (s === "select") {
          setSelectedPack(null);
        } else if (p) {
          setSelectedPack(p);
        }
      } else {
        setStepRaw("select");
        setSelectedPack(null);
      }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function handleBackToSelect() {
    setSelectedPack(null);
    setPerson(null);
    setError("");
    setSearchResults([]);
    setNewPerson({ firstName: "", lastName: "", email: "", phone: "", dob: "" });
    setLookupMode("phone");
    setPhoneInput("");
    setSmsCode("");
    setSmsError("");
    setSmsSent(false);
    setEmailInput("");
    setEmailSmsSent(false);
    setEmailSmsCode("");
    setCodeInput("");
    setDisclaimersAccepted([]);
    setRacerView("lookup");
    setLooking(false);
    changeStep("select", null);
  }

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
    setRacerView("lookup");
    setLooking(false);
    changeStep("racer", pack);
    setTimeout(() => emailRef.current?.focus(), 200);
  }

  async function searchAndFetchAccounts(query: string): Promise<FoundAccount[]> {
    // See the matching helper in ReturningRacerLookup.tsx for why max=500
    // and the per-name scoring exist (frequent-racer phone search returns
    // hundreds of per-reservation contact-person stubs that crowd out
    // the real profile, both by rank and by name-collision).
    const searchRes = await fetch(`/api/bmi-office?action=search&q=${encodeURIComponent(query)}&max=500`);
    const results = await searchRes.json();
    if (!Array.isArray(results) || results.length === 0) return [];

    const scoreDesc = (d: string): number => {
      let s = 0;
      if (/\(\d/.test(d)) s += 100;
      if (d.includes("Memberships:")) s += 50;
      if (d.includes("zip:")) s += 25;
      if (d.includes("Last seen:")) s += 10;
      return s;
    };
    const byName = new Map<string, { localId: string; description: string; score: number }>();
    for (const r of results as { localId: string; description: string }[]) {
      const nameMatch = r.description.match(/^([^(]+?)(?:\s*\(|$|\s+phone:|\s+Last seen:)/);
      const name = nameMatch ? nameMatch[1].trim() : r.description.split(" phone:")[0].trim();
      const score = scoreDesc(r.description);
      const existing = byName.get(name);
      if (!existing || score > existing.score) {
        byName.set(name, { localId: r.localId, description: r.description, score });
      }
    }
    const uniqueEntries = [...byName.values()].slice(0, 10);

    const detailPromises = uniqueEntries.map(async (r) => {
      try {
        const res = await fetch(`/api/bmi-office?action=person&id=${r.localId}`);
        const p = await res.json();
        const memberships = (p.memberships || [])
          .filter((m: { stops: string; name: string }) =>
            (!m.stops || new Date(m.stops) > new Date()) &&
            isRelevantMembership(m.name)
          )
          .map((m: { name: string }) => m.name)
          .filter((name: string, i: number, arr: string[]) => arr.indexOf(name) === i);
        const lastSeen = p.lastLineUp
          ? new Date(p.lastLineUp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
          : "";
        // Fetch credit balances
        let creditBalances: { kind: string; balance: number }[] = [];
        try {
          const depRes = await fetch(`/api/bmi-office?action=deposits&personId=${p.id}`);
          if (depRes.ok) {
            const deposits: { depositKind: string; balance: number }[] = await depRes.json();
            creditBalances = deposits
              .filter(d => d.balance > 0 && (d.depositKind.toLowerCase().includes("credit") || d.depositKind.toLowerCase().includes("pass")))
              .map(d => ({ kind: d.depositKind, balance: d.balance }));
          }
        } catch {}
        const tags = (p.tags || []).sort((a: { lastSeen: string }, b: { lastSeen: string }) =>
          (b.lastSeen || "").localeCompare(a.lastSeen || "")
        );
        const loginCode = tags[0]?.tag || "";
        return {
          personId: String(p.id),
          fullName: `${p.firstName || ""} ${p.name || ""}`.trim(),
          email: (p.addresses?.[0]?.email) || "",
          lastSeen,
          loginCode,
          races: tags.length,
          memberships,
          creditBalances,
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
    setLooking(true);

    try {
      const accounts = await searchAndFetchAccounts(trimmed);
      if (accounts.length === 0) {
        setError("No accounts found. Try a login code or enter as new person.");
        setLooking(false);
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
        setLooking(false);
        return;
      }
      setEmailSmsSent(true);
      setLooking(false);
    } catch {
      setError("Search failed. Please try again.");
      setLooking(false);
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
        setRacerView("found");
      } else {
        setSmsError(data.error || "Incorrect code");
      }
    } catch {
      setSmsError("Verification failed");
    }
  }

  function handleSelectAccount(account: FoundAccount) {
    const lookupPhone = phoneInput.replace(/\D/g, "").replace(/^1/, "");
    setPerson({
      personId: account.personId,
      fullName: account.fullName,
      email: account.email || (lookupMode === "email" ? emailInput.trim().toLowerCase() : ""),
      phone: lookupMode === "phone" ? lookupPhone : undefined,
      loginCode: account.loginCode,
    });
    setDisclaimersAccepted(selectedPack!.type === "weekday" ? [false, false, false] : [false, false]);
    changeStep("review");
  }

  async function handleSelectPersonById(localId: string) {
    setLooking(true);
    try {
      const res = await fetch(`/api/bmi-office?action=person&id=${localId}`);
      const p = await res.json();
      const fullName = `${p.firstName || ""} ${p.name || ""}`.trim();
      const email = p.addresses?.[0]?.email || "";
      setPerson({ personId: String(p.id), fullName, email });
      setDisclaimersAccepted(selectedPack!.type === "weekday" ? [false, false, false] : [false, false]);
      setLooking(false);
      changeStep("review");
    } catch {
      setError("Could not load person details.");
      setLooking(false);
      setRacerView("found");
    }
  }

  async function handleCodeVerify() {
    const code = codeInput.trim();
    if (!code) return;
    // Clear stale error from a prior failed attempt — without this
    // the "Code not recognized" banner survives across retries until
    // a verify either fully succeeds or navigates away.
    setError("");
    setLooking(true);
    try {
      const res = await fetch(`/api/bmi-office?action=search&q=${encodeURIComponent(code)}&max=1`);
      const results = await res.json();
      if (!Array.isArray(results) || results.length === 0) {
        setError("Code not recognized.");
        setLooking(false);
        return;
      }
      await handleSelectPersonById(results[0].localId);
    } catch {
      setError("Verification failed.");
      setLooking(false);
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
    setLooking(true);

    try {
      const accounts = await searchAndFetchAccounts(digits);
      if (accounts.length === 0) {
        setError("No accounts found with that phone number.");
        setLooking(false);
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
        setLooking(false);
        return;
      }
      setSmsSent(true);
      setLooking(false);
    } catch {
      setError("Search failed. Please try again.");
      setLooking(false);
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
        setRacerView("found");
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
      phone: newPerson.phone,
    });
    setDisclaimersAccepted(selectedPack!.type === "weekday" ? [false, false, false] : [false, false]);
    changeStep("review");
  }

  async function handleCheckout() {
    if (!selectedPack || !person) return;
    setPaying(true);
    changeStep("paying");

    try {
      const firstName = person.fullName.split(" ")[0] || "";
      const lastName = person.fullName.split(" ").slice(1).join(" ") || "";
      const phone = person.phone || newPerson.phone || "";
      let linkedPersonId = person.personId;
      const isNewRacer = !linkedPersonId;

      // For new customers, create person via Pandora (BMI Firebird).
      // Required regardless of via-deposit vs. legacy BMI flow — we
      // need a personId to credit deposits to (or to attach to the
      // BMI bill, depending on path).
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
        }
      }

      // ── Path A: Square + Pandora-deposit workaround (default) ────────
      //
      // Skip BMI entirely: Square charges, then /api/square/pay calls
      // addDeposit server-side as a postPaymentAction. Whole flow is
      // server-atomic so a tab close between charge + credit can't
      // strand the customer.
      if (RACE_PACK_VIA_DEPOSIT) {
        if (!linkedPersonId) {
          // Pandora person create failed — without a personId we have
          // nothing to credit. Surface to the customer instead of
          // silently charging.
          throw new Error("Could not set up your racer account. Please try again or contact support.");
        }

        setPayingStatus("Preparing your race pack...");

        const billId = syntheticBillId();
        const total = calculateTotal(selectedPack.price);
        const packLabel = `${selectedPack.name} (${selectedPack.type === "weekday" ? "Mon-Thu" : "Anytime"})`;

        // Stash booking details so the confirmation page can read
        // them. `viaDeposit: true` tells the confirmation page to
        // skip the BMI payment/confirm call (no real BMI bill exists).
        const bookingDetails = {
          billId,
          amount: total.toFixed(2),
          race: packLabel,
          name: person.fullName,
          email: person.email,
          qty: String(selectedPack.raceCount),
          isCreditOrder: "false",
          type: "race-pack",
          loginCode: person.loginCode || "",
          viaDeposit: "true",
          personId: String(linkedPersonId),
          depositKindId: RACE_PACK_DEPOSIT_KIND[selectedPack.type],
          raceCount: String(selectedPack.raceCount),
        };
        await fetch("/api/booking-store", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bookingDetails),
        });
        localStorage.setItem(`booking_${billId}`, JSON.stringify(bookingDetails));

        setCheckoutBillId(billId);
        setCheckoutTotal(total);
        setCheckoutPersonId(String(linkedPersonId));
        setCheckoutIsNewRacer(isNewRacer);
        trackBookingStep("Race Pack Payment", { pack: selectedPack.name, amount: total, viaDeposit: "true" });
        setPaying(false);
        return;
      }

      // ── Path B: Legacy BMI booking/sell flow ─────────────────────────
      //
      // Polls up to 30s for the new person to sync from Firebird to
      // BMI cloud. Only relevant on this path — the via-deposit path
      // hits Pandora directly and doesn't care about cloud sync.
      if (isNewRacer && linkedPersonId) {
        setPayingStatus("Setting up your account...");
        for (let i = 0; i < 6; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const testSell = await fetch("/api/bmi?endpoint=booking%2Fsell", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: `{"ProductId":${selectedPack.productId},"PageId":${PAGE_ID},"Quantity":1,"PersonId":${linkedPersonId}}`,
          });
          const testText = await testSell.text();
          const testBillMatch = testText.match(/"orderId"\s*:\s*(\d+)/);
          if (testBillMatch) {
            await fetch(`/api/bmi?endpoint=bill/${testBillMatch[1]}/cancel`, { method: "DELETE" });
            break;
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
        sellJson = sellJson.slice(0, -1) + `,"PersonId":${linkedPersonId}}`;
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
        const regJson = `{"orderId":${billId},"PersonId":${linkedPersonId},` + JSON.stringify(regBody).slice(1);
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
        loginCode: person.loginCode || "",
      };
      await fetch("/api/booking-store", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bookingDetails),
      });
      localStorage.setItem(`booking_${billId}`, JSON.stringify(bookingDetails));

      // 4. Show inline payment form
      const packTotal = calculateTotal(selectedPack.price);
      setCheckoutBillId(billId);
      setCheckoutTotal(packTotal);
      trackBookingStep("Race Pack Payment", { pack: selectedPack.name, amount: packTotal });
      setPaying(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPaying(false);
      changeStep("review");
    }
  }

  const tax = selectedPack ? calculateTax(selectedPack.price) : 0;
  const total = selectedPack ? calculateTotal(selectedPack.price) : 0;
  const packLabel = selectedPack
    ? `${selectedPack.raceCount}-Race Pack (${selectedPack.type === "weekday" ? "Mon-Thu" : "Anytime"})`
    : "";

  return (
    <div className="min-h-screen bg-[#000418]">
      {/* Hero — full on the select step (landing), compact strip on
          subsequent steps so the form has more vertical room on
          mobile (75% of traffic). */}
      {step === "select" ? (
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
      ) : (
        <div className="pt-28 sm:pt-32 pb-2 px-4 max-w-md mx-auto">
          <button
            onClick={handleBackToSelect}
            disabled={paying}
            className="text-white/40 hover:text-white/70 text-xs font-semibold tracking-wider uppercase transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ← Choose a different pack
          </button>
          {selectedPack && (
            <div className="mt-2 flex items-baseline justify-between">
              <p className="text-white font-display text-xl uppercase tracking-wider">
                {selectedPack.raceCount}-Race Pack
              </p>
              <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-widest">
                {selectedPack.type === "weekday" ? "Mon–Thu" : "Anytime"} · ${selectedPack.price.toFixed(2)}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Temporarily unavailable banner — only shown when the
          Square+deposit workaround is OFF. With the flag ON, packs
          sell normally via Square + direct Pandora deposit credit. */}
      {!RACE_PACK_VIA_DEPOSIT && step === "select" && (
        <div className="max-w-4xl mx-auto px-4 sm:px-6 mb-6 mt-4">
          <div className="rounded-xl border-2 border-red-500/50 bg-red-500/10 p-5 flex items-start gap-3">
            <svg className="w-6 h-6 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <div>
              <p className="text-red-400 font-bold text-base">Online Race Packs Temporarily Unavailable</p>
              <p className="text-white/60 text-sm mt-1">
                Race pack purchases are temporarily unavailable online due to a technical issue. Please see an on-site team member for assistance.
              </p>
              <p className="text-amber-400 text-sm font-semibold mt-2">
                3-packs are now available through{" "}
                <Link href="/book/race" className="underline hover:text-amber-300">normal race booking</Link>
                {" "}— pick your 3 heats up front at checkout.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Step: select ─────────────────────────────────────── */}
      {step === "select" && (
        <div className="max-w-4xl mx-auto px-4 sm:px-6 pb-16">
          <div className="grid grid-cols-2 gap-4 mb-3">
            <p className="text-center text-white/30 text-xs font-bold uppercase tracking-widest">Monday – Thursday</p>
            <p className="text-center text-white/30 text-xs font-bold uppercase tracking-widest">Anytime</p>
          </div>

          {/* Pack rows — disabled only when the via-deposit workaround
              is off (BMI sell flow remains broken upstream). */}
          {[3, 5, 10].map(count => {
            const weekday = PACKS.find(p => p.raceCount === count && p.type === "weekday")!;
            const anytime = PACKS.find(p => p.raceCount === count && p.type === "anytime")!;
            return (
              <div key={count} className="grid grid-cols-2 gap-4 mb-4">
                <PackCard pack={weekday} onBuy={handleBuyNow} disabled={!RACE_PACK_VIA_DEPOSIT} />
                <PackCard pack={anytime} onBuy={handleBuyNow} disabled={!RACE_PACK_VIA_DEPOSIT} />
              </div>
            );
          })}

          <p className="text-center text-white/20 text-xs mt-6">
            Credits are non-refundable. Monday–Thursday packs valid Mon–Thu only. Anytime packs valid any day.
          </p>
        </div>
      )}

      {/* ── Steps: racer / review / paying ─────────────────────
          One centered column, no overlay. Mirrors the modal's
          containment but lives on the page so accidental taps
          can't dismiss it. */}
      {step !== "select" && selectedPack && (
        <div className="max-w-md mx-auto px-4 sm:px-6 pb-16">
          {error && (
            <div className="rounded-xl bg-red-400/10 border border-red-400/30 px-4 py-3 mb-4">
              <p className="text-red-400 text-xs">{error}</p>
            </div>
          )}

          {/* Racer step — phone/email/code/new lookup, then results */}
          {step === "racer" && (
            <div className="rounded-2xl bg-[#0a0e1a] border border-white/10 p-5 sm:p-6 space-y-4">
              {looking ? (
                <div className="flex items-center justify-center gap-3 py-8">
                  <div className="w-5 h-5 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
                  <span className="text-white/50 text-sm">Looking up...</span>
                </div>
              ) : racerView === "found" ? (
                <div className="space-y-3">
                  <p className="text-white/40 text-xs">Select your account:</p>
                  {searchResults.map(a => (
                    <button
                      key={a.personId}
                      type="button"
                      aria-label={`Select account ${a.fullName}`}
                      onClick={() => handleSelectAccount(a)}
                      className="w-full rounded-xl border border-white/10 bg-white/5 hover:border-[#00E2E5]/50 hover:bg-[#00E2E5]/5 p-4 text-left transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-white font-semibold text-sm">{a.fullName}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            {a.memberships.slice(0, 3).map((m, i) => (
                              <span key={i} className="text-xs font-bold px-1.5 py-0.5 rounded-full bg-white/10 text-white/50">{m}</span>
                            ))}
                          </div>
                          {a.creditBalances && a.creditBalances.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {a.creditBalances.map((cb, ci) => (
                                <span key={ci} className="text-xs font-semibold px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400/90">
                                  {cb.kind}: {cb.balance}
                                </span>
                              ))}
                            </div>
                          )}
                          {a.lastSeen && <p className="text-white/30 text-xs mt-1">Last seen: {a.lastSeen}</p>}
                        </div>
                        <div className="text-right shrink-0 ml-3">
                          <p className="text-[#00E2E5] font-bold text-lg">{a.races}</p>
                          <p className="text-white/30 text-xs uppercase">visits</p>
                        </div>
                      </div>
                    </button>
                  ))}
                  <button onClick={() => { setRacerView("lookup"); setError(""); }} className="text-white/30 text-xs hover:text-white/50 transition-colors">
                    ← Back to search
                  </button>
                </div>
              ) : (
                <>
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
                        onChange={e => { setPhoneInput(formatPhoneInput(e.target.value)); if (error) setError(""); }}
                        onKeyDown={e => e.key === "Enter" && handlePhoneSearch()}
                        placeholder="(239) 555-1234"
                        className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white text-sm text-center tracking-wider placeholder:text-white/25 placeholder:tracking-normal focus:border-[#00E2E5]/50 focus:outline-none"
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
                        onChange={e => { setEmailInput(e.target.value); if (error) setError(""); }}
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
                        onChange={e => { setCodeInput(e.target.value); if (error) setError(""); }}
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
                      <label className="block">
                        <span className="text-white/40 text-xs mb-1 block">Date of Birth</span>
                        <input value={newPerson.dob} onChange={e => setNewPerson(p => ({ ...p, dob: e.target.value }))} type="date" className="w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-white text-sm focus:border-[#00E2E5]/50 focus:outline-none [color-scheme:dark]" />
                      </label>
                      <button onClick={handleNewPerson} className="w-full py-3 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors">
                        Continue
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Review step — pack info + person + price + disclaimers + Pay */}
          {step === "review" && person && (() => {
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
                  <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-widest">{selectedPack.type === "weekday" ? "Monday – Thursday" : "Anytime"}</p>
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

                <button
                  onClick={() => {
                    setPerson(null);
                    setError("");
                    setDisclaimersAccepted([]);
                    setRacerView("lookup");
                    changeStep("racer");
                  }}
                  className="w-full text-white/30 text-xs hover:text-white/50 transition-colors"
                >
                  ← Change person
                </button>
              </div>
            );
          })()}

          {/* Paying step — spinner while we set up the bill, then PaymentForm */}
          {step === "paying" && (
            <div className="rounded-2xl bg-[#0a0e1a] border border-white/10 p-5 sm:p-6">
              {paying ? (
                <div className="flex flex-col items-center gap-4 py-8">
                  <div className="w-8 h-8 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
                  <p className="text-white/50 text-sm">
                    {payingStatus || "Heading to payment..."}
                  </p>
                </div>
              ) : person ? (
                <PaymentForm
                  amount={checkoutTotal}
                  itemName={packLabel}
                  billId={checkoutBillId}
                  contact={{
                    firstName: person.fullName.split(" ")[0] || "",
                    lastName: person.fullName.split(" ").slice(1).join(" ") || "",
                    email: person.email,
                    phone: person.phone || newPerson.phone || "",
                  }}
                  // Via-deposit path: attach the shared race-pack
                  // catalog id with a custom name override per variant,
                  // and let the server credit the Pandora deposit
                  // atomically with the charge. Both undefined when
                  // RACE_PACK_VIA_DEPOSIT is off → /api/square/pay
                  // falls back to the legacy "Deposit" line item.
                  lineItem={RACE_PACK_VIA_DEPOSIT ? {
                    catalogObjectId: SQUARE_RACE_PACK_CATALOG_ID,
                    name: packLabel,
                  } : undefined}
                  postPaymentAction={RACE_PACK_VIA_DEPOSIT && checkoutPersonId ? {
                    kind: "addDeposit",
                    personId: checkoutPersonId,
                    depositKindId: RACE_PACK_DEPOSIT_KIND[selectedPack.type],
                    amount: selectedPack.raceCount,
                    packLabel,
                    raceCount: selectedPack.raceCount,
                    isNewRacer: checkoutIsNewRacer,
                  } : undefined}
                  onSuccess={(result: PaymentResult) => {
                    sessionStorage.setItem(`payment_${checkoutBillId}`, JSON.stringify({
                      cardBrand: result.cardBrand,
                      cardLast4: result.cardLast4,
                      amount: result.amount,
                      paymentId: result.paymentId,
                      depositId: result.depositId,
                      depositCreditFailed: result.depositCreditFailed,
                      depositError: result.depositError,
                    }));
                    window.location.href = `/book/race-packs/confirmation?billId=${checkoutBillId}`;
                  }}
                  onError={(msg) => {
                    setError(msg);
                    changeStep("review");
                  }}
                  onCancel={() => changeStep("review")}
                />
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Pack Card ────────────────────────────────────────────────────────────────

function PackCard({ pack, onBuy, disabled }: { pack: RacePack; onBuy: (p: RacePack) => void; disabled?: boolean }) {
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
        onClick={() => !disabled && onBuy(pack)}
        disabled={disabled}
        className={`w-full py-3 rounded-xl font-bold text-sm transition-colors ${
          disabled
            ? "bg-white/10 text-white/30 cursor-not-allowed"
            : isAnytime
              ? "bg-[#00E2E5] text-[#000418] hover:bg-white"
              : "bg-blue-500 text-white hover:bg-blue-400"
        }`}
      >
        {disabled ? "Unavailable" : "Buy Now"}
      </button>
    </div>
  );
}
