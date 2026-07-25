"use client";

/**
 * Kiosk bowler roster — the sign-in-style "Who's bowling?" screen, now the ONE
 * place the full roster is captured (owner 2026-07-25). It replaces both the old
 * lead-off sign-in step and the separate shoe-quantity step:
 *
 *  • Per bowler: name (typed for walk-ups, pre-filled for a signed-in group),
 *    shoe size, bumpers — each card COLLAPSES to a green-barred summary once it's
 *    complete, so focus moves to whoever's left.
 *  • Main contact (email/phone + who gets the confirmation) lives here now, not
 *    on the first screen — the reserve reads session.contact, captured before it.
 *  • Shoe rentals are DERIVED from the sizes chosen (pick "own shoes" → no charge)
 *    instead of a separate group count, so the charge can't drift from the sizes.
 *    Gated to item.kind === "bowling" and to shoe-rental centers; shoe-included
 *    packages (Fun-4-All / Pizza Bowl / VIP) collect sizes but charge $0.
 *
 * KBF (item.kind === "kbf") is intentionally untouched: it keeps its own shoe
 * step + this step's original name/shoe/bumpers capture, with no contact block
 * and no derived shoe charge.
 *
 * Shoe size uses the same cascading category → size vocabulary as the web
 * confirmation editor ("Male 9" / "Female 8" / "Toddler 10"); "" = own shoes
 * (normalized to null at reserve), null = unanswered.
 */
import { useEffect, useMemo, useState } from "react";
import type { BookingSession, BowlingItem, KbfItem, StepDef } from "~/features/booking";
import { formatPersonName, normalizeEmail } from "~/lib/helpers/name-format";
import { centerHasShoeRental } from "@/lib/qamf-centers";
import type { BowlingSquareProduct } from "@/lib/bowling-db";
import { splitName, whosBowlingCanAdvance } from "~/features/booking/service/whos-bowling";
import {
  QAMF_SHOE_CENTER_CODES,
  deriveShoePatch,
  shoeRentalCount,
} from "~/features/booking/service/bowling-shoes";

type RosterPlayer = {
  name: string;
  shoeSize: string | null;
  bumpers: boolean | null;
  memberId?: string;
};
type BowlItem = BowlingItem | KbfItem;

const SHOE_SIZES: Record<string, string[]> = {
  Toddler: ["6", "7", "8", "9", "10", "11", "12", "13"],
  Male: [
    "1",
    "1.5",
    "2",
    "2.5",
    "3",
    "3.5",
    "4",
    "4.5",
    "5",
    "5.5",
    "6",
    "6.5",
    "7",
    "7.5",
    "8",
    "8.5",
    "9",
    "9.5",
    "10",
    "10.5",
    "11",
    "11.5",
    "12",
    "12.5",
    "13",
    "13.5",
    "14",
    "14.5",
    "15",
  ],
  Female: [
    "1",
    "1.5",
    "2",
    "2.5",
    "3",
    "3.5",
    "4",
    "4.5",
    "5",
    "5.5",
    "6",
    "6.5",
    "7",
    "7.5",
    "8",
    "8.5",
    "9",
    "9.5",
    "10",
    "10.5",
    "11",
    "11.5",
    "12",
  ],
};

const SHOE_CATEGORIES: Array<{ value: keyof typeof SHOE_SIZES; label: string }> = [
  { value: "Toddler", label: "Toddler" },
  { value: "Male", label: "Men's" },
  { value: "Female", label: "Women's" },
];

/** "Own shoes" sentinel — an explicit answer that isn't a rental size. */
const OWN_SHOES = "";

const CAT_LABEL: Record<string, string> = { Male: "Men's", Female: "Women's", Toddler: "Toddler" };

function categoryOf(shoeSize: string | null): string | null {
  if (shoeSize === null) return null;
  if (shoeSize === OWN_SHOES) return OWN_SHOES;
  const cat = shoeSize.split(" ")[0];
  return cat in SHOE_SIZES ? cat : null;
}

