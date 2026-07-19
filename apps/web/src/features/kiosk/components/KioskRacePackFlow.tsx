"use client";

/**
 * STANDALONE race-pack purchase — the attract screen's "Race Packs" entry
 * (owner final design 2026-07-18). A LOCKED, pack-only flow: pick a pack →
 * who's it for (the same sign-in / new-racer machinery racing uses —
 * KioskPartyManager) → one reader payment on this flow's own Square order →
 * credits grant immediately. NO races, bowling, attractions, or Game Zone
 * cards can be added here — booking happens in its own flow, where the fresh
 * credits pay at checkout.
 *
 * The party here is LOCAL state (never the booking session): a walk-up buying
 * packs isn't booking anything. "Race today — use one now" hands the local
 * members to KioskFlow, which adopts them into the session party and opens the
 * race flow — no second sign-in (the "why the different sign-ins" rule).
 */
import { useRef, useState } from "react";
import type { PartyMember } from "~/features/booking";
import { kioskPackSkus, kioskRacePacksEnabled } from "~/features/booking/service/race-pack-kiosk";
import { kioskTerminalEnabled } from "../flags";
import { useKioskConfig } from "../KioskConfigContext";
import { KioskPartyManager, peopleReady } from "./KioskPartyManager";
import { KioskTerminalCheckoutGate } from "./KioskTerminalCheckoutGate";

/** Lee County 6.5% — client-side ESTIMATE for the gate's drift check only; the
 *  reader charges the server-authoritative order total. */
const TAX_ESTIMATE = 1.065;

type Phase = "build" | "pay" | "finalizing" | "done" | "error";

interface PackOutcome {
  memberName: string;
  label: string;
  raceCount: number;
  granted: boolean;
}

