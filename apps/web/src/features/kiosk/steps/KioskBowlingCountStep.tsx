"use client";

/**
 * Kiosk bowling entry — "How many bowlers?" (owner 2026-07-25).
 *
 * The old flow made guests sign in EVERY bowler (names + main contact) before
 * they could see a single open lane. Availability only needs the COUNT, so this
 * step captures just that and hands off; the full roster (names, shoe sizes,
 * bumpers, main contact) is collected later on KioskBowlingDetailsStep, modeled
 * on the sign-in screen guests already know.
 *
 * Two modes, one job — set item.playerCount/laneCount before availability:
 *  • WALK-UP (no signed-in party): a +/- count stepper. No typing.
 *  • SIGNED-IN (session.party present): keep the fast tap-to-toggle cards from
 *    the old people step (everyone bowling by default) so a group that signed in
 *    for racing doesn't retype names. Contact + "main" designation move to the
 *    details step.
 *
 * Changing the count after an offer/hold was picked resets the offer (the
 * "9-booked-7-charged" guard — twin of BowlingPlayersStep.setCount): party size
 * drives per-person pricing, the QAMF hold, and the quote, so the package must
 * rebuild at the new count.
 */
import { useCallback, useEffect, useRef } from "react";
import type { BowlingItem, PartyMember, StepDef } from "~/features/booking";
import { formatPersonName } from "~/lib/helpers/name-format";
import {
  type BowlPlayer,
  fullNameOf,
  rowOf,
  splitName,
} from "~/features/booking/service/whos-bowling";
import { useKioskConfig } from "../KioskConfigContext";
import { useLicenseScan, type AamvaLicense } from "../qr-scanner";

const MIN_PLAYERS = 1;
const MAX_PLAYERS = 12;
const PLAYERS_PER_LANE = 6;

const inputCls =
  "min-w-0 flex-1 rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[18px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none";

/**
 * Fields to clear when the bowler count changes after an offer/hold exists, so
 * the package rebuilds for the new party size instead of booking N and charging
 * the stale quantity. Mirrors BowlingPlayersStep.setCount (web flow).
 */
function offerResetPatch(item: BowlingItem): Partial<BowlingItem> {
  if (!item.webOfferId && item.lineItems.length === 0) return {};
  return {
    experienceId: null,
    experienceSlug: null,
    webOfferId: null,
    optionId: null,
    optionType: null,
    bookedAt: null,
    lineItems: [],
    rawItems: [],
    qamfReservationId: null,
    durationMinutes: null,
    durationMultiplier: 1,
    hasBookingFee: false,
    shoeSelections: {},
    shoeProducts: undefined,
    quoteDayofOrderId: null,
    quoteTotalCents: 0,
    quoteDepositCents: 0,
    quoteDiscountOffCents: 0,
  } as Partial<BowlingItem>;
}

