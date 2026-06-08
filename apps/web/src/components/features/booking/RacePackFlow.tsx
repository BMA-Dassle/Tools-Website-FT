"use client";

import { useState } from "react";
import PaymentForm, { type PaymentResult } from "@/components/square/PaymentForm";
import ClickwrapCheckbox from "@/components/booking/ClickwrapCheckbox";
import { calculateTax, calculateTotal, isRelevantMembership } from "@/app/book/race/data";
import {
  RACE_PACKS,
  SQUARE_RACE_PACK_CATALOG_ID,
  racePackLabel,
  type RacePack,
} from "~/features/booking/data/packs";

/**
 * v2 race-pack purchase — `/book/race-pack/v2`.
 *
 * A race-pack is a PREPAID BUNDLE OF RACE CREDITS, not a booking: the customer
 * pays one price and N race credits load onto a racer's BMI/Pandora deposit
 * ledger, redeemed later at $0/heat in the normal race flow.
 *
 * This is a STANDALONE v2 flow (its own route, not the multi-activity cart) —
 * matching what v1 does, and deliberately independent of the unified
 * cart/checkout so it doesn't couple to that machinery. It reuses v1's PROVEN,
 * server-atomic money rail: `<PaymentForm>` charges Square against the shared
 * race-pack catalog SKU (custom per-variant name) and `/api/square/pay` runs the
 * `addDeposit` post-payment action so the credit grant can't strand on a tab
 * close. On success it lands on the existing `/book/race-packs/confirmation`
 * page, which already renders the via-deposit "Credits Loaded" state.
 *
 * Identity: a returning racer is found by phone/email (best match shown with
 * their current credit balance) so credits load onto their existing account; a
 * new racer's Pandora person is created at checkout. (v1's per-mode OTP is
 * omitted — loading credits is non-extractive: the buyer pays to ADD value, so
 * there's no account-takeover surface to gate.)
 */

type Step = "select" | "racer" | "review" | "paying";

interface FoundAccount {
  personId: string;
  fullName: string;
  email: string;
  lastSeen: string;
  loginCode: string;
  races: number;
  memberships: string[];
  creditBalances: { kind: string; balance: number }[];
}