export function KioskRacePackFlow({
  brand,
  center,
  onExit,
  onRaceToday,
}: {
  brand: "fasttrax" | "headpinz";
  center: string | null;
  onExit: () => void;
  /** Adopt the flow's local members into the session party + open racing. */
  onRaceToday: (members: PartyMember[]) => void;
}) {
  const { config } = useKioskConfig();
  const [party, setParty] = useState<PartyMember[]>([]);
  const [picks, setPicks] = useState<Record<string, string>>({}); // memberId → slug
  const [phase, setPhase] = useState<Phase>("build");
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<PackOutcome[]>([]);
  const purchaseKeyRef = useRef<string | null>(null);

  const skus = kioskPackSkus();
  const readerReady = kioskTerminalEnabled() && !!config?.readerId;

  const assigned = party.filter((m) => picks[m.id] && m.bmiPersonId);
  const totalCents = assigned.reduce((s, m) => {
    const sku = skus.find((p) => p.slug === picks[m.id]);
    return s + Math.round((sku?.price ?? 0) * 100);
  }, 0);
  const readiness =
    assigned.length > 0
      ? peopleReady(
          party,
          assigned.map((m) => m.id),
        )
      : null;
  const canPay = assigned.length > 0 && readiness === true && readerReady && totalCents > 0;

  const togglePick = (memberId: string, slug: string) =>
    setPicks((cur) => {
      const next = { ...cur };
      if (next[memberId] === slug) delete next[memberId];
      else next[memberId] = slug; // one pack per racer — replace
      return next;
    });

  const prepareFn = async () => {
    const packs = assigned.map((m) => ({
      slug: picks[m.id],
      personId: m.bmiPersonId!,
      memberName: `${m.firstName} ${m.lastName ?? ""}`.trim(),
    }));
    const res = await fetch("/api/race-packs/terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "prepare", packs }),
    });
    const data = await res.json();
    if (!res.ok || !data.orderId || !(data.totalCents > 0)) {
      throw new Error(data.error || "Couldn't start the reader payment.");
    }
    purchaseKeyRef.current = data.purchaseKey;
    return { seed: data.purchaseKey, depositOrderId: data.orderId, depositCents: data.totalCents };
  };

  const finalize = async (ep: {
    paymentId: string;
    depositOrderId: string;
    amountCents: number;
  }) => {
    setPhase("finalizing");
    try {
      const res = await fetch("/api/race-packs/terminal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phase: "finalize",
          purchaseKey: purchaseKeyRef.current,
          externalPayment: {
            paymentId: ep.paymentId,
            orderId: ep.depositOrderId,
            amountCents: ep.amountCents,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok !== true) {
        // Money is ALREADY captured — never imply "pay again".
        setError(
          data.error ||
            "We received your payment but couldn't finish — please see the front desk (do not pay again).",
        );
        setPhase("error");
        return;
      }
      setOutcomes(data.packs ?? []);
      setPhase("done");
    } catch {
      setError(
        "We received your payment but couldn't finish — please see the front desk (do not pay again).",
      );
      setPhase("error");
    }
  };

  if (!kioskRacePacksEnabled() || brand !== "fasttrax") return null;

  // ── DONE ──
  if (phase === "done") {
    return (
      <div className="mx-auto w-full max-w-[880px] space-y-[24px] py-[24px]">
        <div className="k-eyebrow text-[#f0b341]">Race packs</div>
        <div className="k-display text-[64px] leading-none">You&rsquo;re loaded up.</div>
        <div className="space-y-[12px]">
          {outcomes.map((p, i) => (
            <div
              key={`${p.memberName}-${i}`}
              className="flex items-center justify-between gap-[16px] rounded-2xl border border-white/12 bg-white/[0.03] px-[24px] py-[18px]"
            >
              <div>
                <div className="text-[28px] font-bold">{p.memberName}</div>
                <div className="text-[20px] text-white/50">{p.label}</div>
              </div>
              <div className="text-right text-[24px]">
                {p.granted ? (
                  <span className="text-[#46d68c]">
                    <span className="font-extrabold">{p.raceCount} races</span> on their account —
                    never expire
                  </span>
                ) : (
                  <span className="text-amber-300/90">
                    Credits are loading — ready in a few minutes
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="text-[24px] text-white/55">
          Check in with their phone number any visit — the credits pay for races at checkout.
        </p>
        <div className="flex flex-col gap-[14px] pt-[8px]">
          <button
            type="button"
            onClick={() => onRaceToday(party)}
            className="k-btn-primary k-tap"
            style={{ flex: "0 0 auto" }}
          >
            Race today — use one now
          </button>
          <button
            type="button"
            onClick={onExit}
            className="k-btn-ghost k-tap"
            style={{ flex: "0 0 auto" }}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  // ── ERROR (post-payment) ──
  if (phase === "error") {
    return (
      <div className="mx-auto w-full max-w-[880px] space-y-[24px] py-[24px]">
        <div className="k-display text-[56px] leading-tight">Almost there</div>
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-[24px] py-[20px] text-[26px] text-red-100">
          {error}
        </div>
        <button
          type="button"
          onClick={onExit}
          className="k-btn-ghost k-tap"
          style={{ flex: "0 0 auto" }}
        >
          Back to start
        </button>
      </div>
    );
  }

  // ── PAY (reader) ──
  if (phase === "pay" || phase === "finalizing") {
    return (
      <div className="mx-auto w-full max-w-[880px] py-[24px]">
        {phase === "finalizing" ? (
          <div className="k-glass space-y-[16px] p-[40px] text-center">
            <div className="k-display text-[40px]">Loading the credits…</div>
            <p className="text-[24px] text-white/55">
              Payment received — putting the races on the account.
            </p>
          </div>
        ) : (
          <KioskTerminalCheckoutGate
            brand={brand}
            deviceId={config?.readerId ?? ""}
            depositCentsExpected={Math.round(totalCents * TAX_ESTIMATE)}
            prepareFn={prepareFn}
            onCaptured={(ep) => void finalize(ep)}
            onCancel={() => setPhase("build")}
          />
        )}
      </div>
    );
  }

  // ── BUILD: who + packs ──
  return (
    <div className="mx-auto w-full max-w-[880px] space-y-[28px] py-[8px]">
      <div>
        <div className="k-eyebrow text-[#f0b341]">Race packs</div>
        <div className="k-display text-[52px] leading-tight">
          Prepay races — bank them on an account.
        </div>
        <p className="mt-[8px] text-[24px] text-white/55">
          Sign in or set up each racer, then pick their pack. Credits never expire and pay for races
          at checkout — today or any visit.
        </p>
      </div>

      <KioskPartyManager
        mode="race"
        party={party}
        brandLocation={brand}
        center={(center as Parameters<typeof KioskPartyManager>[0]["center"]) ?? null}
        includedIds={new Set(party.map((m) => m.id))}
        onIncludedChange={() => {}}
        onAddMember={(m) => setParty((p) => [...p, m])}
        onUpdateMember={(id, patch) =>
          setParty((p) => p.map((m) => (m.id === id ? { ...m, ...patch } : m)))
        }
        onRemoveMember={(id) => {
          setParty((p) => p.filter((m) => m.id !== id));
          setPicks((cur) => {
            const next = { ...cur };
            delete next[id];
            return next;
          });
        }}
      />

      {party.length > 0 && (
        <div className="k-glass space-y-[18px] p-[28px]">
          <div className="k-eyebrow text-[#00e2e5]">Pick their packs</div>
          {party.map((m) => (
            <div key={m.id} className="space-y-[10px]">
              <div className="text-[28px] font-bold">
                {m.firstName} {m.lastName ?? ""}
                {!m.bmiPersonId && (
                  <span className="ml-[12px] text-[20px] font-normal text-amber-300/80">
                    finish their setup above first
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-[14px]">
                {skus.map((p) => {
                  const on = picks[m.id] === p.slug;
                  return (
                    <button
                      key={p.slug}
                      type="button"
                      disabled={!m.bmiPersonId}
                      onClick={() => togglePick(m.id, p.slug)}
                      aria-pressed={on}
                      className={`rounded-2xl border-2 px-[18px] py-[16px] text-center ${
                        on
                          ? "border-[#00e2e5] bg-[#00e2e5]/10 text-white"
                          : "border-white/10 bg-white/[0.02] text-white/70"
                      } ${m.bmiPersonId ? "" : "opacity-40"}`}
                    >
                      <div className="k-display text-[30px] leading-none">
                        3<span className="text-[18px]"> races</span>
                      </div>
                      <div className="mt-[6px] text-[17px] uppercase tracking-widest text-white/45">
                        {p.dayType === "weekday" ? "Mon–Thu" : "Any day"}
                      </div>
                      <div className="mt-[6px] text-[24px] font-bold tabular-nums">
                        ${p.price.toFixed(2)}
                      </div>
                      <div className="text-[16px] text-white/45">
                        ${(p.price / p.raceCount).toFixed(2)}/race
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="text-[19px] text-white/45">
            One pack per racer · non-transferable · credits never expire.
          </p>
        </div>
      )}

      {!readerReady && (
        <div className="rounded-2xl border border-amber-400/40 bg-amber-400/10 px-[24px] py-[18px] text-[24px] text-amber-100">
          The card reader isn&rsquo;t available on this kiosk — please see the front desk to buy a
          race pack.
        </div>
      )}
      {readiness !== null && readiness !== true && (
        <p className="text-[22px] text-amber-300/80">{readiness.reason}</p>
      )}

      <div className="flex flex-col gap-[14px] pb-[16px]">
        <button
          type="button"
          disabled={!canPay}
          onClick={() => setPhase("pay")}
          className="k-btn-primary k-tap disabled:opacity-40"
          style={{ flex: "0 0 auto" }}
        >
          {totalCents > 0
            ? `Pay $${(totalCents / 100).toFixed(2)} + tax on the reader`
            : "Pick a pack to continue"}
        </button>
        <button
          type="button"
          onClick={onExit}
          className="k-btn-ghost k-tap"
          style={{ flex: "0 0 auto" }}
        >
          Back
        </button>
      </div>
    </div>
  );
}
