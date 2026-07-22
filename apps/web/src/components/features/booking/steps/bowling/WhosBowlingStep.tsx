"use client";

/**
 * WhosBowlingStep — the phone-native "Who's bowling?" people step for the
 * FastTrax duckpin "Play Now" (per-lane QR) flow.
 *
 * This is the responsive port of the kiosk KioskBowlingPeopleStep the owner
 * asked to reuse (2026-07-22 screenshot): same experience — add a name per
 * bowler, tap ONE person as the main contact (they give email + mobile), with
 * an optional "been here before? sign in" that reuses the SHARED
 * ReturningRacerLookup (phone/OTP → pull the account, no PII pre-verify) so
 * returning guests keep their loyalty. Bowling/duckpin are waiver-EXEMPT, so
 * there is no waiver / DOB / guardian branch — everyone can bowl.
 *
 * The roster logic (name<->row mapping, advance gate) is shared with the kiosk
 * step via ~/features/booking/service/whos-bowling; only the presentation
 * differs (kiosk canvas px vs. responsive rem here). It writes the SAME three
 * fields the bowling reserve path reads — item.players (names),
 * item.playerCount/laneCount, and session.contact (the main person) — so the
 * reserve/checkout pipeline is unaffected.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BowlingItem, StepDef } from "~/features/booking";
import { newPartyMember } from "~/features/booking";
import { formatPersonName, normalizeEmail } from "~/lib/helpers/name-format";
import {
  type BowlPlayer,
  fullNameOf,
  playersOf,
  rowOf,
  splitName,
  whosBowlingCanAdvance,
} from "~/features/booking/service/whos-bowling";
import {
  ReturningRacerLookup,
  type PersonData,
} from "~/components/features/booking/steps/race/ReturningRacerLookup";

const ACCENT = "#00E2E5";
const inputCls =
  "min-w-0 flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-base text-white placeholder-white/30 focus:border-[#00E2E5] focus:outline-none";

const WhosBowlingStepComponent: StepDef<BowlingItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
  setBusy,
}) => {
  const party = session.party;
  const hasParty = party.length > 0;
  const contact = session.contact;
  const [signingIn, setSigningIn] = useState(false);

  const writeRows = useCallback(
    (next: BowlPlayer[]) =>
      onChange({
        players: next,
        playerCount: next.length,
        laneCount: Math.max(1, Math.ceil(next.length / 6)),
        // Party linkage for the state machine's removePartyMember cascade —
        // derived from the rows so the two can never drift.
        assignedTo: next
          .map((r) => r.memberId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      } as Partial<BowlingItem>),
    [onChange],
  );

  // Signed-in group: seed everyone as bowling ONCE (first visit with no rows),
  // then keep party-linked rows honest — drop rows whose member left and
  // re-sync edited names. The ref stops the seed re-firing after a deliberate
  // toggle-off. (Mirrors KioskBowlingPeopleStep.)
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
    const next: BowlPlayer[] = [];
    for (const r of current) {
      if (!r.memberId) {
        next.push(r);
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
        next.push({ ...r, name });
      } else {
        next.push(r);
      }
    }
    if (changed) writeRows(next);
  }, [hasParty, party, item.players, writeRows]);

  /* ── scanned-lane availability check (no hold yet — owner 2026-07-22) ────
   * The QR names a lane; on mount we CHECK it's free (GET availability, no
   * side effects). If it's busy, the swap list shows immediately — before the
   * guest types anything. The actual pinned HOLD happens when they pick a
   * duration on the next step, so changing duration never collides with our
   * own hold (the live-test bug: hold-on-scan made lane 5 look occupied to a
   * re-hold). Nothing but a human at lane N scanning N's QR competes for it in
   * the meantime. */
  const pinnedLane = item.pinnedLaneNumber ?? null;
  const [lanePhase, setLanePhase] = useState<"checking" | "ok" | "busy" | "error">(
    item.qamfReservationId ? "ok" : pinnedLane == null ? "error" : "checking",
  );
  const [openLanes, setOpenLanes] = useState<number[]>([]);
  const [laneMsg, setLaneMsg] = useState(
    !item.qamfReservationId && pinnedLane == null
      ? "This QR didn't include a lane — please see the front desk."
      : "",
  );
  const checkAttempted = useRef(false);

  const checkLane = useCallback(
    async (lane: number) => {
      setLanePhase("checking");
      setBusy?.(true);
      try {
        const r = await fetch(`/api/bowling/v2/bowl-now/availability?lane=${lane}`, {
          cache: "no-store",
        });
        const data = await r.json();
        if (!r.ok) {
          setLaneMsg(typeof data.error === "string" ? data.error : "Couldn't check the lane.");
          setLanePhase("error");
          return;
        }
        if (data.laneFree) {
          onChange({ pinnedLaneNumber: lane } as Partial<BowlingItem>);
          setLanePhase("ok");
        } else {
          setOpenLanes(Array.isArray(data.openLanes) ? data.openLanes : []);
          setLaneMsg(`Lane ${lane} is in play right now.`);
          setLanePhase("busy");
        }
      } catch {
        setLaneMsg("Connection hiccup — try again.");
        setLanePhase("error");
      } finally {
        setBusy?.(false);
      }
    },
    [onChange, setBusy],
  );

  useEffect(() => {
    // Check the scanned lane exactly once on entry (a held session skips it —
    // the guest already has their lane). State transitions live in checkLane.
    if (checkAttempted.current || item.qamfReservationId || pinnedLane == null) return;
    checkAttempted.current = true;
    void checkLane(pinnedLane);
  }, [item.qamfReservationId, pinnedLane, checkLane]);

  const setContactField = (patch: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  }) =>
    dispatch({
      type: "setContact",
      // Emails are stored lowercase (owner 2026-07-19).
      patch: patch.email !== undefined ? { ...patch, email: normalizeEmail(patch.email) } : patch,
    });

  /* ── returning-player sign-in (optional; reuses the shared lookup) ──────── */

  const handleVerified = (person: PersonData, claimMain: boolean) => {
    // Skip a duplicate account (same Pandora/BMI id already in the party).
    if (person.personId && party.some((m) => m.bmiPersonId === person.personId)) return;
    const firstName = person.fullName.split(/\s+/)[0] || person.fullName;
    const lastName = person.fullName.split(/\s+/).slice(1).join(" ") || undefined;
    const member = newPartyMember({
      firstName,
      lastName,
      bmiPersonId: person.personId,
      isNewRacer: false,
      isBillingCustomer: claimMain,
      memberships: person.memberships,
      waiverValid: person.waiverValid,
      creditBalances: person.creditBalances,
      phone: person.phone || undefined,
      email: person.email ? normalizeEmail(person.email) : undefined,
      phoneVerified: person.phoneVerified,
    });
    dispatch({ type: "addPartyMember", member });
    // Select the signed-in person for bowling (append, drop any blank walk-up row).
    const realRows = (item.players ?? []).filter((r) => splitName(r.name).firstName);
    writeRows([...realRows, rowOf(member)]);
    if (claimMain) {
      setContactField({
        firstName,
        lastName: lastName ?? "",
        ...(person.email ? { email: person.email } : {}),
        ...(person.phone ? { phone: person.phone } : {}),
      });
      // Fill any missing email/phone from Pandora (login-code lookups lack them).
      if (person.personId) {
        fetch(`/api/pandora?personId=${person.personId}&picture=false`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (!data) return;
            const patch: { email?: string; phone?: string } = {};
            if (!person.email && typeof data.email === "string" && data.email)
              patch.email = data.email;
            if (!person.phone && data.phone) patch.phone = String(data.phone);
            if (patch.email || patch.phone) setContactField(patch);
          })
          .catch(() => {});
      }
    }
    setSigningIn(false);
  };

  const handleSingleVerified = (person: PersonData) => {
    // Claim main only if no one holds it yet.
    handleVerified(person, !party.some((m) => m.isBillingCustomer));
  };
  const handleMultipleVerified = (people: PersonData[]) => {
    let claim = !party.some((m) => m.isBillingCustomer);
    for (const person of people) {
      handleVerified(person, claim);
      claim = false;
    }
  };

  // Play Now lane states take precedence over the people form.
  if (lanePhase === "checking") {
    return <PlayNowStatus title={`Checking Lane ${pinnedLane ?? ""}…`} spinner />;
  }
  if (lanePhase === "error") {
    return (
      <PlayNowStatus
        title="We hit a snag"
        message={laneMsg}
        onRetry={pinnedLane != null ? () => checkLane(pinnedLane) : undefined}
      />
    );
  }
  if (lanePhase === "busy") {
    return (
      <SwapLanes
        lane={pinnedLane}
        message={laneMsg}
        openLanes={openLanes}
        onPick={(m) => checkLane(m)}
      />
    );
  }

  if (signingIn) {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <Heading />
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <ReturningRacerLookup
            onVerified={handleSingleVerified}
            onVerifiedMultiple={handleMultipleVerified}
            onSwitchToNew={() => setSigningIn(false)}
            introText="Find your account — we'll text or email you a code"
            switchToNewLabel="Actually, I'll just add names →"
          />
          <button
            type="button"
            className="mt-3 w-full py-2 text-center text-sm text-white/40"
            onClick={() => setSigningIn(false)}
          >
            ← Back
          </button>
        </div>
      </div>
    );
  }

  /* ── signed-in group mode (party present) ───────────────────────────────── */

  if (hasParty) {
    const rows = item.players ?? [];
    const selectedIds = new Set(rows.map((r) => r.memberId).filter((id): id is string => !!id));
    // Main (billing contact) renders first.
    const orderedParty = [...party].sort(
      (a, b) => Number(!!b.isBillingCustomer) - Number(!!a.isBillingCustomer),
    );
    const extras = rows.map((p, idx) => ({ p, idx })).filter(({ p }) => !p.memberId);

    const toggleMember = (memberId: string) => {
      if (selectedIds.has(memberId)) writeRows(rows.filter((r) => r.memberId !== memberId));
      else {
        const m = party.find((x) => x.id === memberId);
        if (m) writeRows([...rows, rowOf(m)]);
      }
    };
    // Names stored AS TYPED; case-normalized on BLUR (per-keystroke formatting
    // self-defeats on ALL-CAPS typing — owner 2026-07-21).
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

    const markMain = (id: string) => {
      party.forEach((m) => {
        const shouldBe = m.id === id;
        if (!!m.isBillingCustomer !== shouldBe) {
          dispatch({ type: "updatePartyMember", id: m.id, patch: { isBillingCustomer: shouldBe } });
        }
      });
      const m = party.find((x) => x.id === id);
      if (m) {
        dispatch({
          type: "setContact",
          patch: {
            firstName: m.firstName,
            lastName: m.lastName ?? "",
            ...(m.phone ? { phone: m.phone } : {}),
            ...(m.email ? { email: normalizeEmail(m.email) } : {}),
          },
        });
      }
    };

    // Per-bowler bumpers (owner 2026-07-22): duckpin KEEPS bumpers, and the
    // kiosk collects them on its details step — Play Now has no details step,
    // so they live right on the sign-in rows. Reserve reads players[].bumpers
    // → QAMF ActivateBumpers; wiring already exists.
    const toggleMemberBumpers = (memberId: string) =>
      writeRows(rows.map((r) => (r.memberId === memberId ? { ...r, bumpers: !r.bumpers } : r)));
    const toggleExtraBumpers = (idx: number) =>
      writeRows(rows.map((r, i) => (i === idx ? { ...r, bumpers: !r.bumpers } : r)));

    const contactNameMissing = !contact.firstName?.trim() || !contact.lastName?.trim();

    return (
      <div className="mx-auto max-w-md space-y-6">
        <Heading />
        <p className="text-sm text-white/50">
          Your group is signed in — tap who&rsquo;s bowling. Anyone else can join without an
          account.
        </p>

        <div className="space-y-3">
          {orderedParty.map((m) => {
            const isIn = selectedIds.has(m.id);
            return (
              <div
                key={m.id}
                className={`rounded-2xl border border-white/10 bg-white/5 p-4 ${isIn ? "" : "opacity-60"}`}
                style={{ borderLeft: `6px solid ${isIn ? ACCENT : "rgba(255,255,255,0.15)"}` }}
              >
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => toggleMember(m.id)}
                    aria-pressed={isIn}
                    aria-label={
                      isIn ? `Remove ${m.firstName} from bowling` : `Add ${m.firstName} to bowling`
                    }
                    className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl border-2 text-lg font-bold ${
                      isIn
                        ? "border-[#00E2E5] bg-[#00E2E5] text-[#04252b]"
                        : "border-white/20 text-transparent"
                    }`}
                  >
                    ✓
                  </button>
                  <span className="min-w-0 flex-1 truncate text-lg font-semibold text-white">
                    {m.firstName} {m.lastName ?? ""}
                    {m.isMinor && (
                      <span className="ml-2 rounded-full bg-white/10 px-2 py-0.5 text-xs font-bold text-white/70">
                        Minor
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => markMain(m.id)}
                    aria-pressed={!!m.isBillingCustomer}
                    className={`shrink-0 rounded-xl border-2 px-3 py-2 text-sm font-bold ${
                      m.isBillingCustomer
                        ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                        : "border-white/15 text-white/55"
                    }`}
                  >
                    {m.isBillingCustomer ? "★ Main" : "Main"}
                  </button>
                </div>
                {isIn && (
                  <div className="mt-3 flex justify-end">
                    <BumperChip
                      on={!!rows.find((r) => r.memberId === m.id)?.bumpers}
                      onToggle={() => toggleMemberBumpers(m.id)}
                      name={m.firstName}
                    />
                  </div>
                )}
              </div>
            );
          })}

          {extras.map(({ p, idx }, n) => (
            <div
              key={`extra-${n}`}
              className="rounded-2xl border border-white/10 bg-white/5 p-4"
              style={{ borderLeft: "6px solid rgba(255,255,255,0.15)" }}
            >
              <div className="flex items-center gap-3">
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
                  className="shrink-0 text-sm text-white/40"
                >
                  Remove
                </button>
              </div>
              <div className="mt-3 flex justify-end">
                <BumperChip
                  on={!!p.bumpers}
                  onToggle={() => toggleExtraBumpers(idx)}
                  name={splitName(p.name).firstName || `Bowler ${n + 1}`}
                />
              </div>
            </div>
          ))}
        </div>

        {rows.length < 12 && (
          <button
            type="button"
            onClick={addExtra}
            className="w-full rounded-2xl border-2 border-dashed border-[#00E2E5]/45 px-4 py-4 text-base font-bold text-[#00E2E5]"
          >
            + Add another bowler
          </button>
        )}

        {/* Booking contact — carried from sign-in; email/phone stay editable. */}
        <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-xs font-bold uppercase tracking-widest text-white/40">
            Confirmation goes to {contact.firstName ?? ""}
          </div>
          {contactNameMissing && (
            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                value={contact.firstName ?? ""}
                onChange={(e) => setContactField({ firstName: e.target.value })}
                onBlur={(e) => setContactField({ firstName: formatPersonName(e.target.value) })}
                placeholder="Main person first name"
                aria-label="Main person first name"
                className={inputCls}
              />
              <input
                type="text"
                value={contact.lastName ?? ""}
                onChange={(e) => setContactField({ lastName: e.target.value })}
                onBlur={(e) => setContactField({ lastName: formatPersonName(e.target.value) })}
                placeholder="Main person last name"
                aria-label="Main person last name"
                className={inputCls}
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              value={contact.email ?? ""}
              onChange={(e) => setContactField({ email: e.target.value })}
              placeholder="Email (for your confirmation)"
              aria-label="Main person email"
              className={inputCls}
            />
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={contact.phone ?? ""}
              onChange={(e) => setContactField({ phone: e.target.value })}
              placeholder="Mobile phone"
              aria-label="Main person mobile phone"
              className={inputCls}
            />
          </div>
        </div>
      </div>
    );
  }

  /* ── walk-up mode (no signed-in group) — the default per-lane QR entry ──── */

  const players = playersOf(item);
  const mainName = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim().toLowerCase();
  const matchIdx = players.findIndex((p) => !!mainName && p.name.trim().toLowerCase() === mainName);
  const mainIdx = matchIdx >= 0 ? matchIdx : 0;

  const setName = (i: number, name: string) => {
    writeRows(players.map((p, idx) => (idx === i ? { ...p, name } : p)));
    if (i === mainIdx) dispatch({ type: "setContact", patch: splitName(name) });
  };
  const setFirst = (i: number, first: string) => {
    const { lastName } = splitName(players[i].name);
    setName(i, `${first.trim()} ${lastName}`.trim());
  };
  const setLast = (i: number, last: string) => {
    const { firstName } = splitName(players[i].name);
    setName(i, `${firstName} ${last.trim()}`.trim());
  };
  const addRow = () => writeRows([...players, { name: "", shoeSize: null, bumpers: null }]);
  const removeRow = (i: number) => {
    if (players.length <= 1) return;
    writeRows(players.filter((_, idx) => idx !== i));
  };
  const setMain = (i: number) =>
    dispatch({ type: "setContact", patch: splitName(players[i].name) });

  const toggleBumpers = (i: number) =>
    writeRows(players.map((p, idx) => (idx === i ? { ...p, bumpers: !p.bumpers } : p)));

  return (
    <div className="mx-auto max-w-md space-y-6">
      <Heading />
      <p className="text-sm text-white/50">
        Add everyone bowling, and tap one person as the main contact for the reservation.
      </p>

      <div className="space-y-3">
        {players.map((p, i) => {
          const isMain = i === mainIdx;
          return (
            <div
              key={i}
              className="rounded-2xl border border-white/10 bg-white/5 p-4"
              style={{ borderLeft: `6px solid ${isMain ? ACCENT : "rgba(255,255,255,0.15)"}` }}
            >
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={splitName(p.name).firstName}
                  onChange={(e) => setFirst(i, e.target.value)}
                  onBlur={(e) => setFirst(i, formatPersonName(e.target.value))}
                  placeholder="First name"
                  aria-label={`Bowler ${i + 1} first name`}
                  className={inputCls}
                />
                <input
                  type="text"
                  value={splitName(p.name).lastName}
                  onChange={(e) => setLast(i, e.target.value)}
                  onBlur={(e) => setLast(i, formatPersonName(e.target.value))}
                  placeholder={isMain ? "Last name" : "Last name (optional)"}
                  aria-label={`Bowler ${i + 1} last name`}
                  className={inputCls}
                />
                <button
                  type="button"
                  onClick={() => setMain(i)}
                  aria-pressed={isMain}
                  className={`shrink-0 rounded-xl border-2 px-3 py-2 text-sm font-bold ${
                    isMain
                      ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                      : "border-white/15 text-white/55"
                  }`}
                >
                  {isMain ? "★ Main" : "Main"}
                </button>
                {players.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    aria-label={`Remove bowler ${i + 1}`}
                    className="shrink-0 text-sm text-white/40"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="mt-3 flex justify-end">
                <BumperChip
                  on={!!p.bumpers}
                  onToggle={() => toggleBumpers(i)}
                  name={splitName(p.name).firstName || `Bowler ${i + 1}`}
                />
              </div>
              {isMain && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={contact.email ?? ""}
                    onChange={(e) => setContactField({ email: e.target.value })}
                    placeholder="Email (for your confirmation)"
                    aria-label="Main person email"
                    className={inputCls}
                  />
                  <input
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    value={contact.phone ?? ""}
                    onChange={(e) => setContactField({ phone: e.target.value })}
                    placeholder="Mobile phone"
                    aria-label="Main person mobile phone"
                    className={inputCls}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {players.length < 12 && (
        <button
          type="button"
          onClick={addRow}
          className="w-full rounded-2xl border-2 border-dashed border-[#00E2E5]/45 px-4 py-4 text-base font-bold text-[#00E2E5]"
        >
          + Add another bowler
        </button>
      )}

      <button
        type="button"
        onClick={() => setSigningIn(true)}
        className="w-full py-2 text-center text-sm font-semibold text-white/50 underline decoration-white/20 underline-offset-4"
      >
        Been here before? Sign in to pull your account
      </button>
    </div>
  );
};

/** Per-bowler bumpers toggle — duckpin keeps bumpers (owner decision). */
function BumperChip({ on, onToggle, name }: { on: boolean; onToggle: () => void; name: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      aria-label={`Bumpers for ${name}`}
      className={`rounded-full border px-3 py-1.5 text-xs font-bold uppercase tracking-wider ${
        on ? "border-[#00E2E5] bg-[#00E2E5]/10 text-[#00E2E5]" : "border-white/15 text-white/45"
      }`}
    >
      Bumpers {on ? "on" : "off"}
    </button>
  );
}

function Heading() {
  return (
    <div>
      <h2 className="font-display text-2xl uppercase tracking-widest text-white">
        Who&rsquo;s Bowling?
      </h2>
    </div>
  );
}

/** Transient loader / error screen while the scanned lane is being held. */
function PlayNowStatus({
  title,
  message,
  spinner,
  onRetry,
}: {
  title: string;
  message?: string;
  spinner?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      {spinner && (
        <span className="h-9 w-9 animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
      )}
      <h2 className="font-display text-2xl uppercase tracking-widest text-white">{title}</h2>
      {message && <p className="text-sm text-white/60">{message}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-xl bg-[#00E2E5] px-6 py-3 text-base font-bold text-[#04252b]"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/** Scanned lane busy → tap an open lane to book it instead (in-app swap). */
function SwapLanes({
  lane,
  message,
  openLanes,
  onPick,
}: {
  lane: number | null;
  message: string;
  openLanes: number[];
  onPick: (lane: number) => void;
}) {
  return (
    <div className="mx-auto max-w-md space-y-6">
      <div>
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          Lane {lane ?? ""} is in play
        </h2>
        <p className="mt-1 text-sm text-white/60">
          {message || "Pick another open lane to bowl now — or walk over and scan its QR."}
        </p>
      </div>
      {openLanes.length > 0 ? (
        <div className="grid grid-cols-2 gap-3">
          {openLanes.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onPick(n)}
              className="rounded-2xl border-2 border-[#00E2E5]/45 bg-white/5 px-4 py-6 text-lg font-bold text-white"
            >
              Lane {n}
              <span className="mt-1 block text-xs font-semibold uppercase tracking-widest text-[#00E2E5]">
                Open now
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-white/60">
          All duckpin lanes are full right now. Check back in a few minutes, or see the front desk.
        </p>
      )}
    </div>
  );
}

const WhosBowlingStep: StepDef<BowlingItem> = {
  id: "whos-bowling",
  title: "Who's bowling?",
  Component: WhosBowlingStepComponent,
  isVisible: () => true,
  canAdvance: (item, session) => whosBowlingCanAdvance(item, session),
};

export default WhosBowlingStep;