const inputClass =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-[#00E2E5]/60";

function syntheticBillId(): string {
  return `pack-${Date.now()}-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
}

export function RacePackFlow() {
  const [step, setStep] = useState<Step>("select");
  const [selectedPack, setSelectedPack] = useState<RacePack | null>(null);

  // Recipient identity
  const [racerMode, setRacerMode] = useState<"lookup" | "new">("lookup");
  const [lookupInput, setLookupInput] = useState("");
  const [looking, setLooking] = useState(false);
  const [searchResults, setSearchResults] = useState<FoundAccount[]>([]);
  const [recipient, setRecipient] = useState<FoundAccount | null>(null);
  const [newPerson, setNewPerson] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    dob: "",
  });

  // Review gating
  const [disclaimersAccepted, setDisclaimersAccepted] = useState<boolean[]>([]);
  const [clickwrapAccepted, setClickwrapAccepted] = useState(false);

  // Checkout
  const [paying, setPaying] = useState(false);
  const [payingStatus, setPayingStatus] = useState("");
  const [checkoutBillId, setCheckoutBillId] = useState("");
  const [checkoutTotal, setCheckoutTotal] = useState(0);
  const [checkoutPersonId, setCheckoutPersonId] = useState("");
  const [checkoutIsNewRacer, setCheckoutIsNewRacer] = useState(false);
  const [error, setError] = useState("");

  const tax = selectedPack ? calculateTax(selectedPack.price) : 0;
  const total = selectedPack ? calculateTotal(selectedPack.price) : 0;
  const packLabel = selectedPack ? racePackLabel(selectedPack) : "";

  // ── Returning-racer search (trimmed from v1 searchAndFetchAccounts) ──────
  async function runSearch() {
    const query = lookupInput.trim();
    if (!query) return;
    setError("");
    setLooking(true);
    try {
      const res = await fetch(
        `/api/bmi-office?action=search&q=${encodeURIComponent(query)}&max=500`,
      );
      const results = await res.json();
      if (!Array.isArray(results) || results.length === 0) {
        setSearchResults([]);
        setError("No accounts found. Add as a new racer below.");
        return;
      }
      // Dedupe per name, keeping the richest description (v1 scoring heuristic).
      const scoreDesc = (d: string): number =>
        (/\(\d/.test(d) ? 100 : 0) +
        (d.includes("Memberships:") ? 50 : 0) +
        (d.includes("zip:") ? 25 : 0) +
        (d.includes("Last seen:") ? 10 : 0);
      const byName = new Map<string, { localId: string; score: number }>();
      for (const r of results as { localId: string; description: string }[]) {
        const m = r.description.match(/^([^(]+?)(?:\s*\(|$|\s+phone:|\s+Last seen:)/);
        const name = m ? m[1].trim() : r.description.split(" phone:")[0].trim();
        const score = scoreDesc(r.description);
        const ex = byName.get(name);
        if (!ex || score > ex.score) byName.set(name, { localId: r.localId, score });
      }
      const details = await Promise.all(
        [...byName.values()].slice(0, 8).map(async (r): Promise<FoundAccount | null> => {
          try {
            const p = await (await fetch(`/api/bmi-office?action=person&id=${r.localId}`)).json();
            const memberships: string[] = (p.memberships || [])
              .filter(
                (m: { stops: string; name: string }) =>
                  (!m.stops || new Date(m.stops) > new Date()) && isRelevantMembership(m.name),
              )
              .map((m: { name: string }) => m.name)
              .filter((n: string, i: number, arr: string[]) => arr.indexOf(n) === i);
            let creditBalances: { kind: string; balance: number }[] = [];
            try {
              const depRes = await fetch(`/api/bmi-office?action=deposits&personId=${p.id}`);
              if (depRes.ok) {
                const deposits: { depositKind: string; balance: number }[] = await depRes.json();
                creditBalances = deposits
                  .filter(
                    (d) =>
                      d.balance > 0 &&
                      (d.depositKind.toLowerCase().includes("credit") ||
                        d.depositKind.toLowerCase().includes("pass")),
                  )
                  .map((d) => ({ kind: d.depositKind, balance: d.balance }));
              }
            } catch {
              /* deposits are best-effort */
            }
            const tags = (p.tags || []).sort((a: { lastSeen: string }, b: { lastSeen: string }) =>
              (b.lastSeen || "").localeCompare(a.lastSeen || ""),
            );
            return {
              personId: String(p.id),
              fullName: `${p.firstName || ""} ${p.name || ""}`.trim(),
              email: p.addresses?.[0]?.email || "",
              lastSeen: p.lastLineUp
                ? new Date(p.lastLineUp).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : "",
              loginCode: tags[0]?.tag || "",
              races: tags.length,
              memberships,
              creditBalances,
            };
          } catch {
            return null;
          }
        }),
      );
      const accounts = details
        .filter((d): d is FoundAccount => d !== null)
        .sort((a, b) => {
          if (a.memberships.length !== b.memberships.length)
            return b.memberships.length - a.memberships.length;
          return (b.lastSeen || "").localeCompare(a.lastSeen || "");
        })
        .slice(0, 5);
      setSearchResults(accounts);
      if (accounts.length === 0) setError("No accounts found. Add as a new racer below.");
    } catch {
      setError("Search failed. Please try again.");
    } finally {
      setLooking(false);
    }
  }

  function selectAccount(acct: FoundAccount) {
    setRecipient(acct);
    setError("");
    setDisclaimersAccepted([]);
    setClickwrapAccepted(false);
    setStep("review");
  }

  function useNewRacer() {
    const { firstName, lastName, email, phone } = newPerson;
    if (
      !firstName.trim() ||
      !lastName.trim() ||
      !email.includes("@") ||
      phone.replace(/\D/g, "").length < 10
    ) {
      setError("Enter first name, last name, a valid email, and a phone number.");
      return;
    }
    setRecipient({
      personId: "", // created at checkout via Pandora
      fullName: `${firstName} ${lastName}`.trim(),
      email,
      lastSeen: "",
      loginCode: "",
      races: 0,
      memberships: [],
      creditBalances: [],
    });
    setError("");
    setDisclaimersAccepted([]);
    setClickwrapAccepted(false);
    setStep("review");
  }

  // ── Checkout: resolve personId, stash booking, hand to PaymentForm ───────
  async function handleCheckout() {
    if (!selectedPack || !recipient) return;
    setError("");
    setStep("paying");
    setPaying(true);
    try {
      let personId = recipient.personId;
      const isNewRacer = !personId;
      if (!personId) {
        setPayingStatus("Creating your racer account…");
        const createRes = await fetch("/api/pandora", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            firstName: newPerson.firstName,
            lastName: newPerson.lastName,
            email: newPerson.email,
            phone: newPerson.phone,
            birthdate: newPerson.dob || undefined,
          }),
        });
        const createData = await createRes.json();
        if (createData.personId) personId = String(createData.personId);
      }
      if (!personId) {
        throw new Error("Could not set up the racer account. Please try again or contact support.");
      }

      setPayingStatus("Preparing your race pack…");
      const billId = syntheticBillId();
      const bookingDetails = {
        billId,
        amount: total.toFixed(2),
        race: packLabel,
        name: recipient.fullName,
        email: recipient.email || newPerson.email,
        qty: String(selectedPack.raceCount),
        isCreditOrder: "false",
        type: "race-pack",
        loginCode: recipient.loginCode || "",
        viaDeposit: "true",
        personId,
        depositKindId: selectedPack.depositKindId,
        raceCount: String(selectedPack.raceCount),
      };
      await fetch("/api/booking-store", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bookingDetails),
      }).catch(() => {});
      try {
        localStorage.setItem(`booking_${billId}`, JSON.stringify(bookingDetails));
      } catch {
        /* private mode — non-fatal */
      }

      setCheckoutBillId(billId);
      setCheckoutTotal(total);
      setCheckoutPersonId(personId);
      setCheckoutIsNewRacer(isNewRacer);
      setPaying(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      setStep("review");
      setPaying(false);
    }
  }

  const contactForPayment = {
    firstName: (recipient?.fullName.split(" ")[0] || newPerson.firstName || "").trim(),
    lastName: (
      recipient?.fullName.split(" ").slice(1).join(" ") ||
      newPerson.lastName ||
      ""
    ).trim(),
    email: recipient?.email || newPerson.email || "",
    phone: newPerson.phone || "",
  };

  return (
    <div className="brand-fasttrax min-h-screen">
      <section className="mx-auto max-w-2xl px-4 py-8 sm:py-10">
        <header className="mb-6 text-center">
          <div
            className="mb-2 font-bold uppercase text-[#00E2E5]"
            style={{ fontSize: "12px", letterSpacing: "3px" }}
          >
            Race Credits
          </div>
          <h1 className="font-display text-2xl font-black uppercase italic tracking-wide text-white sm:text-3xl">
            Buy a Race Pack
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-white/50">
            Prepay race credits at a discount and redeem them whenever you book a heat. Credits
            never expire and load straight onto your racer account.
          </p>
        </header>

        {error && (
          <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            {error}
          </div>
        )}

        {/* ── Step: select ─────────────────────────────────────────────── */}
        {step === "select" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {RACE_PACKS.map((pack) => (
              <button
                key={pack.slug}
                type="button"
                onClick={() => {
                  setSelectedPack(pack);
                  setRecipient(null);
                  setSearchResults([]);
                  setError("");
                  setStep("racer");
                }}
                className="group flex flex-col rounded-2xl border border-white/10 bg-white/3 p-5 text-left transition-colors hover:border-[#00E2E5]/40 hover:bg-white/6"
              >
                <span className="text-[10px] font-bold uppercase tracking-widest text-[#00E2E5]">
                  {pack.dayType === "weekday" ? "Monday – Thursday" : "Anytime"}
                </span>
                <span className="font-display mt-1 text-xl font-black uppercase tracking-wider text-white">
                  {pack.name}
                </span>
                <span className="mt-1 text-xs text-white/50">
                  {pack.raceCount} race credits · ${(pack.price / pack.raceCount).toFixed(2)}/race
                </span>
                <span className="mt-3 text-lg font-bold text-white">${pack.price.toFixed(2)}</span>
              </button>
            ))}
          </div>
        )}

        {/* ── Step: racer (identity) ───────────────────────────────────── */}
        {step === "racer" && selectedPack && (
          <div className="space-y-5">
            <button
              type="button"
              onClick={() => setStep("select")}
              className="text-xs text-white/40 transition-colors hover:text-white/70"
            >
              ← Choose a different pack
            </button>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setRacerMode("lookup")}
                className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                  racerMode === "lookup"
                    ? "bg-[#00E2E5] text-[#000418]"
                    : "border border-white/15 text-white/60 hover:text-white"
                }`}
              >
                Returning racer
              </button>
              <button
                type="button"
                onClick={() => setRacerMode("new")}
                className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                  racerMode === "new"
                    ? "bg-[#00E2E5] text-[#000418]"
                    : "border border-white/15 text-white/60 hover:text-white"
                }`}
              >
                New racer
              </button>
            </div>

            {racerMode === "lookup" ? (
              <div className="space-y-3">
                <p className="text-sm text-white/60">
                  Find the account these credits should load onto.
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={lookupInput}
                    onChange={(e) => setLookupInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && runSearch()}
                    placeholder="Phone or email"
                    className={inputClass}
                  />
                  <button
                    type="button"
                    onClick={runSearch}
                    disabled={looking || !lookupInput.trim()}
                    className="rounded-lg bg-[#00E2E5] px-5 py-2.5 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:opacity-40"
                  >
                    {looking ? "…" : "Find"}
                  </button>
                </div>
                {searchResults.map((acct) => (
                  <button
                    key={acct.personId}
                    type="button"
                    onClick={() => selectAccount(acct)}
                    className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left transition-colors hover:border-[#00E2E5]/40"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-white">{acct.fullName}</p>
                      <p className="truncate text-xs text-white/40">
                        {acct.memberships[0] || "Racer"}
                        {acct.lastSeen && ` · last seen ${acct.lastSeen}`}
                      </p>
                    </div>
                    {acct.creditBalances.length > 0 && (
                      <span className="ml-3 shrink-0 rounded-full bg-[#00E2E5]/15 px-2.5 py-1 text-[11px] font-bold text-[#00E2E5]">
                        {acct.creditBalances.reduce((s, c) => s + c.balance, 0)} credits
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    value={newPerson.firstName}
                    onChange={(e) => setNewPerson((p) => ({ ...p, firstName: e.target.value }))}
                    placeholder="First name"
                    className={inputClass}
                  />
                  <input
                    type="text"
                    value={newPerson.lastName}
                    onChange={(e) => setNewPerson((p) => ({ ...p, lastName: e.target.value }))}
                    placeholder="Last name"
                    className={inputClass}
                  />
                </div>
                <input
                  type="email"
                  value={newPerson.email}
                  onChange={(e) => setNewPerson((p) => ({ ...p, email: e.target.value }))}
                  placeholder="email@example.com"
                  className={inputClass}
                />
                <input
                  type="tel"
                  value={newPerson.phone}
                  onChange={(e) => setNewPerson((p) => ({ ...p, phone: e.target.value }))}
                  placeholder="(555) 555-1234"
                  className={inputClass}
                />
                <input
                  type="date"
                  value={newPerson.dob}
                  onChange={(e) => setNewPerson((p) => ({ ...p, dob: e.target.value }))}
                  className={inputClass}
                  aria-label="Date of birth (optional)"
                />
                <button
                  type="button"
                  onClick={useNewRacer}
                  className="w-full rounded-xl bg-[#00E2E5] py-3 text-sm font-bold text-[#000418] transition-colors hover:bg-white"
                >
                  Continue →
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Step: review ─────────────────────────────────────────────── */}
        {step === "review" &&
          selectedPack &&
          recipient &&
          (() => {
            const disclaimers = [
              ...(selectedPack.dayType === "weekday"
                ? ["This pack is only valid Monday through Thursday"]
                : []),
              "Race pack is non-transferable",
              "This does not book you a race. It is highly suggested you complete a reservation after purchase.",
            ];
            const allAccepted =
              disclaimersAccepted.length >= disclaimers.length &&
              disclaimersAccepted.slice(0, disclaimers.length).every(Boolean) &&
              clickwrapAccepted;
            return (
              <div className="space-y-4">
                <div className="rounded-xl border border-[#00E2E5]/20 bg-[#00E2E5]/5 p-4 text-center">
                  <p className="text-xs font-bold uppercase tracking-widest text-[#00E2E5]">
                    {selectedPack.dayType === "weekday" ? "Monday – Thursday" : "Anytime"}
                  </p>
                  <p className="font-display mt-1 text-xl uppercase tracking-wider text-white">
                    {selectedPack.raceCount}-Race Pack
                  </p>
                  <p className="mt-1 text-xs text-white/50">
                    {selectedPack.raceCount} race credits · $
                    {(selectedPack.price / selectedPack.raceCount).toFixed(2)}/race
                  </p>
                </div>

                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">
                    Credits load onto
                  </p>
                  <p className="mt-0.5 font-bold text-white">{recipient.fullName}</p>
                  {recipient.email && <p className="text-xs text-white/40">{recipient.email}</p>}
                </div>

                <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex justify-between text-sm">
                    <span className="text-white/60">{packLabel}</span>
                    <span className="text-white">${selectedPack.price.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-white/60">Tax</span>
                    <span className="text-white">${tax.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between border-t border-white/10 pt-2 font-bold">
                    <span className="text-white">Total</span>
                    <span className="text-lg text-[#00E2E5]">${total.toFixed(2)}</span>
                  </div>
                </div>

                <div className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                  <p className="text-xs font-bold uppercase tracking-wider text-amber-400">
                    Please acknowledge
                  </p>
                  {disclaimers.map((text, i) => (
                    <label key={i} className="group flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={disclaimersAccepted[i] || false}
                        onChange={() =>
                          setDisclaimersAccepted((prev) => {
                            const next = [...prev];
                            next[i] = !next[i];
                            return next;
                          })
                        }
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/30 bg-white/5 accent-[#00E2E5]"
                      />
                      <span className="text-xs leading-relaxed text-white/70 transition-colors group-hover:text-white/90">
                        {text}
                      </span>
                    </label>
                  ))}
                </div>

                <ClickwrapCheckbox checked={clickwrapAccepted} onChange={setClickwrapAccepted} />

                <button
                  type="button"
                  onClick={handleCheckout}
                  disabled={paying || !allAccepted}
                  className="w-full rounded-xl bg-[#00E2E5] py-3.5 text-sm font-bold text-[#000418] shadow-lg shadow-[#00E2E5]/25 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {allAccepted ? `Pay $${total.toFixed(2)} →` : "Accept all terms to continue"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRecipient(null);
                    setError("");
                    setStep("racer");
                  }}
                  className="w-full text-xs text-white/30 transition-colors hover:text-white/50"
                >
                  ← Change racer
                </button>
              </div>
            );
          })()}

        {/* ── Step: paying ─────────────────────────────────────────────── */}
        {step === "paying" && selectedPack && (
          <div className="rounded-2xl border border-white/10 bg-[#0a0e1a] p-5 sm:p-6">
            {paying ? (
              <div className="flex flex-col items-center gap-4 py-8">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
                <p className="text-sm text-white/50">{payingStatus || "Heading to payment…"}</p>
              </div>
            ) : (
              <PaymentForm
                amount={checkoutTotal}
                itemName={packLabel}
                billId={checkoutBillId}
                locationId="fasttrax"
                contact={contactForPayment}
                lineItem={{ catalogObjectId: SQUARE_RACE_PACK_CATALOG_ID, name: packLabel }}
                postPaymentAction={{
                  kind: "addDeposit",
                  personId: checkoutPersonId,
                  depositKindId: selectedPack.depositKindId,
                  amount: selectedPack.raceCount,
                  packLabel,
                  raceCount: selectedPack.raceCount,
                  isNewRacer: checkoutIsNewRacer,
                }}
                onSuccess={(result: PaymentResult) => {
                  try {
                    sessionStorage.setItem(
                      `payment_${checkoutBillId}`,
                      JSON.stringify({
                        cardBrand: result.cardBrand,
                        cardLast4: result.cardLast4,
                        amount: result.amount,
                        paymentId: result.paymentId,
                        depositId: result.depositId,
                        depositCreditFailed: result.depositCreditFailed,
                        depositError: result.depositError,
                      }),
                    );
                  } catch {
                    /* non-fatal */
                  }
                  window.location.href = `/book/race-packs/confirmation?billId=${checkoutBillId}`;
                }}
                onError={(msg) => {
                  setError(msg);
                  setStep("review");
                }}
                onCancel={() => setStep("review")}
              />
            )}
          </div>
        )}
      </section>
    </div>
  );
}