/** Human summary of a stored size for the collapsed card ("Male 9" → "Men's 9"). */
function shoeSummary(shoeSize: string | null): string {
  if (shoeSize === null) return "";
  if (shoeSize === OWN_SHOES) return "Own shoes";
  const [cat, size] = shoeSize.split(" ");
  return `${CAT_LABEL[cat] ?? cat} ${size ?? ""}`.trim();
}

function playerCountOf(item: BowlItem): number {
  return item.kind === "bowling" ? item.playerCount : item.bowlers.length + item.paidAdults;
}

function rosterOf(item: BowlItem): RosterPlayer[] {
  const count = playerCountOf(item);
  const existing = item.players ?? [];
  return Array.from({ length: count }, (_, i) => ({
    ...existing[i],
    name: existing[i]?.name ?? "",
    shoeSize: existing[i] ? existing[i].shoeSize : null,
    bumpers: existing[i] ? existing[i].bumpers : null,
  }));
}

function playerComplete(p: RosterPlayer, hasShoes: boolean): boolean {
  const shoeOk = !hasShoes || p.shoeSize !== null;
  return p.name.trim().length > 0 && shoeOk && p.bumpers !== null;
}

const inputCls =
  "w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[18px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none";

const KioskBowlingDetailsStepComponent: StepDef<BowlItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
}) => {
  const roster = rosterOf(item);
  const isBowling = item.kind === "bowling";
  const hasShoes = centerHasShoeRental(item.qamfCenterId);
  const contact = session.contact;

  const [openCat, setOpenCat] = useState<Record<number, string>>({});
  // Which card is expanded; completed cards collapse unless being edited.
  const [activeEdit, setActiveEdit] = useState<number>(() =>
    rosterOf(item).findIndex((p) => !playerComplete(p, hasShoes)),
  );

  // Shoe catalog for the derived charge (bowling + shoe-rental center only).
  const centerCode = QAMF_SHOE_CENTER_CODES[item.qamfCenterId ?? 9172] ?? "TXBSQN0FEKQ11";
  const [products, setProducts] = useState<BowlingSquareProduct[]>([]);
  useEffect(() => {
    if (!isBowling || !hasShoes) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/bowling/v2/square-products?centerCode=${centerCode}&kind=addon_shoe`,
        );
        const data = await res.json();
        if (!cancelled) setProducts(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setProducts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isBowling, hasShoes, centerCode]);

  // Once the catalog loads, reconcile the shoe charge with whatever sizes are
  // already chosen (back-nav can bring pre-picked sizes in before products).
  useEffect(() => {
    if (!isBowling || !hasShoes || products.length === 0) return;
    const bowling = item as BowlingItem;
    const patch = deriveShoePatch(
      rosterOf(item),
      bowling.experienceSlug,
      bowling.lineItems,
      products,
    );
    if (JSON.stringify(patch.shoeSelections) !== JSON.stringify(bowling.shoeSelections)) {
      onChange(patch as Partial<BowlItem>);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  // Main = the signed-in billing member's row, else the row whose name matches
  // the booking contact, else the first row.
  const mainIndex = useMemo(() => {
    if (!isBowling) return -1;
    const billing = session.party.find((m) => m.isBillingCustomer);
    if (billing) {
      const i = roster.findIndex((r) => r.memberId === billing.id);
      if (i >= 0) return i;
    }
    const cn = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim().toLowerCase();
    const i = roster.findIndex((r) => !!cn && r.name.trim().toLowerCase() === cn);
    return i >= 0 ? i : 0;
  }, [isBowling, session.party, roster, contact.firstName, contact.lastName]);

  const writePlayers = (next: RosterPlayer[]) => {
    if (isBowling && hasShoes && products.length > 0) {
      const bowling = item as BowlingItem;
      const shoePatch = deriveShoePatch(next, bowling.experienceSlug, bowling.lineItems, products);
      onChange({ players: next, ...shoePatch } as Partial<BowlItem>);
    } else {
      onChange({ players: next } as Partial<BowlItem>);
    }
  };

  const update = (index: number, patch: Partial<RosterPlayer>) => {
    const next = roster.map((p, i) => (i === index ? { ...p, ...patch } : p));
    writePlayers(next);
    // Editing the main walk-up bowler's name keeps session.contact in step.
    if (isBowling && patch.name !== undefined && index === mainIndex && !next[index].memberId) {
      dispatch({ type: "setContact", patch: splitName(next[index].name) });
    }
    // Collapse the card once complete and advance to the next unfinished bowler.
    if (playerComplete(next[index], hasShoes)) {
      const nextIncomplete = next.findIndex((p) => !playerComplete(p, hasShoes));
      setActiveEdit(nextIncomplete);
    } else {
      setActiveEdit(index);
    }
  };

  const setContactField = (patch: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  }) =>
    dispatch({
      type: "setContact",
      patch: patch.email !== undefined ? { ...patch, email: normalizeEmail(patch.email) } : patch,
    });

  const markMain = (index: number) => {
    const r = roster[index];
    if (r.memberId) {
      session.party.forEach((m) => {
        const shouldBe = m.id === r.memberId;
        if (!!m.isBillingCustomer !== shouldBe) {
          dispatch({ type: "updatePartyMember", id: m.id, patch: { isBillingCustomer: shouldBe } });
        }
      });
      const m = session.party.find((x) => x.id === r.memberId);
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
    } else {
      dispatch({ type: "setContact", patch: splitName(r.name) });
    }
  };

  const setFirst = (i: number, first: string) => {
    const { lastName } = splitName(roster[i].name);
    update(i, { name: `${first.trim()} ${lastName}`.trim() });
  };
  const setLast = (i: number, last: string) => {
    const { firstName } = splitName(roster[i].name);
    update(i, { name: `${firstName} ${last.trim()}`.trim() });
  };

  const readyCount = roster.filter((p) => playerComplete(p, hasShoes)).length;
  const contactNameMissing = !contact.firstName?.trim() || !contact.lastName?.trim();
  const contactFirst = contact.firstName?.trim() || (roster[mainIndex]?.name.split(" ")[0] ?? "");
  const rentals = shoeRentalCount(roster);
  const shoePriceCents = products[0]?.priceCents ?? 0;

  return (
    <div className="space-y-[24px]">
      <div className="flex items-center justify-between gap-[16px]">
        <p className="text-[26px] text-white/55">
          {hasShoes
            ? "Names, shoes and bumpers — plus who gets the confirmation."
            : "Names and bumpers — plus who gets the confirmation."}
        </p>
        <span className="k-eyebrow shrink-0 text-[#00e2e5] tabular-nums">
          {readyCount} of {roster.length} ready
        </span>
      </div>

      <div className="space-y-[20px]">
        {roster.map((p, i) => {
          const complete = playerComplete(p, hasShoes);
          const isMain = isBowling && i === mainIndex;

          // Collapsed summary — green bar, one line, tap to edit.
          if (complete && activeEdit !== i) {
            const meta = [
              hasShoes ? shoeSummary(p.shoeSize) : "",
              p.bumpers ? "Bumpers on" : "No bumpers",
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <button
                key={i}
                type="button"
                onClick={() => setActiveEdit(i)}
                className="k-glass k-tap flex w-full items-center gap-[24px] p-[26px] text-left"
                style={{ borderLeft: "10px solid #46d68c" }}
              >
                <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-full bg-[#46d68c] text-[30px] font-extrabold text-[#04252b]">
                  ✓
                </span>
                <span className="shrink-0 text-[34px] font-bold text-white">{p.name}</span>
                {isMain && (
                  <span className="shrink-0 text-[26px] font-bold text-[#00e2e5]">★ Main</span>
                )}
                <span className="min-w-0 flex-1 truncate text-[26px] text-white/55">{meta}</span>
                <span className="shrink-0 text-[24px] font-bold text-white/40">Edit</span>
              </button>
            );
          }

          return (
            <div
              key={i}
              className="k-glass p-[28px]"
              style={{ borderLeft: `8px solid ${complete ? "#46d68c" : "rgba(255,255,255,0.15)"}` }}
            >
              <div className="mb-[16px] flex items-center gap-[16px]">
                <span className="k-display text-[34px]">Bowler {i + 1}</span>
                <span className="flex-1" />
                {complete && <span className="k-eyebrow text-[#46d68c]">Ready</span>}
                {isBowling && (
                  <button
                    type="button"
                    onClick={() => markMain(i)}
                    aria-pressed={isMain}
                    className={`shrink-0 rounded-2xl border-2 px-[24px] py-[14px] text-[24px] font-bold ${
                      isMain
                        ? "border-[#00e2e5] bg-[#00e2e5]/10 text-white"
                        : "border-white/15 text-white/55"
                    }`}
                  >
                    {isMain ? "★ Main" : "Main"}
                  </button>
                )}
              </div>

              <span className="mb-[8px] block text-[22px] font-semibold uppercase tracking-widest text-white/40">
                Name
              </span>
              {p.memberId ? (
                <div className="mb-[20px] text-[34px] font-semibold text-white">
                  {p.name || `Bowler ${i + 1}`}
                </div>
              ) : (
                <div className="mb-[20px] grid grid-cols-2 gap-[16px]">
                  <input
                    type="text"
                    value={splitName(p.name).firstName}
                    onChange={(e) => setFirst(i, e.target.value)}
                    onBlur={(e) => setFirst(i, formatPersonName(e.target.value))}
                    placeholder="First name"
                    aria-label={`Bowler ${i + 1} first name`}
                    autoComplete="off"
                    className={inputCls}
                  />
                  <input
                    type="text"
                    value={splitName(p.name).lastName}
                    onChange={(e) => setLast(i, e.target.value)}
                    onBlur={(e) => setLast(i, formatPersonName(e.target.value))}
                    placeholder={isMain ? "Last name" : "Last name (optional)"}
                    aria-label={`Bowler ${i + 1} last name`}
                    autoComplete="off"
                    className={inputCls}
                  />
                </div>
              )}

              {hasShoes && (
                <span className="mb-[8px] block text-[22px] font-semibold uppercase tracking-widest text-white/40">
                  Shoe size
                </span>
              )}
              {hasShoes &&
                (() => {
                  const selCat = openCat[i] !== undefined ? openCat[i] : categoryOf(p.shoeSize);
                  return (
                    <>
                      <div className="mb-[12px] flex flex-wrap gap-[10px]">
                        <button
                          type="button"
                          onClick={() => {
                            setOpenCat((c) => ({ ...c, [i]: OWN_SHOES }));
                            update(i, { shoeSize: OWN_SHOES });
                          }}
                          className={`rounded-2xl border-2 px-[28px] py-[16px] text-[24px] font-semibold ${
                            p.shoeSize === OWN_SHOES
                              ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                              : "border-white/10 text-white/50"
                          }`}
                        >
                          Own shoes
                        </button>
                        {SHOE_CATEGORIES.map((cat) => (
                          <button
                            key={cat.value}
                            type="button"
                            onClick={() => {
                              setOpenCat((c) => ({ ...c, [i]: cat.value }));
                              if (categoryOf(p.shoeSize) !== cat.value)
                                update(i, { shoeSize: null });
                            }}
                            className={`rounded-2xl border-2 px-[28px] py-[16px] text-[24px] font-semibold ${
                              selCat === cat.value
                                ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                                : "border-white/10 text-white/50"
                            }`}
                          >
                            {cat.label}
                          </button>
                        ))}
                      </div>
                      {selCat && selCat !== OWN_SHOES && SHOE_SIZES[selCat] && (
                        <div className="mb-[20px] flex flex-wrap gap-[10px]">
                          {SHOE_SIZES[selCat].map((size) => {
                            const value = `${selCat} ${size}`;
                            return (
                              <button
                                key={size}
                                type="button"
                                onClick={() => update(i, { shoeSize: value })}
                                className={`min-w-[74px] rounded-2xl border-2 px-[18px] py-[16px] text-center text-[24px] font-semibold tabular-nums ${
                                  p.shoeSize === value
                                    ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                                    : "border-white/10 text-white/50"
                                }`}
                              >
                                {size}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </>
                  );
                })()}

              <div className="flex items-center gap-[20px]">
                <span className="text-[22px] font-semibold uppercase tracking-widest text-white/40">
                  Bumpers
                </span>
                <div className="inline-flex overflow-hidden rounded-2xl border-2 border-white/15">
                  {([true, false] as const).map((v) => (
                    <button
                      key={String(v)}
                      type="button"
                      onClick={() => update(i, { bumpers: v })}
                      className={`px-[36px] py-[14px] text-[26px] font-bold ${
                        p.bumpers === v ? "bg-[#00E2E5] text-[#04252b]" : "text-white/55"
                      }`}
                    >
                      {v ? "Yes" : "No"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Derived shoe rentals — paid pairs follow the sizes chosen. */}
      {isBowling && hasShoes && shoePriceCents > 0 && (
        <div
          className="k-glass flex items-center justify-between gap-[24px] p-[24px]"
          style={{ borderLeft: "10px solid #00e2e5" }}
        >
          <div>
            <div className="text-[22px] font-semibold uppercase tracking-widest text-white/40">
              Shoe rentals
            </div>
            <div className="text-[30px] text-white">
              {rentals} pair{rentals !== 1 ? "s" : ""}
              <span className="text-[26px] text-white/45"> · from sizes chosen</span>
            </div>
          </div>
          <div className="k-num text-[40px] font-extrabold text-white">
            ${((rentals * shoePriceCents) / 100).toFixed(2)}
          </div>
        </div>
      )}

      {/* Main contact — where the confirmation lands (bowling only). */}
      {isBowling && (
        <div className="k-glass space-y-[16px] p-[24px]">
          <div className="k-eyebrow text-white/40">
            Confirmation goes to {contactFirst || "the main person"}
          </div>
          {contactNameMissing && (
            <div className="grid grid-cols-2 gap-[16px]">
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
          <div className="grid grid-cols-2 gap-[16px]">
            <input
              type="email"
              inputMode="email"
              data-osk-layout="email"
              value={contact.email ?? ""}
              onChange={(e) => setContactField({ email: e.target.value })}
              placeholder="Email (for your confirmation)"
              aria-label="Main person email"
              className={inputCls}
            />
            <input
              type="tel"
              inputMode="tel"
              data-osk-layout="phone"
              value={contact.phone ?? ""}
              onChange={(e) => setContactField({ phone: e.target.value })}
              placeholder="Mobile phone"
              aria-label="Main person mobile phone"
              className={inputCls}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export const KioskBowlingDetailsStep: StepDef<BowlItem> = {
  id: "kiosk-bowling-details",
  title: "Who's bowling?",
  Component: KioskBowlingDetailsStepComponent,
  isVisible: () => true,
  canAdvance: (item, session) => {
    const hasShoes = centerHasShoeRental(item.qamfCenterId);
    const roster = rosterOf(item);
    if (roster.length === 0) return { reason: "Add at least one bowler first." };
    const incomplete = roster.findIndex((p) => !playerComplete(p, hasShoes));
    if (incomplete >= 0) {
      return {
        reason: hasShoes
          ? `Bowler ${incomplete + 1} still needs a name, shoe choice, and bumpers answer.`
          : `Bowler ${incomplete + 1} still needs a name and bumpers answer.`,
      };
    }
    // Bowling also requires the main contact (email/phone) before reserve; KBF
    // keeps its original name/shoe/bumpers-only gate.
    if (item.kind === "bowling") {
      return whosBowlingCanAdvance(item, session as Pick<BookingSession, "party" | "contact">);
    }
    return true;
  },
};

export { OWN_SHOES };
