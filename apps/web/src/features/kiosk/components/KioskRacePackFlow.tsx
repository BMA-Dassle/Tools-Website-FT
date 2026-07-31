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
import {
  kioskPackSkus,
  kioskRacePacksEnabled,
  racePackLicenseEnabled,
} from "~/features/booking/service/race-pack-kiosk";
import { LICENSE_PRICE } from "~/features/booking/service/race-pricing";
import { useT } from "../i18n";
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

/** A pack grant handed to the race flow so the session's balance snapshots
 *  include it (they were taken at sign-in, BEFORE the standalone purchase). */
export interface RaceTodayGrant {
  /** Raw BMI person id string — NEVER Number() it. */
  bmiPersonId: string;
  depositKindId: string;
  raceCount: number;
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
  /** Adopt the flow's local members into the session party + open racing.
   *  `grants` = the packs just purchased, so the adopted members' credit
   *  balances reflect them (a failed grant still rides — the reconcile cron
   *  lands it, and the guest DID pay). */
  onRaceToday: (members: PartyMember[], grants: RaceTodayGrant[]) => void;
}) {
  const { config } = useKioskConfig();
  const t = useT();
  const [party, setParty] = useState<PartyMember[]>([]);
  const [picks, setPicks] = useState<Record<string, string>>({}); // memberId → slug
  const [phase, setPhase] = useState<Phase>("build");
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<PackOutcome[]>([]);
  const [licenseOutcomes, setLicenseOutcomes] = useState<
    Array<{ memberName: string; registered: boolean }>
  >([]);
  const purchaseKeyRef = useRef<string | null>(null);

  // Standalone surface sells ALL six SKUs — 3/5/10 × Mon–Thu/Any-Day (owner
  // 2026-07-19); weekday SKUs still hide Fri–Sun.
  const skus = kioskPackSkus(new Date(), "standalone");
  const readerReady = !!config?.readerId;

  const assigned = party.filter((m) => picks[m.id] && m.bmiPersonId);
  const packCents = assigned.reduce((s, m) => {
    const sku = skus.find((p) => p.slug === picks[m.id]);
    return s + Math.round((sku?.price ?? 0) * 100);
  }, 0);
  // FastTrax license for each new racer buying a pack (flag-gated). Client hint
  // only — the server re-verifies each racer's license status and re-derives the
  // charge; the reader charges (and displays) the server-authoritative total.
  const licenseCents = Math.round(LICENSE_PRICE * 100);
  const newRacers = racePackLicenseEnabled() ? assigned.filter((m) => m.isNewRacer) : [];
  const totalCents = packCents + newRacers.length * licenseCents;
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
      isNewRacer: m.isNewRacer === true,
      email: m.email ?? undefined,
      phone: m.phone ?? undefined,
    }));
    const res = await fetch("/api/race-packs/terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "prepare", packs }),
    });
    const data = await res.json();
    if (!res.ok || !data.orderId || !(data.totalCents > 0)) {
      throw new Error(data.error || t("racePack.err.startReaderPayment"));
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
        setError(data.error || t("racePack.error.body"));
        setPhase("error");
        return;
      }
      setOutcomes(data.packs ?? []);
      setLicenseOutcomes(data.licenses ?? []);
      setPhase("done");
    } catch {
      setError(t("racePack.error.body"));
      setPhase("error");
    }
  };

  if (!kioskRacePacksEnabled() || brand !== "fasttrax") return null;

  // ── DONE ──
  if (phase === "done") {
    return (
      <div className="mx-auto w-full max-w-[880px] space-y-[24px] py-[24px]">
        <div className="k-eyebrow text-[#f0b341]">{t("racePack.eyebrow")}</div>
        <div className="k-display text-[64px] leading-none">{t("racePack.done.title")}</div>
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
                    <span className="font-extrabold">
                      {t("racePack.done.racesBold", { count: p.raceCount })}
                    </span>{" "}
                    {t("racePack.done.onAccount")}
                  </span>
                ) : (
                  <span className="text-amber-300/90">{t("racePack.done.creditsLoading")}</span>
                )}
              </div>
            </div>
          ))}
        </div>
        {licenseOutcomes.length > 0 && (
          <div className="rounded-2xl border border-[#f0b341]/30 bg-[#f0b341]/[0.06] px-[24px] py-[18px]">
            {licenseOutcomes.every((l) => l.registered) ? (
              <div className="text-[24px] text-white/80">
                <span className="font-bold text-[#46d68c]">
                  {t("racePack.done.licenseAddedBold")}
                </span>{" "}
                {t("racePack.done.licenseAddedRest", {
                  names: licenseOutcomes.map((l) => l.memberName).join(", "),
                })}
              </div>
            ) : (
              <div className="text-[24px] text-amber-200/90">
                {t("racePack.done.licenseSettingUp")}
              </div>
            )}
          </div>
        )}
        <p className="text-[24px] text-white/55">{t("racePack.done.checkInAnyVisit")}</p>
        <div className="flex flex-col gap-[14px] pt-[8px]">
          <button
            type="button"
            onClick={() => {
              // Racers we just charged a license for are now licensed (BMI sale
              // fired; a failed one is reconciled — the guest paid once either
              // way). Mark them licensePrepaid on the hand-off so the immediate
              // race checkout adds NO second $4.99 license and books no second
              // withLicense grant — while isNewRacer stays true, so Starter-only
              // tier + the height/age safety confirm still apply.
              const licensedIds = new Set(newRacers.map((m) => m.id));
              const handoffParty = party.map((m) =>
                licensedIds.has(m.id) ? { ...m, licensePrepaid: true } : m,
              );
              onRaceToday(
                handoffParty,
                handoffParty.flatMap((m): RaceTodayGrant[] => {
                  const sku = skus.find((p) => p.slug === picks[m.id]);
                  return sku && m.bmiPersonId
                    ? [
                        {
                          bmiPersonId: m.bmiPersonId,
                          depositKindId: sku.depositKindId,
                          raceCount: sku.raceCount,
                        },
                      ]
                    : [];
                }),
              );
            }}
            className="k-btn-primary k-tap"
            style={{ flex: "0 0 auto" }}
          >
            {t("racePack.done.raceToday")}
          </button>
          <button
            type="button"
            onClick={onExit}
            className="k-btn-ghost k-tap"
            style={{ flex: "0 0 auto" }}
          >
            {t("racePack.done.done")}
          </button>
        </div>
      </div>
    );
  }

  // ── ERROR (post-payment) ──
  if (phase === "error") {
    return (
      <div className="mx-auto w-full max-w-[880px] space-y-[24px] py-[24px]">
        <div className="k-display text-[56px] leading-tight">{t("racePack.error.title")}</div>
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-[24px] py-[20px] text-[26px] text-red-100">
          {error}
        </div>
        <button
          type="button"
          onClick={onExit}
          className="k-btn-ghost k-tap"
          style={{ flex: "0 0 auto" }}
        >
          {t("racePack.error.backToStart")}
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
            <div className="k-display text-[40px]">{t("racePack.finalizing.title")}</div>
            <p className="text-[24px] text-white/55">{t("racePack.finalizing.body")}</p>
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
        <div className="k-eyebrow text-[#f0b341]">{t("racePack.eyebrow")}</div>
        <div className="k-display text-[52px] leading-tight">{t("racePack.build.title")}</div>
        <p className="mt-[8px] text-[24px] text-white/55">{t("racePack.build.subtitle")}</p>
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
          <div className="k-eyebrow text-[#00e2e5]">{t("racePack.build.pickPacks")}</div>
          {party.map((m) => (
            <div key={m.id} className="space-y-[10px]">
              <div className="text-[28px] font-bold">
                {m.firstName} {m.lastName ?? ""}
                {!m.bmiPersonId && (
                  <span className="ml-[12px] text-[20px] font-normal text-amber-300/80">
                    {t("racePack.build.finishSetup")}
                  </span>
                )}
              </div>
              <div className={`grid gap-[14px] ${skus.length > 2 ? "grid-cols-3" : "grid-cols-2"}`}>
                {skus.map((p) => {
                  const on = picks[m.id] === p.slug;
                  return (
                    <button
                      key={p.slug}
                      type="button"
                      disabled={!m.bmiPersonId}
                      onClick={() => togglePick(m.id, p.slug)}
                      aria-pressed={on}
                      className={`rounded-2xl border-2 px-[14px] py-[16px] text-center ${
                        on
                          ? "border-[#00e2e5] bg-[#00e2e5]/10 text-white"
                          : "border-white/10 bg-white/[0.02] text-white/70"
                      } ${m.bmiPersonId ? "" : "opacity-40"}`}
                    >
                      <div className="k-display text-[30px] leading-none">
                        {p.raceCount}
                        <span className="text-[18px]"> {t("racePack.build.racesWord")}</span>
                      </div>
                      <div className="mt-[6px] text-[16px] uppercase tracking-widest text-white/45">
                        {p.dayType === "weekday"
                          ? t("racePack.build.monThu")
                          : t("racePack.build.anyDay")}
                      </div>
                      <div className="mt-[6px] text-[24px] font-bold tabular-nums">
                        ${p.price.toFixed(2)}
                      </div>
                      <div className="text-[16px] text-white/45">
                        {t("racePack.build.perRace", {
                          price: `$${(p.price / p.raceCount).toFixed(2)}`,
                        })}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {newRacers.length > 0 && (
            <div className="rounded-2xl border-2 border-[#f0b341]/40 bg-[#f0b341]/[0.08] px-[24px] py-[20px]">
              <div className="k-eyebrow text-[#f0b341]">{t("racePack.build.licenseRequired")}</div>
              <p className="mt-[6px] text-[22px] leading-snug text-white/80">
                {t("racePack.build.licenseLead", { count: newRacers.length })}{" "}
                <span className="font-bold text-white">
                  {t("racePack.build.licensePriceEach", {
                    price: `$${LICENSE_PRICE.toFixed(2)}`,
                  })}
                </span>
                {t("racePack.build.licenseTail", { count: newRacers.length })}
              </p>
              <p className="mt-[8px] text-[19px] text-white/50">
                {t("racePack.build.licenseFor", {
                  names: newRacers.map((m) => m.firstName).join(", "),
                })}
              </p>
            </div>
          )}
          <p className="text-[19px] text-white/45">{t("racePack.build.fineprint")}</p>
        </div>
      )}

      {!readerReady && (
        <div className="rounded-2xl border border-amber-400/40 bg-amber-400/10 px-[24px] py-[18px] text-[24px] text-amber-100">
          {t("racePack.build.readerUnavailable")}
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
            ? t("racePack.build.payButton", {
                amount: `$${(totalCents / 100).toFixed(2)}`,
              })
            : t("racePack.build.pickToContinue")}
        </button>
        <button
          type="button"
          onClick={onExit}
          className="k-btn-ghost k-tap"
          style={{ flex: "0 0 auto" }}
        >
          {t("racePack.build.back")}
        </button>
      </div>
    </div>
  );
}