const KioskBowlingCountStepComponent: StepDef<BowlingItem>["Component"] = ({
  item,
  session,
  onChange,
}) => {
  const party = session.party;
  const hasParty = party.length > 0;

  // Signed-in roster write — keeps players/playerCount/laneCount/assignedTo in
  // lockstep and resets a stale offer when the count changed.
  const writeRows = useCallback(
    (next: BowlPlayer[]) => {
      const patch: Partial<BowlingItem> = {
        players: next,
        playerCount: next.length,
        laneCount: Math.max(1, Math.ceil(next.length / PLAYERS_PER_LANE)),
        assignedTo: next
          .map((r) => r.memberId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      };
      if (next.length !== item.playerCount) Object.assign(patch, offerResetPatch(item));
      onChange(patch);
    },
    [onChange, item],
  );

  // Walk-up count write — no roster here; the details step's rosterOf pads/
  // truncates player rows from playerCount, preserving any names already typed.
  const setCount = useCallback(
    (n: number) => {
      const clamped = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n));
      if (clamped === item.playerCount) return;
      const patch: Partial<BowlingItem> = {
        playerCount: clamped,
        laneCount: Math.max(1, Math.ceil(clamped / PLAYERS_PER_LANE)),
      };
      Object.assign(patch, offerResetPatch(item));
      onChange(patch);
    },
    [onChange, item],
  );

  /* ── driver's-license scan (hardware QR scanner) ──────────────────────────
     Signed-in: a scanned party member toggles ON. Walk-up: a scan just bumps
     the count (the name is collected on the details step). No-ops unless the
     kiosk has a scanner provisioned. */
  const { config: kioskCfg } = useKioskConfig();
  useLicenseScan({
    config: kioskCfg,
    enabled: true,
    onLicense: (lic: AamvaLicense) => {
      if (hasParty) {
        const name = `${formatPersonName(lic.firstName)} ${formatPersonName(lic.lastName)}`.trim();
        const rows = item.players ?? [];
        const m = party.find((mm) => fullNameOf(mm).trim().toLowerCase() === name.toLowerCase());
        if (m && !rows.some((r) => r.memberId === m.id)) writeRows([...rows, rowOf(m)]);
      } else if (item.playerCount < MAX_PLAYERS) {
        setCount(item.playerCount + 1);
      }
    },
  });

  // Seed the signed-in group as all-bowling once, then keep party-linked rows
  // honest (drop rows whose member left racing, re-sync renamed members). The
  // ref stops the seed re-firing after a deliberate toggle-everyone-off.
  const seeded = useRef(false);
  useEffect(() => {
    if (!hasParty) return;
    const current = item.players ?? [];
    if (current.length === 0) {
      if (!seeded.current) {
        seeded.current = true;
        writeRows(party.map(rowOf));
      }
      return;
    }
    seeded.current = true;
    let changed = false;
    const nextRows: BowlPlayer[] = [];
    for (const r of current) {
      if (!r.memberId) {
        nextRows.push(r);
        continue;
      }
      const m = party.find((mm) => mm.id === r.memberId);
      if (!m) {
        changed = true;
        continue;
      }
      const name = fullNameOf(m);
      if (name !== r.name) {
        changed = true;
        nextRows.push({ ...r, name });
      } else {
        nextRows.push(r);
      }
    }
    if (changed) writeRows(nextRows);
  }, [hasParty, party, item.players, writeRows]);

  /* ── signed-in group mode — tap who's bowling ─────────────────────────── */
  if (hasParty) {
    const rows = item.players ?? [];
    const selectedIds = new Set(rows.map((r) => r.memberId).filter((id): id is string => !!id));
    const orderedParty = [...party].sort(
      (a, b) => Number(!!b.isBillingCustomer) - Number(!!a.isBillingCustomer),
    );
    const extras = rows.map((p, idx) => ({ p, idx })).filter(({ p }) => !p.memberId);

    const toggleMember = (m: PartyMember) => {
      if (selectedIds.has(m.id)) writeRows(rows.filter((r) => r.memberId !== m.id));
      else writeRows([...rows, rowOf(m)]);
    };
    const setExtraName = (idx: number, name: string) =>
      writeRows(rows.map((p, i) => (i === idx ? { ...p, name } : p)));
    const setExtraFirst = (idx: number, first: string) => {
      const { lastName } = splitName(rows[idx].name);
      setExtraName(idx, `${first.trim()} ${lastName}`.trim());
    };
    const setExtraLast = (idx: number, last: string) => {
      const { firstName } = splitName(rows[idx].name);
      setExtraName(idx, `${firstName} ${last.trim()}`.trim());
    };
    const addExtra = () => writeRows([...rows, { name: "", shoeSize: null, bumpers: null }]);
    const removeExtra = (idx: number) => writeRows(rows.filter((_, i) => i !== idx));

    return (
      <div className="space-y-[24px]">
        <p className="text-[26px] text-white/55">
          Your group is signed in — tap who&rsquo;s bowling. Anyone else can join without an
          account.
        </p>

        <div className="space-y-[16px]">
          {orderedParty.map((m) => {
            const isIn = selectedIds.has(m.id);
            return (
              <div
                key={m.id}
                className={`k-glass p-[24px] ${isIn ? "" : "opacity-55"}`}
                style={{ borderLeft: `8px solid ${isIn ? "#00e2e5" : "rgba(255,255,255,0.15)"}` }}
              >
                <div className="flex items-center gap-[20px]">
                  <button
                    type="button"
                    onClick={() => toggleMember(m)}
                    aria-pressed={isIn}
                    aria-label={
                      isIn ? `Remove ${m.firstName} from bowling` : `Add ${m.firstName} to bowling`
                    }
                    className={`grid h-[64px] w-[64px] shrink-0 place-items-center rounded-2xl border-2 text-[32px] font-bold ${
                      isIn
                        ? "border-[#00e2e5] bg-[#00e2e5] text-[#04252b]"
                        : "border-white/20 text-transparent"
                    }`}
                  >
                    ✓
                  </button>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-[16px] gap-y-[6px]">
                    <span
                      className="k-display truncate text-[40px]"
                      style={{ textTransform: "none" }}
                    >
                      {m.firstName} {m.lastName ?? ""}
                    </span>
                    {m.isMinor && (
                      <span className="rounded-full bg-white/10 px-[14px] py-[4px] text-[20px] font-bold text-white/70">
                        Minor
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {extras.map(({ p, idx }, n) => (
            <div
              key={`extra-${n}`}
              className="k-glass p-[24px]"
              style={{ borderLeft: "8px solid rgba(255,255,255,0.15)" }}
            >
              <div className="flex items-center gap-[16px]">
                <input
                  type="text"
                  value={splitName(p.name).firstName}
                  onChange={(e) => setExtraFirst(idx, e.target.value)}
                  onBlur={(e) => setExtraFirst(idx, formatPersonName(e.target.value))}
                  placeholder="First name"
                  aria-label={`Extra bowler ${n + 1} first name`}
                  className={inputCls}
                />
                <input
                  type="text"
                  value={splitName(p.name).lastName}
                  onChange={(e) => setExtraLast(idx, e.target.value)}
                  onBlur={(e) => setExtraLast(idx, formatPersonName(e.target.value))}
                  placeholder="Last name (optional)"
                  aria-label={`Extra bowler ${n + 1} last name`}
                  className={inputCls}
                />
                <button
                  type="button"
                  onClick={() => removeExtra(idx)}
                  aria-label={`Remove extra bowler ${n + 1}`}
                  className="shrink-0 text-[22px] text-white/40"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>

        {rows.length < MAX_PLAYERS && (
          <button
            type="button"
            onClick={addExtra}
            className="k-tap w-full rounded-[28px] border-2 border-dashed border-[#00e2e5]/45 px-[24px] py-[24px] text-[28px] font-bold text-[#00e2e5]"
          >
            + Add another bowler
          </button>
        )}
      </div>
    );
  }

  /* ── walk-up mode — just the number ───────────────────────────────────── */
  const count = item.playerCount;
  const laneCount = Math.max(1, Math.ceil(count / PLAYERS_PER_LANE));

  return (
    <div className="flex flex-col items-center gap-[48px] py-[40px] text-center">
      <p className="text-[26px] text-white/55">
        Up to {PLAYERS_PER_LANE} per lane — we&rsquo;ll assign lanes automatically.
      </p>

      <div className="flex items-center gap-[56px]">
        <button
          type="button"
          onClick={() => setCount(count - 1)}
          disabled={count <= MIN_PLAYERS}
          aria-label="One fewer bowler"
          className="k-tap grid h-[132px] w-[132px] place-items-center rounded-full border-2 border-white/15 text-[70px] font-bold text-white disabled:opacity-30"
        >
          &minus;
        </button>
        <div>
          <div
            className="k-display k-num text-[150px] leading-none text-white"
            style={{ fontStyle: "italic" }}
          >
            {count}
          </div>
          <div className="mt-[6px] text-[26px] text-white/40">bowler{count !== 1 ? "s" : ""}</div>
        </div>
        <button
          type="button"
          onClick={() => setCount(count + 1)}
          disabled={count >= MAX_PLAYERS}
          aria-label="One more bowler"
          className="k-tap grid h-[132px] w-[132px] place-items-center rounded-full border-2 border-white/15 text-[70px] font-bold text-white disabled:opacity-30"
        >
          +
        </button>
      </div>

      {laneCount > 1 && (
        <p className="text-[26px] text-white/50">
          {laneCount} lanes · {PLAYERS_PER_LANE} bowlers per lane
        </p>
      )}
    </div>
  );
};

export const KioskBowlingCountStep: StepDef<BowlingItem> = {
  id: "kiosk-bowling-count",
  title: "How many bowlers?",
  Component: KioskBowlingCountStepComponent,
  isVisible: () => true,
  canAdvance: (item, session) => {
    if (session.party.length > 0) {
      return (item.players?.length ?? 0) >= 1
        ? true
        : { reason: "Tap at least one bowler — or add a bowler." };
    }
    return item.playerCount >= MIN_PLAYERS ? true : { reason: "Add at least one bowler." };
  },
};
