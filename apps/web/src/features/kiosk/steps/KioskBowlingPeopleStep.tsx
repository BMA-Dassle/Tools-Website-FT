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
 *
 * Signed-in carry-over (owner 2026-07-20): the people roster IS session-scoped
 * (session.party — sign in once, carry across every activity in the
 * transaction), so when the guest already signed in for racing/an attraction,
 * this step leads with THAT group as tap-to-toggle cards (everyone bowling by
 * default) instead of making them retype names. Selected members mirror into
 * the same item.players rows the reserve reads (linked via players[].memberId,
 * with item.assignedTo kept in step for the state machine's removal cascade);
 * extra walk-up bowlers are still added as name-only rows — no account needed
 * to bowl. The booking contact stays the signed-in MAIN person (session.contact
 * carried from sign-in), shown for confirmation with email/phone editable.
 */
import { useCallback, useEffect, useRef } from "react";
import type { BowlingItem, PartyMember, StepDef } from "~/features/booking";
import { formatPersonName, normalizeEmail } from "~/lib/helpers/name-format";
import {
  type BowlPlayer,
  fullNameOf,
  playersOf,
  rowOf,
  splitName,
  whosBowlingCanAdvance,
} from "~/features/booking/service/whos-bowling";
import { useKioskConfig } from "../KioskConfigContext";
import { useLicenseScan, type AamvaLicense } from "../qr-scanner";
import { useT } from "../i18n";

type BowlItem = BowlingItem;
type Player = BowlPlayer;

const inputCls =
  "min-w-0 flex-1 rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[18px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none";
const contactInputCls =
  "rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[18px] text-[28px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none";

const KioskBowlingPeopleStepComponent: StepDef<BowlItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
}) => {
  const t = useT();
  const party = session.party;
  const hasParty = party.length > 0;
  const contact = session.contact;

  const writeRows = useCallback(
    (next: Player[]) =>
      onChange({
        players: next,
        playerCount: next.length,
        laneCount: Math.max(1, Math.ceil(next.length / 6)),
        // Party linkage for the state machine's removePartyMember cascade —
        // derived from the rows, so the two can never drift.
        assignedTo: next
          .map((r) => r.memberId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      } as Partial<BowlItem>),
    [onChange],
  );

  /* ── driver's-license scan (hardware QR scanner) ─────────────────────────
     Bowling is waiver-exempt, so a scan just adds the bowler BY NAME — no
     account, no lookup, no DOB (aamva.ts never extracts more than name+DOB,
     and this consumer uses only the name). Mounted before the mode branch —
     hooks can't live behind the early return. */
  const { config: kioskCfg } = useKioskConfig();
  const licenseScan = useLicenseScan({
    config: kioskCfg,
    enabled: true, // no-ops unless this kiosk has the scanner provisioned
    onLicense: (lic: AamvaLicense) => {
      const name = `${formatPersonName(lic.firstName)} ${formatPersonName(lic.lastName)}`.trim();
      if (!name) return;
      const rows = hasParty ? (item.players ?? []) : playersOf(item);
      if (rows.some((r) => r.name.trim().toLowerCase() === name.toLowerCase())) return;
      // Signed-in mode: a scanned PARTY member who's toggled off toggles on.
      if (hasParty) {
        const m = party.find((mm) => fullNameOf(mm).trim().toLowerCase() === name.toLowerCase());
        if (m) {
          writeRows([...rows, rowOf(m)]);
          return;
        }
      }
      // Fill the first empty row, else append (12-bowler cap, same as the UI).
      const emptyIdx = rows.findIndex((r) => !r.name.trim());
      if (emptyIdx >= 0) {
        writeRows(rows.map((r, i) => (i === emptyIdx ? { ...r, name } : r)));
        // Walk-up mode keeps the main row's name mirrored into the contact
        // (same sync setName does) — main = contact-name match, else row 0.
        if (!hasParty) {
          const mainName = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`
            .trim()
            .toLowerCase();
          const matchIdx = rows.findIndex(
            (p) => !!mainName && p.name.trim().toLowerCase() === mainName,
          );
          if (emptyIdx === (matchIdx >= 0 ? matchIdx : 0)) {
            dispatch({ type: "setContact", patch: splitName(name) });
          }
        }
      } else if (rows.length < 12) {
        writeRows([...rows, { name, shoeSize: null, bumpers: null }]);
      }
    },
  });

  // Signed-in group: seed everyone as bowling ONCE (first visit with no rows),
  // then keep party-linked rows honest — drop rows whose member left the
  // roster (racing-step Remove) and re-sync edited/formatted names. The ref
  // stops the seed from re-firing after the guest deliberately toggles the
  // whole group off mid-visit.
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
    const next: Player[] = [];
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

  /* ── signed-in group mode ─────────────────────────────────────────────── */

  if (hasParty) {
    const rows = item.players ?? [];
    const selectedIds = new Set(rows.map((r) => r.memberId).filter((id): id is string => !!id));
    // The MAIN (billing contact) renders first, matching the people step.
    const orderedParty = [...party].sort(
      (a, b) => Number(!!b.isBillingCustomer) - Number(!!a.isBillingCustomer),
    );
    const extras = rows.map((p, idx) => ({ p, idx })).filter(({ p }) => !p.memberId);

    const toggleMember = (m: PartyMember) => {
      if (selectedIds.has(m.id)) writeRows(rows.filter((r) => r.memberId !== m.id));
      else writeRows([...rows, rowOf(m)]);
    };
    // Names are stored AS TYPED and case-normalized on BLUR, never per
    // keystroke: two chars into an ALL-CAPS stream formatPersonName's output
    // ("SA" → "Sa") reads as deliberate mixed case, so every later capital is
    // preserved and the guest lands "SaRA GoODFELLOW" (owner 2026-07-21).
    // Blur (OSK "Done", tapping the next field, Continue) formats the whole
    // token at once; the reserve payload formats once more as the backstop.
    const setExtraName = (idx: number, name: string) => {
      writeRows(rows.map((p, i) => (i === idx ? { ...p, name } : p)));
    };
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

    // Main is selectable like everywhere else (owner 2026-07-20) — same
    // pattern as the racing people step: flip isBillingCustomer and make
    // that member the booking contact (their phone/email carry when known,
    // the contact fields below stay editable either way).
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

    // Contact name is normally carried from sign-in; only ask for what's
    // missing (a CRM record without a last name is the rare exception).
    const contactNameMissing = !contact.firstName?.trim() || !contact.lastName?.trim();

    return (
      <div className="space-y-[24px]">
        <p className="text-[26px] text-white/55">{t("bowlingPeople.signedInIntro")}</p>

        <div className="space-y-[16px]">
          {orderedParty.map((m) => {
            const isIn = selectedIds.has(m.id);
            return (
              <div
                key={m.id}
                className={`k-glass p-[24px] ${isIn ? "" : "opacity-55"}`}
                style={{
                  borderLeft: `8px solid ${isIn ? "#00e2e5" : "rgba(255,255,255,0.15)"}`,
                }}
              >
                <div className="flex items-center gap-[20px]">
                  <button
                    type="button"
                    onClick={() => toggleMember(m)}
                    aria-pressed={isIn}
                    aria-label={
                      isIn
                        ? t("bowlingPeople.aria.removeFromBowling", { name: m.firstName })
                        : t("bowlingPeople.aria.addToBowling", { name: m.firstName })
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
                      // Names render as entered — .k-display's design uppercase
                      // is for headings, not people (owner 2026-07-19).
                      style={{ textTransform: "none" }}
                    >
                      {m.firstName} {m.lastName ?? ""}
                    </span>
                    {m.isMinor && (
                      <span className="rounded-full bg-white/10 px-[14px] py-[4px] text-[20px] font-bold text-white/70">
                        {t("bowlingPeople.minor")}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => markMain(m.id)}
                    aria-pressed={!!m.isBillingCustomer}
                    className={`shrink-0 rounded-2xl border-2 px-[24px] py-[16px] text-[24px] font-bold ${
                      m.isBillingCustomer
                        ? "border-[#00e2e5] bg-[#00e2e5]/10 text-white"
                        : "border-white/15 text-white/55"
                    }`}
                  >
                    {m.isBillingCustomer ? `★ ${t("bowlingPeople.main")}` : t("bowlingPeople.main")}
                  </button>
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
                  placeholder={t("bowlingPeople.firstName")}
                  aria-label={t("bowlingPeople.aria.extraFirst", { num: n + 1 })}
                  className={inputCls}
                />
                <input
                  type="text"
                  value={splitName(p.name).lastName}
                  onChange={(e) => setExtraLast(idx, e.target.value)}
                  onBlur={(e) => setExtraLast(idx, formatPersonName(e.target.value))}
                  placeholder={t("bowlingPeople.lastNameOptional")}
                  aria-label={t("bowlingPeople.aria.extraLast", { num: n + 1 })}
                  className={inputCls}
                />
                <button
                  type="button"
                  onClick={() => removeExtra(idx)}
                  aria-label={t("bowlingPeople.aria.removeExtra", { num: n + 1 })}
                  className="shrink-0 text-[22px] text-white/40"
                >
                  {t("bowlingPeople.remove")}
                </button>
              </div>
            </div>
          ))}
        </div>

        {rows.length < 12 && (
          <button
            type="button"
            onClick={addExtra}
            className="k-tap w-full rounded-[28px] border-2 border-dashed border-[#00e2e5]/45 px-[24px] py-[24px] text-[28px] font-bold text-[#00e2e5]"
          >
            + {t("bowlingPeople.addAnother")}
          </button>
        )}

        {licenseScan.listening && (
          <p className="text-center text-[22px] text-white/40">{t("bowlingPeople.scanHint")}</p>
        )}

        {/* Booking contact — carried from sign-in; email/phone stay editable
            so the confirmation lands where the guest wants it. */}
        <div className="k-glass space-y-[16px] p-[24px]">
          <div className="k-eyebrow text-white/40">
            {t("bowlingPeople.confirmationGoesTo", { name: contact.firstName ?? "" })}
          </div>
          {contactNameMissing && (
            <div className="grid grid-cols-2 gap-[16px]">
              <input
                type="text"
                value={contact.firstName ?? ""}
                onChange={(e) => setContactField({ firstName: e.target.value })}
                onBlur={(e) => setContactField({ firstName: formatPersonName(e.target.value) })}
                placeholder={t("bowlingPeople.mainFirstName")}
                aria-label={t("bowlingPeople.mainFirstName")}
                className={contactInputCls}
              />
              <input
                type="text"
                value={contact.lastName ?? ""}
                onChange={(e) => setContactField({ lastName: e.target.value })}
                onBlur={(e) => setContactField({ lastName: formatPersonName(e.target.value) })}
                placeholder={t("bowlingPeople.mainLastName")}
                aria-label={t("bowlingPeople.mainLastName")}
                className={contactInputCls}
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-[16px]">
            <input
              type="email"
              inputMode="email"
              data-osk-layout="email"
              value={contact.email ?? ""}
              onChange={(e) => setContactField({ email: e.target.value })}
              placeholder={t("bowlingPeople.emailPlaceholder")}
              aria-label={t("bowlingPeople.aria.mainEmail")}
              className={contactInputCls}
            />
            <input
              type="tel"
              inputMode="tel"
              data-osk-layout="phone"
              value={contact.phone ?? ""}
              onChange={(e) => setContactField({ phone: e.target.value })}
              placeholder={t("bowlingPeople.phonePlaceholder")}
              aria-label={t("bowlingPeople.aria.mainPhone")}
              className={contactInputCls}
            />
          </div>
        </div>
      </div>
    );
  }

  /* ── walk-up mode (no signed-in group) — unchanged behavior ───────────── */

  const players = playersOf(item);
  const mainName = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim().toLowerCase();
  // Main = the row whose name matches the booking contact; else the first row.
  const matchIdx = players.findIndex((p) => !!mainName && p.name.trim().toLowerCase() === mainName);
  const mainIdx = matchIdx >= 0 ? matchIdx : 0;

  // Player.name stays the single source of truth (the reserve + QAMF roster read
  // it), but the UI edits it as separate First / Last fields (owner 2026-07-19 —
  // last name was silently required). Compose "First Last" from the two fields.
  const setName = (i: number, name: string) => {
    // Stored AS TYPED; case is normalized on blur (formatPersonName per
    // keystroke self-defeats on ALL-CAPS typing — see the signed-in mode's
    // setExtraName comment) and once more at the reserve payload.
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

  return (
    <div className="space-y-[24px]">
      <p className="text-[26px] text-white/55">{t("bowlingPeople.walkupIntro")}</p>

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
                  onBlur={(e) => setFirst(i, formatPersonName(e.target.value))}
                  placeholder={t("bowlingPeople.firstName")}
                  aria-label={t("bowlingPeople.aria.bowlerFirst", { num: i + 1 })}
                  className={inputCls}
                />
                <input
                  type="text"
                  value={splitName(p.name).lastName}
                  onChange={(e) => setLast(i, e.target.value)}
                  onBlur={(e) => setLast(i, formatPersonName(e.target.value))}
                  placeholder={t(
                    isMain ? "bowlingPeople.lastName" : "bowlingPeople.lastNameOptional",
                  )}
                  aria-label={t("bowlingPeople.aria.bowlerLast", { num: i + 1 })}
                  className={inputCls}
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
                  {isMain ? `★ ${t("bowlingPeople.main")}` : t("bowlingPeople.main")}
                </button>
                {players.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    aria-label={t("bowlingPeople.aria.removeBowler", { num: i + 1 })}
                    className="shrink-0 text-[22px] text-white/40"
                  >
                    {t("bowlingPeople.remove")}
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
                    placeholder={t("bowlingPeople.emailPlaceholder")}
                    aria-label={t("bowlingPeople.aria.mainEmail")}
                    className={contactInputCls}
                  />
                  <input
                    type="tel"
                    inputMode="tel"
                    data-osk-layout="phone"
                    value={contact.phone ?? ""}
                    onChange={(e) => setContactField({ phone: e.target.value })}
                    placeholder={t("bowlingPeople.phonePlaceholder")}
                    aria-label={t("bowlingPeople.aria.mainPhone")}
                    className={contactInputCls}
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

      {licenseScan.listening && (
        <p className="text-center text-[22px] text-white/40">
          Or scan a driver&rsquo;s license / state ID at the scanner to add a bowler.
        </p>
      )}
    </div>
  );
};

export const KioskBowlingPeopleStep: StepDef<BowlItem> = {
  id: "kiosk-bowling-people",
  // TODO(i18n): module-scope `title` + whosBowlingCanAdvance() reasons run outside
  // React — English until step titles/validation are locale-threaded (see plan).
  title: "Who's bowling?",
  Component: KioskBowlingPeopleStepComponent,
  isVisible: () => true,
  canAdvance: (item, session) => whosBowlingCanAdvance(item, session),
};
