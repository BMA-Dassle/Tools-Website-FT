"use client";

/**
 * Unified kiosk people list — the ONE identity method for BOTH racing and
 * waiver-gated attractions (owner 2026-07-18: "why the different sign-ins?").
 *
 * The roster IS session.party, so it is SESSION-SCOPED: sign in / set someone
 * up once and they carry across every activity in the transaction — a later
 * activity never re-prompts a person who's already set up (owner rule). Racing
 * and attractions share this exact screen; the only difference is racing races
 * the whole party while an attraction toggles who's in that one activity.
 *
 * The actual screens (roster cards, new-player form, returning lookup, waiver
 * photo + signature overlay) live in KioskPartyManager — extracted so the
 * standalone group-waiver flow reuses them verbatim. This file is the booking
 * wizard's StepDef wrapper: it maps the manager's callbacks onto the session
 * reducer and keeps the step registration ids stable.
 */
import type { AttractionItem, RaceItem, StepDef } from "~/features/booking";
import { getComboSpecial, comboMinHeadcount } from "~/features/combos/combo-specials";
import { KioskPartyManager, peopleReady } from "../components/KioskPartyManager";

/** Waiver-gated attraction slugs (duckpin is exempt — uses the party-count step). */
const WAIVER_SLUGS = new Set(["gel-blaster", "laser-tag", "shuffly"]);

const PeopleStepComponent: StepDef<RaceItem | AttractionItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
  setBusy,
}) => {
  const isRace = item.kind === "race";
  const attractionItem = item as AttractionItem;

  // Racing races the whole party; an attraction toggles who's in THIS one.
  const included = new Set(
    isRace
      ? session.party.map((m) => m.id)
      : (attractionItem.participants ?? session.party.map((m) => m.id)),
  );

  return (
    <KioskPartyManager
      mode={isRace ? "race" : "attraction"}
      party={session.party}
      brandLocation={session.entryBrand === "headpinz" ? "headpinz" : "fasttrax"}
      center={session.center}
      contactEmail={session.contact.email}
      contactPhone={session.contact.phone}
      includedIds={included}
      onIncludedChange={(ids) => {
        if (isRace) return;
        onChange({
          participants: Array.from(ids),
          qty: Math.max(ids.size, 1),
        } as Partial<AttractionItem>);
      }}
      onAddMember={(member) => dispatch({ type: "addPartyMember", member })}
      onUpdateMember={(id, patch) => dispatch({ type: "updatePartyMember", id, patch })}
      onRemoveMember={(id) => dispatch({ type: "removePartyMember", id })}
      onSetContact={(m) =>
        dispatch({
          type: "setContact",
          patch: {
            firstName: m.firstName,
            lastName: m.lastName ?? "",
            ...(m.phone ? { phone: m.phone } : {}),
            ...(m.email ? { email: m.email } : {}),
          },
        })
      }
      setBusy={setBusy}
    />
  );
};

/** Racing: the whole party races. id "race-party" preserved so KioskFlow's
 *  height-confirm intercept still fires. */
export const KioskRacePeopleStep: StepDef<RaceItem> = {
  id: "race-party",
  title: "Who's racing?",
  Component: PeopleStepComponent as StepDef<RaceItem>["Component"],
  isVisible: () => true,
  canAdvance: (_item, session) => {
    const base = peopleReady(
      session.party,
      session.party.map((m) => m.id),
    );
    if (base !== true) return base;
    // Combo minimum headcount (e.g. the Ultimate VIP is 2+ guests) — was not
    // enforced, so a 1-person combo could advance (owner bug).
    const combo = session.comboSpecialId ? getComboSpecial(session.comboSpecialId) : null;
    if (combo) {
      const min = comboMinHeadcount(combo);
      if (session.party.length < min) {
        return {
          reason: `The ${combo.name} is for ${min}+ guests — add ${min - session.party.length} more.`,
        };
      }
    }
    return true;
  },
};

/** Waiver-gated attractions (gel/laser/shuf): toggle who's in this one. */
export const KioskAttractionPeopleStep: StepDef<AttractionItem> = {
  id: "kiosk-who",
  title: "Who's playing?",
  Component: PeopleStepComponent as StepDef<AttractionItem>["Component"],
  isVisible: (item) => WAIVER_SLUGS.has(item.slug ?? ""),
  canAdvance: (item, session) => {
    if (!WAIVER_SLUGS.has(item.slug ?? "")) return true;
    const ids = item.participants ?? session.party.map((m) => m.id);
    return peopleReady(session.party, ids);
  },
};
