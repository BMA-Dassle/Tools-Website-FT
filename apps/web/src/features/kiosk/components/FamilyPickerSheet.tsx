"use client";

/**
 * Family picker sheet (owner 2026-09-05, "Option A" from the reviewed mockups).
 *
 * A BMI sign-in returns everyone linked to that account. They used to land on
 * the people step as a wall of green chips — a seven-person household filled
 * most of the canvas before the guest had chosen anybody.
 *
 * The family now hangs off the CARD of whoever signed in, as a pill beside the
 * licence chip, and this sheet opens from it holding only THAT person's
 * relatives (owner: "what if multiple people had family, this would fill up
 * fast" — two signed-in adults would otherwise stack two full-width strips).
 *
 * One component, mounted by both people screens (KioskPeopleStep and its twin
 * KioskPartyManager), so the picker cannot drift between them the way the
 * roster card has. The selection rules live in ../family-picker.
 */
import { allSelected, resolvePicks, selectableLinked, tooYoungToRace } from "../family-picker";

/** What the sheet needs of a relative; both screens' LinkedSuggestion satisfies it. */
export interface FamilyPickerPerson {
  id: string;
  firstName: string;
  lastName: string;
  age: number | null;
  waiverValid: boolean;
}

/** The message keys differ between the two screens (peopleUi.* vs party.*), so
 *  each caller passes its own resolved strings rather than a key prefix — a
 *  prefix would defeat the i18n catalogue's exhaustive typing. */
export interface FamilyPickerCopy {
  eyebrow: string;
  title: string;
  selectAll: string;
  clearAll: string;
  notToday: string;
  selectPrompt: string;
  /** Called with the pick count. */
  addLabel: (n: number) => string;
  /** Called with the relative's age. */
  age: (n: number) => string;
  family: string;
  tooYoungSuffix: string;
  waiverOnFileSuffix: string;
  needsWaiverSuffix: string;
  willSignSuffix: string;
}

export function FamilyPickerSheet({
  linked,
  isRace,
  selected,
  setSelected,
  onClose,
  onConfirm,
  copy,
}: {
  linked: FamilyPickerPerson[];
  isRace: boolean;
  selected: Set<string>;
  setSelected: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  onClose: () => void;
  /** Receives the chosen ids. The caller closes/guards; see KioskPeopleStep. */
  onConfirm: (picks: Set<string>) => void;
  copy: FamilyPickerCopy;
}) {
  const selectable = selectableLinked(linked, isRace);
  const everyoneChosen = allSelected(selected.size, selectable.length);

  return (
    <div className="fixed inset-0 z-[78] flex items-center justify-center bg-black/75 p-[48px] backdrop-blur-sm">
      <div className="k-glass flex max-h-full w-full max-w-[920px] flex-col gap-[28px] overflow-y-auto p-[44px]">
        <div className="flex items-end justify-between gap-[20px]">
          <div>
            <div className="k-eyebrow">{copy.eyebrow}</div>
            <div className="k-display mt-[10px] text-[52px]">{copy.title}</div>
          </div>
          {selectable.length > 1 && (
            <button
              type="button"
              onClick={() =>
                setSelected(everyoneChosen ? new Set() : new Set(selectable.map((l) => l.id)))
              }
              className="k-tap flex h-[72px] shrink-0 items-center rounded-full border border-white/15 px-[28px] text-[24px] font-semibold text-white/70"
            >
              {everyoneChosen ? copy.clearAll : copy.selectAll}
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-[16px]">
          {linked.map((lp) => {
            // Racing hard floor (7+): a linked kid under 7 can't join a race
            // party — show why instead of a dead tap.
            const tooYoung = tooYoungToRace(lp.age, isRace);
            const sel = selected.has(lp.id);
            return (
              <button
                key={lp.id}
                type="button"
                disabled={tooYoung}
                aria-pressed={sel}
                onClick={
                  tooYoung
                    ? undefined
                    : () =>
                        setSelected((prev) => {
                          const n = new Set(prev);
                          if (n.has(lp.id)) n.delete(lp.id);
                          else n.add(lp.id);
                          return n;
                        })
                }
                className={`k-tap flex items-center gap-[20px] rounded-[20px] border-2 px-[24px] py-[20px] text-left ${
                  tooYoung
                    ? "border-white/10 bg-white/[0.03] opacity-50"
                    : sel
                      ? "border-[#00e2e5]/60 bg-[#00e2e5]/[.08]"
                      : "border-white/15 bg-white/[0.03]"
                }`}
              >
                <div
                  className={`flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[14px] ${
                    sel ? "bg-[#00e2e5] text-[#04252b]" : "border-[2.5px] border-white/30"
                  }`}
                  aria-hidden="true"
                >
                  {sel && (
                    <svg
                      width="30"
                      height="30"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 13 L10 18 L19 7" />
                    </svg>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-[28px] font-bold text-white">
                    {lp.firstName} {lp.lastName}
                  </div>
                  <div
                    className={`text-[21px] ${
                      !tooYoung && !lp.waiverValid ? "text-[#f0b341]" : "text-white/50"
                    }`}
                  >
                    {lp.age !== null ? copy.age(lp.age) : copy.family}
                    {tooYoung
                      ? copy.tooYoungSuffix
                      : lp.waiverValid
                        ? copy.waiverOnFileSuffix
                        : sel
                          ? copy.willSignSuffix
                          : copy.needsWaiverSuffix}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-[16px] pt-[8px]">
          {/* Inline flex per the .kiosk-canvas cascade gotcha (see the splitWarn
              sheet): k-btn-primary's flex:1 squashes its height in a column. */}
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => {
              if (selected.size === 0) return;
              onConfirm(new Set(resolvePicks(linked, selected, isRace).map((p) => p.id)));
            }}
            className={`k-btn-primary k-tap ${selected.size === 0 ? "opacity-40" : ""}`}
            style={{ flex: "0 0 auto" }}
          >
            {selected.size === 0 ? copy.selectPrompt : copy.addLabel(selected.size)}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="k-tap rounded-2xl border border-white/15 px-[28px] py-[18px] text-[24px] font-semibold text-white/60"
          >
            {copy.notToday}
          </button>
        </div>
      </div>
    </div>
  );
}
