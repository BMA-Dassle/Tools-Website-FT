"use client";

/**
 * Kiosk bowling entry — "Who's bowling?" (owner 2026-07-18: bowling should lead
 * with the add-people + main-person screen, not a bare YOUR INFO contact form).
 *
 * Bowling/duckpin are waiver-EXEMPT, so this is a light roster: add a name per
 * bowler and tap ONE person as the main contact (they also give email + mobile).
 * It writes the SAME three fields the bowling reserve path reads — item.players
 * (names), item.playerCount/laneCount, and session.contact (from the main
 * person) — so the reserve is provably unaffected and the ContactStep +
 * player-count stepper are dropped. Shoes/bumpers are still collected later in
 * KioskBowlingDetailsStep (it pre-seeds from these names).
 */
import type { BowlingItem, StepDef } from "~/features/booking";
import { formatPersonName, normalizeEmail } from "../name-format";

type BowlItem = BowlingItem;
type Player = { name: string; shoeSize: string | null; bumpers: boolean | null };

function playersOf(item: BowlItem): Player[] {
  const p = item.players ?? [];
  return p.length > 0 ? p : [{ name: "", shoeSize: null, bumpers: null }];
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

const KioskBowlingPeopleStepComponent: StepDef<BowlItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
}) => {
  const players = playersOf(item);
  const contact = session.contact;
  const mainName = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim().toLowerCase();
  // Main = the row whose name matches the booking contact; else the first row.
  const matchIdx = players.findIndex((p) => !!mainName && p.name.trim().toLowerCase() === mainName);
  const mainIdx = matchIdx >= 0 ? matchIdx : 0;

  const writeRows = (next: Player[]) =>
    onChange({
      players: next,
      playerCount: next.length,
      laneCount: Math.max(1, Math.ceil(next.length / 6)),
    } as Partial<BowlItem>);

  // Player.name stays the single source of truth (the reserve + QAMF roster read
  // it), but the UI edits it as separate First / Last fields (owner 2026-07-19 —
  // last name was silently required). Compose "First Last" from the two fields.
  const setName = (i: number, name: string) => {
    // Normalize case as typed (owner 2026-07-19: no all-caps names) — the
    // formatted value is what the reserve/QAMF roster and contact receive.
    const clean = formatPersonName(name);
    writeRows(players.map((p, idx) => (idx === i ? { ...p, name: clean } : p)));
    if (i === mainIdx) dispatch({ type: "setContact", patch: splitName(clean) });
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
  const setContactField = (patch: { email?: string; phone?: string }) =>
    dispatch({
      type: "setContact",
      // Emails are stored lowercase (owner 2026-07-19).
      patch: patch.email !== undefined ? { ...patch, email: normalizeEmail(patch.email) } : patch,
    });

  return (
    <div className="space-y-[24px]">
      <p className="text-[26px] text-white/55">
        Add everyone bowling, and tap one person as the main contact for the reservation.
      </p>

      <div className="space-y-[16px]">
        {players.map((p, i) => {
          const isMain = i === mainIdx;
          return (
            <div
              key={i}
              className="k-glass p-[24px]"
              style={{ borderLeft: `8px solid ${isMain ? "#00e2e5" : "rgba(255,255,255,0.15)"}` }}
            >
              <div className="flex items-center gap-[16px]">
                <input
                  type="text"
                  value={splitName(p.name).firstName}
                  onChange={(e) => setFirst(i, e.target.value)}
                  placeholder="First name"
                  aria-label={`Bowler ${i + 1} first name`}
                  className="min-w-0 flex-1 rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[18px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                />
                <input
                  type="text"
                  value={splitName(p.name).lastName}
                  onChange={(e) => setLast(i, e.target.value)}
                  placeholder={isMain ? "Last name" : "Last name (optional)"}
                  aria-label={`Bowler ${i + 1} last name`}
                  className="min-w-0 flex-1 rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[18px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setMain(i)}
                  aria-pressed={isMain}
                  className={`shrink-0 rounded-2xl border-2 px-[24px] py-[16px] text-[24px] font-bold ${
                    isMain
                      ? "border-[#00e2e5] bg-[#00e2e5]/10 text-white"
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
                    className="shrink-0 text-[22px] text-white/40"
                  >
                    Remove
                  </button>
                )}
              </div>
              {isMain && (
                <div className="mt-[16px] grid grid-cols-2 gap-[16px]">
                  <input
                    type="email"
                    inputMode="email"
                    data-osk-layout="email"
                    value={contact.email ?? ""}
                    onChange={(e) => setContactField({ email: e.target.value })}
                    placeholder="Email (for your confirmation)"
                    aria-label="Main person email"
                    className="rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[18px] text-[28px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                  />
                  <input
                    type="tel"
                    inputMode="tel"
                    data-osk-layout="phone"
                    value={contact.phone ?? ""}
                    onChange={(e) => setContactField({ phone: e.target.value })}
                    placeholder="Mobile phone"
                    aria-label="Main person mobile phone"
                    className="rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[18px] text-[28px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
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
          className="k-tap w-full rounded-[28px] border-2 border-dashed border-[#00e2e5]/45 px-[24px] py-[24px] text-[28px] font-bold text-[#00e2e5]"
        >
          + Add another bowler
        </button>
      )}
    </div>
  );
};

export const KioskBowlingPeopleStep: StepDef<BowlItem> = {
  id: "kiosk-bowling-people",
  title: "Who's bowling?",
  Component: KioskBowlingPeopleStepComponent,
  isVisible: () => true,
  canAdvance: (item, session) => {
    const players = item.players ?? [];
    if (players.length === 0 || players.some((p) => !splitName(p.name).firstName)) {
      return { reason: "Add a first name for every bowler." };
    }
    const c = session.contact;
    if (!c.firstName?.trim() || !c.lastName?.trim()) {
      return { reason: "The main person needs a first and last name." };
    }
    if (!c.email?.includes("@")) return { reason: "The main person needs an email." };
    if ((c.phone ?? "").replace(/\D/g, "").length < 10) {
      return { reason: "The main person needs a mobile number." };
    }
    return true;
  },
};
