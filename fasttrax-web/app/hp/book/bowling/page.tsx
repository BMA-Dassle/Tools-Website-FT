"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { trackBowlingStep } from "@/lib/analytics";
import { bookAttractionSlot } from "@/lib/attractions-data";
import { getBookingClientKey } from "@/lib/booking-location";
import { modalBackdropProps } from "@/lib/a11y";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Step = "location" | "players" | "date" | "lane-type" | "offer" | "food-beverage" | "extras" | "review" | "details";
type LaneType = "regular" | "vip" | "oldtime";

interface OpenDate {
  Date: string;
  IsOpen: boolean;
  StartBookingTime: string | null;
  EndBookingTime: string | null;
}

interface OfferItem {
  ItemId: number;
  Quantity: number;
  QuantityType: string;
  Time: string;
  Total: number;
  Remaining: number;
  Lanes: number;
  Reason?: string;
  Alternatives?: { DateTime: string; Time: string; Total: number; Remaining: number }[];
}

interface Offer {
  OfferId: number;
  Name: string;
  Description: string;
  ImageUrl: string;
  Tariffs: { Id: number; Name: string; Price: number; Duration: string }[];
  Items: OfferItem[];
}

interface ShoeOption { Name: string; Price: number; PriceKeyId: number; PlayerTypeId: number }
interface Extra { Id: number; Name: string; Price: number; ImageUrl: string; Description: string; ItemType: string }
interface CartSummary {
  TotalWithoutTaxes: number;
  TotalItems: number;
  TotalDiscountedItems: number;
  AddedTaxes: number;
  Fee: number;
  Total: number;
  Deposit: number;
  AutoGratuity: number;
  TipAmount: number;
  Discount: number;
  SavingAmount: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const API = "/api/qamf";
const LOCATIONS = [
  { id: "9172", name: "HeadPinz Fort Myers", address: "14513 Global Pkwy, Fort Myers", hasOldTime: true },
  { id: "3148", name: "HeadPinz Naples", address: "8525 Radio Ln, Naples", hasOldTime: false },
];

const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";
type LaneTypeInfo = { key: LaneType; label: string; desc: string; accent: string; fmOnly?: boolean; videos?: string[]; image?: string; details?: string[] };

function getLaneTypes(center: string): LaneTypeInfo[] {
  const isFM = center === "9172";
  return [
    {
      key: "regular" as LaneType,
      label: "Regular Lanes",
      desc: isFM
        ? "16 bowling lanes with music videos, large video screens, and a full bar steps away. Glow lighting Friday night through Sunday night."
        : "24 bowling lanes with regular lighting. Glow lighting after 9 PM Friday, 12 PM Saturday & Sunday.",
      accent: "#fd5b56",
      videos: [`${BLOB}/videos/headpinz-bowling.mp4`],
      details: isFM
        ? ["16 lanes", "Music videos & large screens", "Glow lighting Fri-Sun nights", "Up to 6 bowlers per lane", "Full bar & food service"]
        : ["24 lanes", "Regular lighting", "Glow after 9pm Fri / 12pm Sat-Sun", "Up to 6 bowlers per lane", "Full bar & food service"],
    },
    {
      key: "vip" as LaneType,
      label: "VIP Lanes",
      desc: "The ultimate bowling experience. Private VIP suite with NeoVerse interactive LED walls and HyperBowling LED target scoring.",
      accent: "#FFD700",
      videos: [`${BLOB}/videos/headpinz-neoverse-v2.mp4`, `${BLOB}/videos/headpinz-hyperbowling-v2.mp4`],
      details: [`${isFM ? "8" : "8"} VIP lanes`, "NeoVerse interactive video wall", "HyperBowling LED targets in bumpers", "Private lounge seating", "Complimentary Chips & Salsa"],
    },
    ...(isFM ? [{
      key: "oldtime" as LaneType,
      label: "Old Time Lanes",
      desc: "Pinboyz 1950s-themed bowling — vintage vibes, leather seating, classic Americana atmosphere.",
      accent: "#00E2E5",
      fmOnly: true,
      image: `${BLOB}/images/headpinz/oldtime-pinboyz.jpg`,
      details: ["1950s vintage theme", "4 classic lanes", "Leather lounge seating", "Fort Myers exclusive"],
    }] : []),
  ];
}

const coral = "#fd5b56";
const gold = "#FFD700";
const cyan = "#00E2E5";

/* BMI Add-on products per location */
const BMI_ADDONS_BY_CENTER: Record<string, { page: string; addons: typeof BMI_ADDONS_FM }> = {
  "9172": { page: "43370985", addons: [] }, // Fort Myers — filled below
  "3148": { page: "7583597", addons: [] },  // Naples — filled below
};

const BMI_ADDONS_FM = [
  {
    productId: "43370936",
    name: "Nexus Gel Blaster Arena",
    shortName: "Gel Blasters",
    desc: "High-tech blasters, glowing environments, and fast-paced team battles using eco-friendly Gellets.",
    price: 12,
    perPerson: true,
    qamfExtraId: 13751,
    image: `${BLOB}/images/addons/gelblaster-gtOdWfUsDWYEf72h2aBEytF5GCuZUs.jpg`,
    accent: "#39FF14",
    maxPerGroup: undefined as number | undefined,
  },
  {
    productId: "43370955",
    name: "Nexus Laser Tag Arena",
    shortName: "Laser Tag",
    desc: "Immersive team-based battles with advanced laser blasters and vests in a glowing arena.",
    price: 10,
    perPerson: true,
    qamfExtraId: 13678,
    image: `${BLOB}/images/addons/lasertag-uMlQDT8COLcGQVEfVyqgjgUOseIZjI.jpg`,
    accent: "#E41C1D",
    maxPerGroup: undefined as number | undefined,
  },
  {
    productId: "43370974",
    name: "Shuffly Shuffleboard",
    shortName: "Shuffly",
    desc: "Premium LED shuffleboard tables. Perfect for groups between bowling sessions.",
    price: 35,
    perPerson: false,
    qamfExtraId: 13991,
    maxPerGroup: 8,
    image: `${BLOB}/images/attractions/shuffly-tables-Nlc3Y5cuNU6C5WrFIhGvHN42pYMfVK.jpg`,
    accent: "#004AAD",
  },
];

const BMI_ADDONS_NAP = [
  {
    productId: "7565025",
    name: "Nexus Gel Blaster Arena",
    shortName: "Gel Blasters",
    desc: "High-tech blasters, glowing environments, and fast-paced team battles using eco-friendly Gellets.",
    price: 12,
    perPerson: true,
    qamfExtraId: 23093,
    image: `${BLOB}/images/addons/gelblaster-gtOdWfUsDWYEf72h2aBEytF5GCuZUs.jpg`,
    accent: "#39FF14",
    maxPerGroup: undefined as number | undefined,
  },
  {
    productId: "7565567",
    name: "Nexus Laser Tag Arena",
    shortName: "Laser Tag",
    desc: "Immersive team-based battles with advanced laser blasters and vests in a glowing arena.",
    price: 10,
    perPerson: true,
    qamfExtraId: 23091,
    image: `${BLOB}/images/addons/lasertag-uMlQDT8COLcGQVEfVyqgjgUOseIZjI.jpg`,
    accent: "#E41C1D",
    maxPerGroup: undefined as number | undefined,
  },
];

BMI_ADDONS_BY_CENTER["9172"].addons = BMI_ADDONS_FM;
BMI_ADDONS_BY_CENTER["3148"].addons = BMI_ADDONS_NAP;

// Legacy alias for backward compat
const BMI_ADDONS = BMI_ADDONS_FM;
const BMI_ADDONS_PAGE = "43370985";

interface BmiTimeSlot {
  start: string;
  stop: string;
  name: string;
  freeSpots: number;
  proposal: unknown;
  block: unknown;
}

interface BmiAddonSelection {
  productId: string;
  name: string;
  quantity: number;
  price: number;
  perPerson: boolean;
  selectedTime?: string;
  proposal?: unknown;
  block?: unknown;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

// Session token stored in sessionStorage so it survives re-renders and HMR
function getSessionToken(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("qamf_session_token") || "";
}
function setSessionToken(tok: string) {
  if (typeof window === "undefined") return;
  if (tok) sessionStorage.setItem("qamf_session_token", tok);
  else sessionStorage.removeItem("qamf_session_token");
}

/**
 * Renders one QAMF item's modifier groups. Groups are reordered so
 * radio/single-select (MaxQuantity=1) come first — that's usually the
 * "pick-one-included" choice — and multi-select "add extras" come last.
 * Radio groups render as larger pills with an active-check dot; multi-select
 * chips are tag-style with the per-item price suffix.
 */
function ModifierCard({
  title,
  subtitle,
  imageUrl,
  accent,
  modifiers,
  selections,
  onToggle,
}: {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  accent: string;
  modifiers: ItemModifiers;
  selections: Record<number, Set<number>>;
  onToggle: (group: ModifierGroup, modifierId: number) => void;
}) {
  // Radio-style (single-select) groups first; multi-select extras last.
  const sortedGroups = [...modifiers.ModifiersGroups].sort((a, b) => {
    const aSingle = a.Rules.MaxQuantity === 1 ? 0 : 1;
    const bSingle = b.Rules.MaxQuantity === 1 ? 0 : 1;
    return aSingle - bSingle;
  });

  return (
    <div className="rounded-xl overflow-hidden bg-white/[0.03] border border-white/10">
      {/* Header with thumbnail */}
      <div className="flex items-stretch gap-3 p-4 border-b border-white/8">
        {imageUrl && (
          <div className="shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-white/5">
            <img
              src={imageUrl}
              alt={title}
              className="w-full h-full object-cover"
              onError={(e) => {
                // QAMF occasionally returns 404 for missing images — hide the
                // thumbnail container so we don't leave a broken alt-text box.
                const wrapper = (e.currentTarget as HTMLImageElement).parentElement;
                if (wrapper) wrapper.style.display = "none";
              }}
            />
          </div>
        )}
        <div className="min-w-0 flex-1 flex flex-col justify-center">
          <h3 className="font-body text-white font-bold text-sm">{title}</h3>
          {subtitle && <p className="font-body text-white/50 text-xs mt-0.5">{subtitle}</p>}
        </div>
      </div>

      <div className="p-4 space-y-5">
        {sortedGroups.map((group) => {
          const single = group.Rules.MaxQuantity === 1;
          const chosen = selections[group.IdModifierGroup] || new Set<number>();
          return (
            <div key={group.IdModifierGroup}>
              <div className="flex items-baseline gap-2 mb-2">
                <p className="font-body text-white font-semibold text-xs uppercase tracking-wider">{group.Name}</p>
                <p className="font-body text-white/40 text-[11px] normal-case tracking-normal">
                  {single ? "(pick one)" : "(optional add-ons)"}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.Modifiers.map((m) => {
                  const isOn = chosen.has(m.IdOriginal);
                  return single
                    ? (
                      <button
                        key={m.IdOriginal}
                        onClick={() => onToggle(group, m.IdOriginal)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium font-body transition-colors cursor-pointer"
                        style={{
                          backgroundColor: isOn ? accent : "rgba(255,255,255,0.05)",
                          color: isOn ? "#0a1628" : "rgba(255,255,255,0.75)",
                          border: `1px solid ${isOn ? accent : "rgba(255,255,255,0.12)"}`,
                          fontWeight: isOn ? 700 : 500,
                        }}
                      >
                        <span
                          className="w-3 h-3 rounded-full border flex items-center justify-center shrink-0"
                          style={{
                            borderColor: isOn ? "#0a1628" : "rgba(255,255,255,0.3)",
                            backgroundColor: isOn ? "#0a1628" : "transparent",
                          }}
                        >
                          {isOn && <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accent }} />}
                        </span>
                        {m.Name}
                      </button>
                    )
                    : (
                      <button
                        key={m.IdOriginal}
                        onClick={() => onToggle(group, m.IdOriginal)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-body transition-colors cursor-pointer"
                        style={{
                          backgroundColor: isOn ? `${accent}25` : "rgba(255,255,255,0.04)",
                          color: isOn ? accent : "rgba(255,255,255,0.7)",
                          border: `1px solid ${isOn ? `${accent}60` : "rgba(255,255,255,0.1)"}`,
                          fontWeight: isOn ? 700 : 500,
                        }}
                      >
                        {isOn && <span className="text-[10px]">✓</span>}
                        <span>{m.Name}</span>
                        {m.Price > 0 && (
                          <span className="opacity-70 font-normal">+${m.Price.toFixed(2)}</span>
                        )}
                      </button>
                    );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

async function qamf(path: string, options?: RequestInit) {
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> || {}),
  };
  const token = getSessionToken();
  if (token) headers["x-sessiontoken"] = token;

  const res = await fetch(`${API}/${path}`, { ...options, headers });
  if (!res.ok) throw new Error(`QAMF ${res.status}`);

  // Capture session token from response
  const tok = res.headers.get("x-sessiontoken");
  if (tok) setSessionToken(tok);

  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

function stripHtml(html: string) { return html.replace(/<[^>]*>/g, "").trim(); }

/** For post-midnight slots (00:xx–05:xx), the actual calendar date is the next day */
function resolveDateTime(date: string, time: string): string {
  const hour = parseInt(time.split(":")[0], 10);
  if (hour < 6) {
    // Next calendar day
    const d = new Date(date + "T12:00:00"); // noon to avoid TZ issues
    d.setDate(d.getDate() + 1);
    const nextDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return `${nextDate}T${time}`;
  }
  return `${date}T${time}`;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

function isWithinOneHour(itemTime: string, selectedTime: string): boolean {
  return Math.abs(timeToMinutes(itemTime) - timeToMinutes(selectedTime)) <= 60;
}

/** Check if a "Day" offer should be hidden based on time + day of week */
function isDayOfferHidden(offerName: string, selTime: string, selDate: string): boolean {
  if (!offerName.toLowerCase().includes("day")) return false;
  const hour = timeToMinutes(selTime) / 60;
  if (hour < 18) return false; // Before 6 PM — show day offers
  // After 6 PM — hide day offers on weekdays (Mon-Fri)
  const [y, m, d] = selDate.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0=Sun, 6=Sat
  return dow >= 1 && dow <= 5; // Hide on weekdays after 6 PM
}

/** Filter offer items to only those within 1 hour of selected time */
function filterOfferItems(offer: Offer, selTime: string, selDate?: string): OfferItem[] {
  // Hide "Day" offers after 6 PM on weekdays
  if (selDate && isDayOfferHidden(offer.Name, selTime, selDate)) return [];

  return (offer.Items || []).filter(item => {
    // Item available at its listed time and within 1 hour
    if (!item.Reason && item.Remaining > 0 && isWithinOneHour(item.Time, selTime)) return true;
    // Item has alternatives within 1 hour
    if (item.Alternatives?.some(a => a.Remaining > 0 && isWithinOneHour(a.Time, selTime))) return true;
    return false;
  });
}

/** Check if any item in the offer requires a different time than selected */
function getOfferTimeShift(items: OfferItem[], selTime: string): string | null {
  for (const item of items) {
    if (!item.Reason && item.Remaining > 0 && item.Time === selTime) return null; // exact match
    if (!item.Reason && item.Remaining > 0 && item.Time !== selTime) return item.Time; // different time
    // Check alternatives
    if (item.Alternatives) {
      for (const alt of item.Alternatives) {
        if (alt.Remaining > 0 && alt.Time === selTime) return null;
        if (alt.Remaining > 0 && isWithinOneHour(alt.Time, selTime)) return alt.Time;
      }
    }
  }
  return null;
}

function isPerPerson(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("fun 4") || n.includes("fun4");
}

function formatDuration(qty: number, qtyType: string): string {
  if (qtyType === "Minutes") return `${qty} min`;
  if (qtyType === "Games") return `${qty} game${qty > 1 ? "s" : ""}`;
  return `${qty}`;
}

/** Find the VIP equivalent of a regular offer from the full offers list */
function findVipUpgrade(regularOffer: Offer, allOffers: Offer[], selectedTime: string): { offer: Offer; item: OfferItem; priceDiff: number } | null {
  if (classifyOffer(regularOffer.Name) !== "regular") return null;

  // Normalize name for matching: strip Regular/VIP, normalize "Open Bowling" = "Time Bowling"
  function normalizeOfferName(name: string): string {
    return name
      .replace(/[-–]\s*(Regular|VIP)/gi, "")
      .replace(/(Regular|VIP)/gi, "")
      .replace(/Open Bowling/i, "Time Bowling")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  const baseName = normalizeOfferName(regularOffer.Name);

  // Find VIP offer with matching normalized name
  for (const vipOffer of allOffers) {
    if (classifyOffer(vipOffer.Name) !== "vip") continue;
    const vipBase = normalizeOfferName(vipOffer.Name);
    if (baseName !== vipBase) continue;

    // Find a valid item within 1 hour
    const validItems = (vipOffer.Items || []).filter(i =>
      (!i.Reason && i.Remaining > 0 && isWithinOneHour(i.Time, selectedTime))
    );
    if (validItems.length === 0) continue;

    // Match by similar duration — find the item closest to the regular offer's first item
    const regItem = regularOffer.Items?.[0];
    const bestItem = validItems[0]; // simplest: take first available
    const priceDiff = bestItem.Total - (regItem?.Total || 0);

    if (priceDiff > 0) {
      return { offer: vipOffer, item: bestItem, priceDiff };
    }
  }
  return null;
}

function classifyOffer(name: string): LaneType {
  const n = name.toLowerCase();
  if (n.includes("old time") || n.includes("pinboyz")) return "oldtime";
  if (n.includes("vip")) return "vip";
  return "regular";
}

/** True when an offer is one of the Pizza Bowl packages (includes pizza + soda). */
function isPizzaBowl(name: string): boolean {
  return /pizza\s*bowl/i.test(name);
}

/* ------------------------------------------------------------------ */
/*  F&B (Food & Beverage) types — QAMF /offers/food-beverage +         */
/*  /Items/{id}/Modifiers. See docs/qamf-bowling-api.md.               */
/* ------------------------------------------------------------------ */

interface FbItem {
  Id: number;               // ⚠ QAMF returns this as `Id`, NOT `ItemId` (unlike the ItemId used in /Items/{id}/Modifiers paths)
  Name: string;
  Description?: string;
  Price?: number;
  ImageUrl?: string;
  CategoryId?: number;
  IsOutOfStock?: boolean;
  Type?: string;
}

interface Modifier {
  Name: string;
  IdOriginal: number;
  Price: number;
}

interface ModifierGroup {
  Name: string;
  IdModifierGroup: number;
  Rules: { MinQuantity: number; MaxQuantity: number | null };
  Modifiers: Modifier[];
}

interface ItemModifiers {
  Name: string;
  ModifiersGroups: ModifierGroup[];
}

/**
 * QAMF Pizza Bowl catalog per center. Fort Myers (9172) and Naples (3148) use
 * completely different category + item IDs for the same conceptual products,
 * so we key each into a map and pick by `centerId` at load time.
 *
 * Confirmed by HARs: Pizza Bowl.har (Fort Myers) and pizza bowl naples.har.
 */
interface PizzaBowlCatalog {
  pizzaBowlCategory: number;
  vipCompCategory: number | null;
  pizzaItemId: number;
  sodaItemId: number;
  chipsItemId: number | null;
}
const PIZZA_BOWL_CATALOG: Record<string, PizzaBowlCatalog> = {
  "9172": { // HeadPinz Fort Myers
    pizzaBowlCategory: 36,
    vipCompCategory: 3,
    pizzaItemId: 13036,
    sodaItemId: 13037,
    chipsItemId: 13186,
  },
  "3148": { // HeadPinz Naples
    pizzaBowlCategory: 24,
    vipCompCategory: 4,       // "Free Chips and Salsa" category at Naples
    pizzaItemId: 22168,
    sodaItemId: 22169,
    chipsItemId: 22280,       // VIP Chips & Salsa at Naples
  },
};
/** Fallback for any unknown center — defaults to FM's IDs so the flow at
 * least doesn't hard-crash; the modifier fetches will just return empty. */
const DEFAULT_CATALOG = PIZZA_BOWL_CATALOG["9172"];

function getAvailableTimes(offer: Offer): string[] {
  const times: string[] = [];
  for (const item of offer.Items || []) {
    if (!item.Reason && item.Remaining > 0) {
      times.push(item.Time);
    }
    for (const alt of item.Alternatives || []) {
      if (alt.Remaining > 0) times.push(alt.Time);
    }
  }
  return [...new Set(times)].sort();
}

function formatTimeStr(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Find the next available time for a lane type after the selected time */
function getNextAvailableTime(offers: Offer[], laneTypeKey: string, selTime: string, selDate?: string): string | null {
  const allTimes: string[] = [];
  for (const offer of offers) {
    if (classifyOffer(offer.Name) !== laneTypeKey) continue;
    if (selDate && isDayOfferHidden(offer.Name, selTime, selDate)) continue;
    for (const t of getAvailableTimes(offer)) {
      if (t > selTime) allTimes.push(t);
    }
  }
  allTimes.sort();
  return allTimes.length > 0 ? allTimes[0] : null;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function BowlingBookingPage() {
  const searchParams = useSearchParams();
  const [step, setStep] = useState<Step>("location");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Booking state
  const [centerId, setCenterId] = useState("");
  const [centerName, setCenterName] = useState("");
  const [hasOldTime, setHasOldTime] = useState(false);

  // Location-aware addons
  const currentAddons = BMI_ADDONS_BY_CENTER[centerId]?.addons || [];
  const currentAddonsPage = BMI_ADDONS_BY_CENTER[centerId]?.page || BMI_ADDONS_PAGE;
  const currentBmiClientKey = centerId === "3148" ? "headpinznaples" : undefined;

  // Auto-detect location from query param or referrer
  useEffect(() => {
    const locParam = searchParams.get("location");
    if (locParam === "naples") {
      const loc = LOCATIONS.find(l => l.id === "3148")!;
      setCenterId(loc.id);
      setCenterName(loc.name);
      setHasOldTime(loc.hasOldTime);
    } else {
      // Default to Fort Myers
      const loc = LOCATIONS.find(l => l.id === "9172")!;
      setCenterId(loc.id);
      setCenterName(loc.name);
      setHasOldTime(loc.hasOldTime);
    }
  }, [searchParams]);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedTime, setSelectedTime] = useState("");
  const [playerCount, setPlayerCount] = useState(2);
  const [laneType, setLaneType] = useState<LaneType>("regular");
  const [selectedOffer, setSelectedOffer] = useState<Offer | null>(null);
  const [selectedTariff, setSelectedTariff] = useState<{ Id: number; Name: string; Price: number; Duration: string } | null>(null);
  const [reservationKey, setReservationKey] = useState("");
  const [reservationCreatedAt, setReservationCreatedAt] = useState<number>(0);
  const [countdown, setCountdown] = useState("");

  // Calendar state
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [calYear, setCalYear] = useState(new Date().getFullYear());

  // API data
  const [openDates, setOpenDates] = useState<OpenDate[]>([]);
  const [allOffers, setAllOffers] = useState<Offer[]>([]);
  const [shoes, setShoes] = useState<ShoeOption[]>([]);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [cartSummary, setCartSummary] = useState<CartSummary | null>(null);

  // Extras selections
  const [wantShoes, setWantShoes] = useState(true);
  const [selectedExtras, setSelectedExtras] = useState<Map<number, number>>(new Map());

  // BMI add-on state (FM only)
  const [bmiAddonQty, setBmiAddonQty] = useState<Record<string, number>>({});
  const [bmiTimeSlots, setBmiTimeSlots] = useState<Record<string, BmiTimeSlot[]>>({});
  const [bmiSelectedTime, setBmiSelectedTime] = useState<Record<string, number>>({});
  const [bmiLoadingSlots, setBmiLoadingSlots] = useState<Record<string, boolean>>({});
  // BMI holds: single shared order, track lineId per addon for removal
  const bmiAddonOrderIdRef = useRef<string | null>(null);
  const bmiAddonLineIdsRef = useRef<Record<string, string>>({});
  const [bmiBookingAddon, setBmiBookingAddon] = useState(false);

  // F&B (Pizza Bowl included items) — pizza + soda pitcher per package, plus
  // complimentary VIP Chips & Salsa. `null` means not yet loaded; array means
  // loaded (possibly empty).
  const [fbLoading, setFbLoading] = useState(false);
  const [fbPizzaItem, setFbPizzaItem] = useState<{ item: FbItem; modifiers: ItemModifiers } | null>(null);
  const [fbSodaItem, setFbSodaItem] = useState<{ item: FbItem; modifiers: ItemModifiers } | null>(null);
  const [fbChipsItem, setFbChipsItem] = useState<FbItem | null>(null); // VIP complimentary — no modifier UI needed
  // Per-group selections: { [IdModifierGroup]: Set<IdOriginal> }
  // Per-lane selections. Index 0 = lane 1. Each entry is the same
  // { [modifierGroupId]: Set<modifierId> } shape. Scales with `includedLaneCount`
  // so a 2-lane Pizza Bowl booking can have Pizza 1: Pepperoni, Pizza 2: Cheese,
  // Soda 1: Pepsi, Soda 2: Dr. Pepper — independently customizable.
  const [fbPizzaSelections, setFbPizzaSelections] = useState<Array<Record<number, Set<number>>>>([{}]);
  const [fbSodaSelections, setFbSodaSelections] = useState<Array<Record<number, Set<number>>>>([{}]);
  // Number of included pizzas + soda pitchers in this package. One per lane.
  // Derived when the offer is picked — falls back to 1 when we can't infer lanes
  // from the offer data. Safe to bump this for manual testing.
  const [includedLaneCount, setIncludedLaneCount] = useState(1);

  // VIP upgrade modal
  const [showVipUpgrade, setShowVipUpgrade] = useState(false);
  const [vipUpgradeShown, setVipUpgradeShown] = useState(false);

  // Location confirm modal
  const [showLocationConfirm, setShowLocationConfirm] = useState(false);
  const [redirectingToPayment, setRedirectingToPayment] = useState(false);

  // Time change confirmation modal
  const [pendingOffer, setPendingOffer] = useState<{ offer: Offer; tariff: { Id: number; Name: string; Price: number; Duration: string }; newTime: string } | null>(null);
  const [pendingTimeSwitch, setPendingTimeSwitch] = useState<{ laneType: string; laneLabel: string; fromTime: string; toTime: string } | null>(null);

  // Guest details — prefill from previous booking or Rewards profile
  const [guestName, setGuestName] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      const saved = localStorage.getItem("hp_guest");
      if (saved) { const g = JSON.parse(saved); return g.name || ""; }
    } catch {}
    return "";
  });
  const [guestEmail, setGuestEmail] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      const saved = localStorage.getItem("hp_guest");
      if (saved) { const g = JSON.parse(saved); return g.email || ""; }
    } catch {}
    return "";
  });
  const [guestPhone, setGuestPhone] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      const saved = localStorage.getItem("hp_guest");
      if (saved) { const g = JSON.parse(saved); return g.phone || ""; }
    } catch {}
    return "";
  });

  // BMI add-on helpers
  function parseBmiLocal(iso: string): Date {
    const clean = iso.replace(/Z$/, "");
    const [datePart, timePart] = clean.split("T");
    if (!timePart) return new Date(clean);
    const [y, m, d] = datePart.split("-").map(Number);
    const [h, min, s] = timePart.split(":").map(Number);
    return new Date(y, m - 1, d, h, min, s || 0);
  }

  function conflictsWithBowling(slotStart: string, slotStop: string): boolean {
    if (!selectedTime || !selectedDate) return false;
    const bowlStart = new Date(`${resolveDateTime(selectedDate, selectedTime)}:00`).getTime();
    // Assume bowling is ~2 hours
    const bowlEnd = bowlStart + 2 * 60 * 60_000;
    const sStart = parseBmiLocal(slotStart).getTime();
    const sStop = parseBmiLocal(slotStop).getTime();
    const buffer = 15 * 60_000; // 15 min buffer
    return sStart < (bowlEnd + buffer) && sStop > (bowlStart - buffer);
  }

  /** Check if a time slot conflicts with any OTHER selected addon */
  function conflictsWithOtherAddon(slotStart: string, slotStop: string, currentProductId: string): boolean {
    const sStart = parseBmiLocal(slotStart).getTime();
    const sStop = parseBmiLocal(slotStop).getTime();
    for (const [pid, idx] of Object.entries(bmiSelectedTime)) {
      if (pid === currentProductId) continue;
      const slots = bmiTimeSlots[pid];
      if (!slots || idx === undefined) continue;
      const other = slots[idx];
      if (!other) continue;
      const oStart = parseBmiLocal(other.start).getTime();
      const oStop = parseBmiLocal(other.stop).getTime();
      if (sStart < oStop && sStop > oStart) return true;
    }
    return false;
  }

  function formatBmiTime(iso: string): string {
    const d = parseBmiLocal(iso);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  }

  async function fetchBmiTimeSlots(productId: string, qty: number) {
    setBmiLoadingSlots(prev => ({ ...prev, [productId]: true }));
    try {
      const dateOnly = selectedDate;
      const allSlots: BmiTimeSlot[] = [];
      const seen = new Set<string>();
      const searchHours = [11, 13, 15, 17, 19, 21];

      for (const hour of searchHours) {
        const h = String(hour).padStart(2, "0");
        const utcTime = `${dateOnly}T${h}:00:00.000Z`;
        try {
          const smsUrl = currentBmiClientKey
            ? `/api/sms?endpoint=dayplanner%2Fdayplanner&clientKey=${currentBmiClientKey}`
            : "/api/sms?endpoint=dayplanner%2Fdayplanner";
          const res = await fetch(smsUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              productId,
              pageId: currentAddonsPage,
              quantity: qty,
              dynamicLines: null,
              date: utcTime,
            }),
          });
          if (!res.ok) continue;
          const data = await res.json();
          for (const p of (data.proposals || [])) {
            const block = p.blocks?.[0]?.block;
            if (!block) continue;
            if (seen.has(block.start)) continue;
            seen.add(block.start);
            if (conflictsWithBowling(block.start, block.stop)) continue;
            allSlots.push({ start: block.start, stop: block.stop, name: block.name, freeSpots: block.freeSpots, proposal: p, block });
          }
        } catch { /* skip */ }
      }

      allSlots.sort((a, b) => a.start.localeCompare(b.start));
      setBmiTimeSlots(prev => ({ ...prev, [productId]: allSlots }));
      // Don't auto-select — user must pick a time (hold is created on click)
    } catch {
      setBmiTimeSlots(prev => ({ ...prev, [productId]: [] }));
    } finally {
      setBmiLoadingSlots(prev => ({ ...prev, [productId]: false }));
    }
  }

  /** Create a BMI hold when a time slot is selected for an addon.
   *  All addons share one BMI order (like the attraction booking flow). */
  async function holdAddonSlot(productId: string, slotIdx: number, slotsOverride?: BmiTimeSlot[]) {
    const slots = slotsOverride || bmiTimeSlots[productId];
    if (!slots || !slots[slotIdx]) return;
    const slot = slots[slotIdx];
    const qty = bmiAddonQty[productId] || 1;
    const ck = currentBmiClientKey;

    // console.log("[holdAddonSlot]", productId, slot.start, qty, bmiAddonOrderIdRef.current);
    setBmiBookingAddon(true);
    try {
      // If this addon already has a line on the bill, remove it first (time/qty change)
      const prevLineId = bmiAddonLineIdsRef.current[productId];
      if (prevLineId && bmiAddonOrderIdRef.current) {
        const rmCk = ck ? `&clientKey=${ck}` : "";
        await fetch(`/api/bmi?endpoint=booking%2FremoveItem${rmCk}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `{"OrderItemId":${prevLineId},"OrderId":${bmiAddonOrderIdRef.current}}`,
        }).catch(() => {});
        delete bmiAddonLineIdsRef.current[productId];
      }

      const { rawOrderId, billLineId } = await bookAttractionSlot(
        productId, qty, slot.proposal as import("@/lib/attractions-data").BmiProposal,
        bmiAddonOrderIdRef.current, null, ck
      );

      // console.log("[holdAddonSlot] ok", rawOrderId, billLineId);
      bmiAddonOrderIdRef.current = rawOrderId;
      if (billLineId) bmiAddonLineIdsRef.current[productId] = billLineId;
      setBmiSelectedTime(prev => ({ ...prev, [productId]: slotIdx }));
    } catch (err) {
      console.error("[holdAddonSlot] failed:", err);
    } finally {
      setBmiBookingAddon(false);
    }
  }

  /** Cancel the entire BMI addon order */
  function cancelAddonOrder() {
    if (!bmiAddonOrderIdRef.current) return;
    const ck = currentBmiClientKey;
    const ckParam = ck ? `&clientKey=${ck}` : "";
    fetch(`/api/bmi?endpoint=bill/${bmiAddonOrderIdRef.current}/cancel${ckParam}`, { method: "DELETE" }).catch(() => {});
    bmiAddonOrderIdRef.current = null;
  }

  function setBmiQty(productId: string, qty: number) {
    setBmiAddonQty(prev => ({ ...prev, [productId]: Math.max(0, qty) }));
    if (qty === 0) {
      // Remove this addon's line from the BMI order
      const lineId = bmiAddonLineIdsRef.current[productId];
      if (lineId && bmiAddonOrderIdRef.current) {
        const ck = currentBmiClientKey;
        const rmCk = ck ? `&clientKey=${ck}` : "";
        fetch(`/api/bmi?endpoint=booking%2FremoveItem${rmCk}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `{"OrderItemId":${lineId},"OrderId":${bmiAddonOrderIdRef.current}}`,
        }).catch(() => {});
        delete bmiAddonLineIdsRef.current[productId];
      }
      setBmiSelectedTime(prev => { const n = { ...prev }; delete n[productId]; return n; });
    }
    if (qty > 0 && !bmiTimeSlots[productId] && !bmiLoadingSlots[productId]) {
      fetchBmiTimeSlots(productId, qty);
    }
    if (qty === 0) {
      setBmiSelectedTime(prev => { const n = { ...prev }; delete n[productId]; return n; });
    }
  }

  function getBmiAddons(): BmiAddonSelection[] {
    return currentAddons.filter(a => (bmiAddonQty[a.productId] || 0) > 0).map(a => {
      const slots = bmiTimeSlots[a.productId] || [];
      const idx = bmiSelectedTime[a.productId];
      const slot = idx !== undefined ? slots[idx] : undefined;
      return {
        productId: a.productId,
        name: a.name,
        quantity: bmiAddonQty[a.productId],
        price: a.price,
        perPerson: a.perPerson,
        selectedTime: slot?.start,
        proposal: slot?.proposal,
        block: slot?.block,
      };
    });
  }

  // Countdown timer for reservation hold
  useEffect(() => {
    if (!reservationCreatedAt) { setCountdown(""); return; }
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - reservationCreatedAt) / 1000);
      const remaining = 10 * 60 - elapsed; // 10 min TTL
      if (remaining <= 0) {
        setCountdown("Expired");
        clearInterval(interval);
        return;
      }
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      setCountdown(`${m}:${String(s).padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [reservationCreatedAt]);

  // Clear reservation function
  function clearReservation() {
    if (keepAliveRef.current) clearInterval(keepAliveRef.current);
    setReservationKey("");
    setReservationCreatedAt(0);
    setSelectedOffer(null);
    setSelectedTariff(null);
    setShoes([]);
    setExtras([]);
    setSelectedExtras(new Map());
    setCartSummary(null);
    setSessionToken("");
    trackBowlingStep("Date & Time Selected", { date: selectedDate, time: selectedTime });
    setStep("lane-type");
    setError("");
  }

  // Refs
  const timePickerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  // Prevent the initial mount from scrolling — only scroll on real step transitions.
  const prevStepRef = useRef<Step>(step);

  // Auto-scroll the content area into view whenever the step changes. Skips
  // the very first render so loading the page doesn't force a scroll past
  // whatever the user was looking at (e.g. hero / nav). scroll-mt-[160px] on
  // the section accounts for the sticky nav + step-indicator + context bar.
  useEffect(() => {
    if (prevStepRef.current === step) return;
    prevStepRef.current = step;
    contentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [step]);

  // Food step: as each required radio group gets answered, advance the viewport
  // to the next un-answered card (pizza-0 → soda-0 → pizza-1 → soda-1 → Continue).
  // Gated on `!fbLoading` so the initial data load doesn't fire a scroll past
  // the step heading before the user has done anything. Tracks the "first
  // incomplete" card so we only scroll when it actually changes.
  const firstIncompleteRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // Reset tracker on every step transition so re-entry starts fresh.
    if (step !== "food-beverage") { firstIncompleteRef.current = undefined; return; }
    // Don't evaluate while data is still loading — the step-change scroll
    // (contentRef) has already anchored the view at the heading and we don't
    // want to scroll past it.
    if (fbLoading) return;

    // Compute the first incomplete required (radio) group in canonical order:
    // pizza-0, soda-0, pizza-1, soda-1, …
    let firstKey: string | null = null;
    for (let laneIdx = 0; laneIdx < includedLaneCount && firstKey === null; laneIdx++) {
      for (const type of ["pizza", "soda"] as const) {
        const item = type === "pizza" ? fbPizzaItem : fbSodaItem;
        const laneSels = type === "pizza" ? fbPizzaSelections[laneIdx] : fbSodaSelections[laneIdx];
        if (!item) continue;
        const requiredGroups = item.modifiers.ModifiersGroups.filter((g) => g.Rules.MaxQuantity === 1);
        const missing = requiredGroups.some((g) => !(laneSels?.[g.IdModifierGroup]?.size));
        if (missing) { firstKey = `${type}-${laneIdx}`; break; }
      }
    }

    // First settled evaluation on this step entry — seed the tracker without
    // scrolling, so the user's first pick is what triggers the auto-advance.
    if (firstIncompleteRef.current === undefined) {
      firstIncompleteRef.current = firstKey;
      return;
    }
    if (firstKey === firstIncompleteRef.current) return;
    firstIncompleteRef.current = firstKey;
    // Tiny delay so the just-pressed button's selected state renders before
    // we start scrolling.
    setTimeout(() => {
      if (firstKey) {
        document.querySelector(`[data-fb-card="${firstKey}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        document.querySelector(`[data-fb-continue]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 80);
  }, [step, fbLoading, includedLaneCount, fbPizzaItem, fbSodaItem, fbPizzaSelections, fbSodaSelections]);

  // Keep-alive
  const keepAliveRef = useRef<NodeJS.Timeout | null>(null);
  const startKeepAlive = useCallback((key: string, cid: string) => {
    if (keepAliveRef.current) clearInterval(keepAliveRef.current);
    keepAliveRef.current = setInterval(() => {
      qamf(`centers/${cid}/reservations/${key}/lifetime`, { method: "PATCH" }).catch(() => {});
    }, 120000);
  }, []);
  useEffect(() => () => { if (keepAliveRef.current) clearInterval(keepAliveRef.current); }, []);

  // Filtered offers by lane type
  const filteredOffers = allOffers.filter(o => classifyOffer(o.Name) === laneType);

  /* ── Step: Location ──────────────────────────────────────────── */

  async function selectLocation(loc: typeof LOCATIONS[0]) {
    setCenterId(loc.id);
    setCenterName(loc.name);
    setHasOldTime(loc.hasOldTime);
    trackBowlingStep("Location Selected", { location: loc.name });
    setStep("players");
  }

  async function fetchDatesAndGoToDate() {
    setLoading(true);
    setError("");
    try {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 90);
      const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`;
      const data = await qamf(`centers/${centerId}/opening-times/bookforlater/range?fromDate=${today}&toDate=${end}`);
      setOpenDates((data.Dates || []).filter((d: OpenDate) => d.IsOpen));
      trackBowlingStep("Party Set", { players: playerCount });
      setStep("date");
    } catch { setError("Failed to load dates"); }
    finally { setLoading(false); }
  }

  /* ── Step: Date + Time ───────────────────────────────────────── */

  const openDateSet = new Set(openDates.map(d => d.Date));

  function getOpenDate(dateStr: string): OpenDate | undefined {
    return openDates.find(d => d.Date === dateStr);
  }

  function selectDateAndTime(date: string, time: string) {
    setSelectedDate(date);
    setSelectedTime(time);
    setStep("players");
  }

  // Generate time slots for selected date (15-min increments)
  const selectedOpenDate = selectedDate ? getOpenDate(selectedDate) : null;
  const timeSlots: string[] = [];
  if (selectedOpenDate?.StartBookingTime && selectedOpenDate?.EndBookingTime) {
    const start = selectedOpenDate.StartBookingTime.split("T")[1];
    const end = selectedOpenDate.EndBookingTime.split("T")[1];
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    // Convert to minutes-since-start-of-day for easy comparison
    const startMin = sh * 60 + sm;
    let endMin = eh * 60 + em;
    // If end wraps past midnight (e.g. 01:00), add 24h so the loop continues past midnight
    if (endMin <= startMin) endMin += 24 * 60;
    for (let mins = startMin; mins <= endMin; mins += 15) {
      const h = Math.floor(mins / 60) % 24;
      const m = mins % 60;
      timeSlots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }

  // For same-day bookings, filter out times that are less than 15 min from now
  const todayStr = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; })();
  const isToday = selectedDate === todayStr;
  const filteredTimeSlots = isToday
    ? timeSlots.filter(t => {
        const now = new Date();
        const [h, m] = t.split(":").map(Number);
        // Post-midnight slots (00:xx, 01:xx) are tomorrow morning — always show them for tonight's date
        if (h < 6 && now.getHours() >= 12) return true;
        const slotDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
        return slotDate.getTime() > now.getTime() + 15 * 60000;
      })
    : timeSlots;

  // Calendar rendering
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const monthName = new Date(calYear, calMonth).toLocaleString("en-US", { month: "long", year: "numeric" });

  /* ── Step: Players → fetch offers ────────────────────────────── */

  async function fetchOffersAndGoToLaneType() {
    setLoading(true);
    setError("");
    try {
      const dt = resolveDateTime(selectedDate, selectedTime);
      const data = await qamf(
        `centers/${centerId}/offers-availability?systemId=${centerId}&datetime=${encodeURIComponent(dt)}&players=1-${playerCount}&page=1&itemsPerPage=50`
      );
      setAllOffers(Array.isArray(data) ? data : []);
      setStep("lane-type");
    } catch { setError("Failed to load packages"); }
    finally { setLoading(false); }
  }

  /* ── Step: Select offer → create reservation ─────────────────── */

  async function selectOffer(offer: Offer, tariff: { Id: number; Name: string; Price: number; Duration: string }, overrideTime?: string) {
    const useTime = overrideTime || selectedTime;
    if (overrideTime) setSelectedTime(overrideTime);
    setSelectedOffer(offer);
    setSelectedTariff(tariff);
    setLoading(true);
    setError("");
    try {
      const dt = resolveDateTime(selectedDate, useTime);
      const reservation = await qamf(`centers/${centerId}/reservations/temporary-request/book-for-later`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          DateFrom: dt,
          WebOfferId: offer.OfferId,
          WebOfferTariffId: tariff.Id,
          PlayersList: [{ TypeId: 1, Number: playerCount }],
        }),
      });
      setReservationKey(reservation.ReservationKey);
      setReservationCreatedAt(Date.now());
      startKeepAlive(reservation.ReservationKey, centerId);

      const dte = encodeURIComponent(dt);
      const [shoesData, extrasData] = await Promise.all([
        qamf(`centers/${centerId}/offers/${offer.OfferId}/shoes-socks-offer?systemId=${centerId}&datetime=${dte}`).catch(() => ({ Shoes: [] })),
        qamf(`centers/${centerId}/offers/extras?systemId=${centerId}&datetime=${dte}&offerId=${offer.OfferId}&page=1&itemsPerPage=50`).catch(() => []),
      ]);
      setShoes(shoesData.Shoes || []);
      setExtras(Array.isArray(extrasData) ? extrasData : []);
      trackBowlingStep("Package Selected", { offer: offer.Name, tariff: tariff.Name, price: tariff.Price, laneType });
      // Pizza Bowl packages route through the new F&B step so the guest can
      // pick pizza toppings + soda flavor. Other packages keep the old flow.
      if (isPizzaBowl(offer.Name)) {
        // Fire-and-forget: load included items + modifiers while the step renders.
        loadPizzaBowlIncludedItems(offer, dte);
        setStep("food-beverage");
      } else {
        setStep("extras");
      }
      // Show VIP upgrade modal if regular and not already shown
      if (classifyOffer(offer.Name) === "regular" && !vipUpgradeShown) {
        const upgrade = findVipUpgrade(offer, allOffers, useTime);
        if (upgrade) { setShowVipUpgrade(true); setVipUpgradeShown(true); }
      }
    } catch { setError("Failed to create reservation"); }
    finally { setLoading(false); }
  }

  /* ── Step: Load Pizza Bowl included items + modifiers ────────── */

  async function loadPizzaBowlIncludedItems(offer: Offer, encodedDateTime: string) {
    setFbLoading(true);
    setFbPizzaItem(null);
    setFbSodaItem(null);
    setFbChipsItem(null);
    const offerLanes = offer.Items?.[0]?.Lanes ?? 1;
    const laneCount = Math.max(1, offerLanes || 1);
    setIncludedLaneCount(laneCount);
    setFbPizzaSelections(Array.from({ length: laneCount }, () => ({})));
    setFbSodaSelections(Array.from({ length: laneCount }, () => ({})));
    const catalog = PIZZA_BOWL_CATALOG[centerId] || DEFAULT_CATALOG;
    try {
      const isVip = classifyOffer(offer.Name) === "vip";
      const categoryCalls: Promise<FbItem[]>[] = [
        qamf(`centers/${centerId}/offers/food-beverage?systemId=${centerId}&datetime=${encodedDateTime}&categoryId=${catalog.pizzaBowlCategory}&page=1&itemsPerPage=50`).catch(() => []),
      ];
      if (isVip && catalog.vipCompCategory !== null) {
        categoryCalls.push(qamf(`centers/${centerId}/offers/food-beverage?systemId=${centerId}&datetime=${encodedDateTime}&categoryId=${catalog.vipCompCategory}&page=1&itemsPerPage=50`).catch(() => []));
      }
      const [pizzaBowlItems, vipItems = []] = await Promise.all(categoryCalls);

      const pizzaItem = pizzaBowlItems.find((i) => i.Id === catalog.pizzaItemId);
      const sodaItem = pizzaBowlItems.find((i) => i.Id === catalog.sodaItemId);
      const chipsItem = catalog.chipsItemId !== null ? vipItems.find((i) => i.Id === catalog.chipsItemId) : undefined;
      if (chipsItem) setFbChipsItem(chipsItem);

      // Fetch modifier groups for each included item (no modifiers needed for chips & salsa).
      const [pizzaMods, sodaMods] = await Promise.all([
        pizzaItem ? qamf(`centers/${centerId}/Items/${pizzaItem.Id}/Modifiers`).catch(() => null) : Promise.resolve(null),
        sodaItem ? qamf(`centers/${centerId}/Items/${sodaItem.Id}/Modifiers`).catch(() => null) : Promise.resolve(null),
      ]);
      if (pizzaItem && pizzaMods) setFbPizzaItem({ item: pizzaItem, modifiers: pizzaMods });
      if (sodaItem && sodaMods) setFbSodaItem({ item: sodaItem, modifiers: sodaMods });
    } finally {
      setFbLoading(false);
    }
  }

  /** Toggle a modifier selection for a given lane + group. MaxQuantity=1 is radio-style. */
  function toggleModifier(
    setSelections: (fn: (prev: Array<Record<number, Set<number>>>) => Array<Record<number, Set<number>>>) => void,
    laneIdx: number,
    group: ModifierGroup,
    modifierId: number,
  ) {
    setSelections((prev) => {
      const next = [...prev];
      const laneSelections = { ...(next[laneIdx] || {}) };
      const existing = new Set(laneSelections[group.IdModifierGroup] || []);
      const max = group.Rules.MaxQuantity;
      if (existing.has(modifierId)) {
        existing.delete(modifierId);
      } else {
        if (max === 1) existing.clear();
        existing.add(modifierId);
      }
      laneSelections[group.IdModifierGroup] = existing;
      next[laneIdx] = laneSelections;
      return next;
    });
  }

  /**
   * Build the Modifiers[] payload for a given item + the up-charge total.
   * QAMF POST quirk: the `Items/{id}/Modifiers` GET returns `IdOriginal`, but
   * the CreateSummary POST expects the same field renamed to `OriginalId`.
   * The F&B line item's UnitPrice is the sum of non-zero modifier prices
   * (e.g. pizza with Pepperoni extra → UnitPrice: 2.00).
   */
  function buildItemModifiers(
    itemModifiers: ItemModifiers | undefined,
    selections: Record<number, Set<number>>,
  ): { modifiers: { OriginalId: number; Name: string }[]; upchargeTotal: number } {
    if (!itemModifiers) return { modifiers: [], upchargeTotal: 0 };
    const modifiers: { OriginalId: number; Name: string }[] = [];
    let upchargeTotal = 0;
    for (const group of itemModifiers.ModifiersGroups) {
      const chosen = selections[group.IdModifierGroup];
      if (!chosen) continue;
      for (const id of chosen) {
        const mod = group.Modifiers.find((m) => m.IdOriginal === id);
        if (!mod) continue;
        modifiers.push({ OriginalId: mod.IdOriginal, Name: mod.Name });
        upchargeTotal += mod.Price;
      }
    }
    return { modifiers, upchargeTotal };
  }

  /* ── Step: Review cart ───────────────────────────────────────── */

  async function goToReview() {
    setError("");

    // Validate: every add-on with qty > 0 must have a time slot selected.
    // Without this gate, the user could proceed with an unscheduled add-on
    // and end up at checkout with no slot held for it.
    const missing = currentAddons.filter((addon) => {
      const qty = bmiAddonQty[addon.productId] || 0;
      if (qty <= 0) return false;
      const slots = bmiTimeSlots[addon.productId] || [];
      if (slots.length === 0) return false; // will render "No times available" — user can't pick anyway
      return bmiSelectedTime[addon.productId] === undefined;
    });
    if (missing.length > 0) {
      const names = missing.map((a) => a.shortName || a.name).join(", ");
      setError(`Please choose a time for: ${names}`);
      // Scroll the first offending add-on into view if we can find it by id
      const first = missing[0];
      const el = typeof document !== "undefined"
        ? document.querySelector(`[data-addon-id="${first.productId}"]`)
        : null;
      if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
        (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }

    setLoading(true);
    try {
      const shoeItems = wantShoes && shoes.length > 0
        ? shoes.map(s => ({ PriceKeyId: s.PriceKeyId, Quantity: playerCount, UnitPrice: s.Price }))
        : [];
      const extraItems = Array.from(selectedExtras.entries())
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => {
          const ex = extras.find(e => e.Id === id);
          return { PriceKeyId: id, Quantity: qty, UnitPrice: ex?.Price || 0, Note: "" };
        });

      // Add BMI add-ons that have QAMF pricing IDs to the extras
      for (const addon of currentAddons) {
        const qty = bmiAddonQty[addon.productId] || 0;
        if (qty > 0 && addon.qamfExtraId) {
          extraItems.push({ PriceKeyId: addon.qamfExtraId, Quantity: qty, UnitPrice: addon.price, Note: "" });
        }
      }

      // Build FoodAndBeverage line items. Confirmed against the QAMF POST
      // body in the Pizza Bowl HAR — Modifiers use `OriginalId` (no Name/Qty)
      // and the line item's UnitPrice is the sum of chargeable modifier
      // prices (e.g. +$2 Pepperoni → UnitPrice: 2).
      const fbItems: { PriceKeyId: number; Quantity: number; UnitPrice: number; Note: string; Modifiers: { OriginalId: number }[] }[] = [];
      const offerIsVip = classifyOffer(selectedOffer!.Name) === "vip";
      const offerIsPizzaBowl = isPizzaBowl(selectedOffer!.Name);
      const catalog = PIZZA_BOWL_CATALOG[centerId] || DEFAULT_CATALOG;
      if (offerIsVip && catalog.chipsItemId !== null) {
        fbItems.push({ PriceKeyId: catalog.chipsItemId, Quantity: Math.ceil(playerCount / 6), UnitPrice: 0, Note: "", Modifiers: [] });
      }
      if (offerIsPizzaBowl) {
        for (let laneIdx = 0; laneIdx < includedLaneCount; laneIdx++) {
          if (fbPizzaItem) {
            const { modifiers, upchargeTotal } = buildItemModifiers(fbPizzaItem.modifiers, fbPizzaSelections[laneIdx] || {});
            fbItems.push({
              PriceKeyId: catalog.pizzaItemId,
              Quantity: 1,
              UnitPrice: upchargeTotal,
              Note: "",
              Modifiers: modifiers.map((m) => ({ OriginalId: m.OriginalId })),
            });
          }
          if (fbSodaItem) {
            const { modifiers, upchargeTotal } = buildItemModifiers(fbSodaItem.modifiers, fbSodaSelections[laneIdx] || {});
            fbItems.push({
              PriceKeyId: catalog.sodaItemId,
              Quantity: 1,
              UnitPrice: upchargeTotal,
              Note: "",
              Modifiers: modifiers.map((m) => ({ OriginalId: m.OriginalId })),
            });
          }
        }
      }

      const summary = await qamf(`centers/${centerId}/Cart/CreateSummary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Time: resolveDateTime(selectedDate, selectedTime),
          Items: {
            Extra: extraItems,
            FoodAndBeverage: fbItems,
            ShoesSocks: shoeItems,
            WebOffer: {
              Id: selectedOffer!.OfferId,
              UnitPrice: selectedTariff!.Price,
              WebOfferTariffId: selectedTariff!.Id,
            },
          },
          Players: [{ TypeId: 1, Number: playerCount }],
        }),
      });
      setCartSummary(summary);
      trackBowlingStep("Extras & Review", { total: summary.Total, addons: getBmiAddons().length });
      setStep("review");
    } catch { setError("Failed to calculate total"); }
    finally { setLoading(false); }
  }

  /* ── Step: Submit booking ────────────────────────────────────── */

  async function submitBooking() {
    if (!guestName || !guestEmail || !guestPhone) { setError("Please fill in all fields"); return; }
    setLoading(true);
    setError("");
    try {
      // Build cart items in QAMF format with Type + PriceKeyId
      const cartItems: { Name: string; Type: string; PriceKeyId: number; Quantity: number; UnitPrice: number; Modifiers?: { OriginalId: number; Name: string }[] }[] = [];

      // WebOffer (the bowling package)
      cartItems.push({
        Name: selectedOffer!.Name,
        Type: "WebOffer",
        PriceKeyId: selectedOffer!.OfferId,
        Quantity: 1,
        UnitPrice: selectedTariff!.Price,
      });

      // Shoes
      if (wantShoes && shoes.length > 0) {
        shoes.forEach(s => {
          cartItems.push({
            Name: s.Name || "Bowling Shoes",
            Type: "ShoesSocks",
            PriceKeyId: s.PriceKeyId,
            Quantity: playerCount,
            UnitPrice: s.Price,
          });
        });
      }

      // Extras
      selectedExtras.forEach((qty, id) => {
        if (qty > 0) {
          const ex = extras.find(e => e.Id === id);
          cartItems.push({
            Name: ex?.Name || "Extra",
            Type: "Extras",
            PriceKeyId: id,
            Quantity: qty,
            UnitPrice: ex?.Price || 0,
          });
        }
      });

      // Add BMI add-ons with QAMF pricing to the cart
      currentAddons.forEach(addon => {
        const qty = bmiAddonQty[addon.productId] || 0;
        if (qty > 0 && addon.qamfExtraId) {
          cartItems.push({
            Name: addon.name,
            Type: "Extras",
            PriceKeyId: addon.qamfExtraId,
            Quantity: qty,
            UnitPrice: addon.price,
          });
        }
      });

      const submitCatalog = PIZZA_BOWL_CATALOG[centerId] || DEFAULT_CATALOG;

      // Add free chips & salsa for VIP packages (center-specific item ID)
      if (classifyOffer(selectedOffer!.Name) === "vip" && submitCatalog.chipsItemId !== null) {
        cartItems.push({
          Name: "VIP Chips & Salsa",
          Type: "FoodBeverage",
          PriceKeyId: submitCatalog.chipsItemId,
          Quantity: playerCount,
          UnitPrice: 0,
        });
      }

      // Pizza Bowl included items (pizza + soda pitcher) with chosen modifiers.
      // Confirmed via HAR: guest/confirm expects Modifiers[].{OriginalId,Name}
      // (the Name is used on receipts / confirmation emails). Emit one line
      // per lane so each lane's picks are recorded independently.
      if (isPizzaBowl(selectedOffer!.Name)) {
        for (let laneIdx = 0; laneIdx < includedLaneCount; laneIdx++) {
          const laneLabel = includedLaneCount > 1 ? ` — Lane ${laneIdx + 1}` : "";
          if (fbPizzaItem) {
            const { modifiers, upchargeTotal } = buildItemModifiers(fbPizzaItem.modifiers, fbPizzaSelections[laneIdx] || {});
            cartItems.push({
              Name: `${fbPizzaItem.item.Name}${laneLabel}`,
              Type: "FoodBeverage",
              PriceKeyId: submitCatalog.pizzaItemId,
              Quantity: 1,
              UnitPrice: upchargeTotal,
              Modifiers: modifiers,
            });
          }
          if (fbSodaItem) {
            const { modifiers, upchargeTotal } = buildItemModifiers(fbSodaItem.modifiers, fbSodaSelections[laneIdx] || {});
            cartItems.push({
              Name: `${fbSodaItem.item.Name}${laneLabel}`,
              Type: "FoodBeverage",
              PriceKeyId: submitCatalog.sodaItemId,
              Quantity: 1,
              UnitPrice: upchargeTotal,
              Modifiers: modifiers,
            });
          }
        }
      }

      const returnUrl = `${window.location.origin}/hp/book/bowling/confirmation?key=${reservationKey}&center=${centerId}`;

      const result = await qamf(`centers/${centerId}/reservations/${reservationKey}/guest/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          GuestDetails: {
            Email: guestEmail,
            PhoneNumber: guestPhone.replace(/\D/g, ""),
            ReferentName: guestName,
          },
          Cart: {
            ReturnUrl: returnUrl,
            Items: cartItems,
            Summary: cartSummary ? {
              AddedTaxes: cartSummary.AddedTaxes,
              Deposit: cartSummary.Deposit,
              Fee: cartSummary.Fee,
              Total: cartSummary.Total,
              TotalItems: cartSummary.TotalItems,
              AutoGratuity: cartSummary.AutoGratuity,
              TotalWithoutTaxes: cartSummary.TotalWithoutTaxes,
            } : undefined,
          },
        }),
      });

      if (result.NeedPayment && result.ApprovePayment?.Url) {
        // Remember guest info for next booking
        try { localStorage.setItem("hp_guest", JSON.stringify({ name: guestName, email: guestEmail, phone: guestPhone })); } catch {}
        sessionStorage.setItem("qamf_reservation", JSON.stringify({
          key: reservationKey, centerId, centerName, operationId: result.OperationId,
          offer: selectedOffer?.Name, date: selectedDate, time: selectedTime, players: playerCount,
          tariffPrice: selectedTariff?.Price,
          shoes: wantShoes && shoes.length > 0,
          shoePrice: shoes[0]?.Price || 0,
          addons: getBmiAddons().map(a => ({ name: a.name, qty: a.quantity, price: a.price, time: a.selectedTime })),
          guestName, guestEmail,
        }));
        // Store BMI add-ons for post-payment booking
        const bmiAddons = getBmiAddons();
        if (bmiAddons.length > 0) {
          sessionStorage.setItem("qamf_bmi_addons", JSON.stringify({
            addons: bmiAddons,
            guest: { name: guestName, email: guestEmail, phone: guestPhone.replace(/\D/g, "") },
            bmiOrderId: bmiAddonOrderIdRef.current,
          }));
        } else {
          sessionStorage.removeItem("qamf_bmi_addons");
        }

        // Show full-screen loading while we prep payment
        trackBowlingStep("Payment Started", { total: cartSummary?.Total || 0, location: centerName });
        setRedirectingToPayment(true);
        let paymentUrl = result.ApprovePayment.Url;
        try {
          const nameParts = guestName.trim().split(/\s+/);
          const firstName = nameParts[0] || "";
          const lastName = nameParts.slice(1).join(" ") || "";
          const updateRes = await fetch("/api/square/update-redirect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              squareUrl: paymentUrl,
              billId: reservationKey,
              buyerOnly: true,
              buyer: { email: guestEmail, phone: guestPhone, firstName, lastName },
            }),
          });
          if (updateRes.ok) {
            const updated = await updateRes.json();
            if (updated.url) paymentUrl = updated.url;
          }
        } catch {
          // If prefill fails, still redirect to original URL
        }
        window.location.href = paymentUrl;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("409")) {
        setError("Your reservation expired. Please go back and select your package again.");
      } else {
        setError("Failed to submit booking. Please try again.");
      }
    }
    finally { setLoading(false); }
  }

  /* ── Navigation ──────────────────────────────────────────────── */

  // Conditionally insert the F&B step only for Pizza Bowl offers; non-Pizza
  // Bowl packages keep the existing flow and don't show F&B on the indicator.
  const allSteps: Step[] = (() => {
    const base: Step[] = ["location", "players", "date", "lane-type", "offer"];
    if (selectedOffer && isPizzaBowl(selectedOffer.Name)) base.push("food-beverage");
    base.push("extras", "review", "details");
    return base;
  })();
  // Label index must match allSteps order. For Pizza Bowl we splice in "Food"
  // at position 5 (between Package and Extras).
  const stepLabels = (() => {
    const base = ["Location", "Party", "Date", "Type", "Package"];
    if (selectedOffer && isPizzaBowl(selectedOffer.Name)) base.push("Food");
    base.push("Extras", "Review", "Pay");
    return base;
  })();
  const stepIndex = allSteps.indexOf(step);

  function goBack() {
    if (stepIndex > 0) { setStep(allSteps[stepIndex - 1]); setError(""); }
  }

  function toggleExtra(id: number) {
    const next = new Map(selectedExtras);
    next.has(id) && next.get(id)! > 0 ? next.delete(id) : next.set(id, 1);
    setSelectedExtras(next);
  }

  /* ── Render ──────────────────────────────────────────────────── */

  return (
    <div className="min-h-screen bg-[#0a1628]">
      {/* Spacer for fixed nav */}
      <div className="pt-28 sm:pt-32" />

      {/* Sticky step nav (mirrors racing style) */}
      <div className="sticky top-[72px] sm:top-[80px] z-30">
        <div className="border-b border-white/8 bg-[#0a1628]">
          <div className="max-w-4xl mx-auto px-3 py-2.5 relative">
            <div className="flex items-center justify-center gap-0 flex-nowrap">
              {allSteps.map((s, i) => {
                const isPast = i < stepIndex;
                const isCurrent = i === stepIndex;
                const isFuture = i > stepIndex;
                return (
                  <div key={s} className="flex items-center min-w-0">
                    <button
                      onClick={() => isPast && setStep(s)}
                      disabled={isFuture || isCurrent}
                      type="button"
                      className={`flex items-center gap-1 px-1 py-0.5 rounded text-[11px] font-body font-bold transition-all whitespace-nowrap ${
                        isCurrent ? "" :
                        isPast ? "text-white/60 hover:text-white/90 cursor-pointer" :
                        "text-white/25 cursor-not-allowed"
                      }`}
                      style={{ color: isCurrent ? coral : undefined }}
                    >
                      <span
                        className="w-4 h-4 rounded-full text-[10px] flex items-center justify-center font-bold shrink-0"
                        style={{
                          backgroundColor: isCurrent ? coral : isPast ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.08)",
                          color: isCurrent ? "#fff" : isPast ? "#fff" : "rgba(255,255,255,0.3)",
                        }}
                      >
                        {isPast ? "\u2713" : i + 1}
                      </span>
                      <span className="hidden md:inline">{stepLabels[i]}</span>
                    </button>
                    {i < allSteps.length - 1 && <span className="text-white/15 px-0.5 text-xs shrink-0">&rsaquo;</span>}
                  </div>
                );
              })}
            </div>

            {/* Lane held indicator — absolute so it doesn't throw off centering */}
            {reservationKey && countdown && (
              <span
                className="hidden sm:inline-flex items-center gap-1 font-body text-[10px] px-2 py-0.5 rounded-full shrink-0 absolute right-3 top-1/2 -translate-y-1/2"
                style={{
                  backgroundColor: countdown === "Expired" ? "rgba(253,91,86,0.15)" : "rgba(255,215,0,0.1)",
                  color: countdown === "Expired" ? coral : gold,
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: countdown === "Expired" ? coral : gold, animation: countdown !== "Expired" ? "pulse 2s infinite" : "none" }} />
                {countdown === "Expired" ? "Expired" : countdown}
                <button onClick={clearReservation} className="ml-0.5 text-white/40 hover:text-white cursor-pointer">&times;</button>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Booking context bar — always visible once location is selected.
          Mobile: location on its own line, date/time/bowlers on a second line
          so the player count doesn't orphan-wrap. Desktop: all inline. */}
      {centerName && step !== "location" && (
        <div className="bg-[#071027] border-b border-white/5">
          <div className="max-w-4xl mx-auto px-4 py-2 flex flex-col sm:flex-row sm:items-center sm:justify-center gap-y-1 sm:gap-x-3 text-center">
            <span className="inline-flex items-center justify-center gap-1.5 font-body text-xs text-white/60">
              <svg className="w-3.5 h-3.5 text-[#fd5b56]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              {centerName}
            </span>

            {(selectedDate || selectedTime || (playerCount > 0 && selectedDate)) && (
              <span className="hidden sm:inline text-white/20">|</span>
            )}

            {/* Second-line group on mobile; inline on desktop */}
            <div className="flex items-center justify-center gap-2 sm:gap-3 flex-wrap">
              {selectedDate && (
                <span className="inline-flex items-center gap-1.5 font-body text-xs text-white/60">
                  <svg className="w-3.5 h-3.5 text-[#00E2E5]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  {new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                </span>
              )}
              {selectedTime && selectedDate && <span className="text-white/20">|</span>}
              {selectedTime && (
                <span className="inline-flex items-center gap-1.5 font-body text-xs text-white/60">
                  <svg className="w-3.5 h-3.5 text-[#FFD700]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  {formatTimeStr(selectedTime)}
                </span>
              )}
              {playerCount > 0 && selectedDate && (selectedDate || selectedTime) && <span className="text-white/20">|</span>}
              {playerCount > 0 && selectedDate && (
                <span className="inline-flex items-center gap-1.5 font-body text-xs text-white/60">
                  <svg className="w-3.5 h-3.5 text-white/40" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                  {playerCount} bowler{playerCount !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="max-w-lg mx-auto px-4 mb-4">
          <div className="bg-[#fd5b56]/10 border border-[#fd5b56]/30 rounded-lg px-4 py-3 text-center">
            <p className="font-body text-[#fd5b56] text-sm">{error}</p>
          </div>
        </div>
      )}

      {loading && (
        <div className="text-center py-12">
          <div className="inline-block w-8 h-8 border-2 border-white/20 border-t-[#fd5b56] rounded-full animate-spin" />
        </div>
      )}

      <section ref={contentRef} className="max-w-5xl mx-auto px-4 py-8 pb-24 scroll-mt-[180px] sm:scroll-mt-[160px]">

        {/* ── LOCATION CONFIRM ── */}
        {step === "location" && !loading && centerId && (() => {
          const eventsHref = centerId === "9172"
            ? "/fort-myers/group-events"
            : "/naples/group-events";
          return (
          <div className="text-center max-w-lg mx-auto">
            <div className="rounded-lg p-6 mb-6" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${gold}30` }}>
              <p className="font-body text-white/50 text-xs uppercase tracking-wider mb-2">You&apos;re booking at</p>
              <h3 className="font-heading uppercase text-white text-xl tracking-wider" style={{ textShadow: `0 0 20px ${gold}25` }}>
                {centerName}
              </h3>
              <p className="font-body text-white/40 text-sm mt-1">
                {LOCATIONS.find(l => l.id === centerId)?.address}
              </p>
            </div>

            {/* Two-path landing: self-serve lane booking vs. planner-led group event */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <button
                onClick={() => setShowLocationConfirm(true)}
                className="py-4 px-4 rounded-2xl font-body font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02] text-center flex flex-col items-center gap-1"
                style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}
              >
                <span className="text-base leading-tight">Book a lane</span>
                <span className="font-normal text-[11px] tracking-wide opacity-80 normal-case">Up to 6 per lane · book online now</span>
              </button>
              <Link
                href={eventsHref}
                className="py-4 px-4 rounded-2xl font-body font-bold text-sm uppercase tracking-wider cursor-pointer transition-all hover:scale-[1.02] text-center flex flex-col items-center gap-1 no-underline"
                style={{ backgroundColor: "rgba(255,215,0,0.12)", border: `1.78px solid ${gold}50`, color: gold }}
              >
                <span className="text-base leading-tight">Plan a group event</span>
                <span className="font-normal text-[11px] tracking-wide opacity-90 normal-case" style={{ color: "rgba(255,215,0,0.8)" }}>Groups of 20+ · planner handles everything</span>
              </Link>
            </div>

            {/* Group-event promo copy — one line, kept short */}
            <p className="font-body text-white/55 text-sm leading-relaxed mb-5 max-w-md mx-auto">
              Looking for the ultimate VIP experience? Our event planners handle the whole thing — bowling, food, drinks, arcade, laser tag — so you can focus on the fun. Perfect for parties of 20 or more.
            </p>

            <button
              onClick={() => {
                const other = LOCATIONS.find(l => l.id !== centerId)!;
                setCenterId(other.id); setCenterName(other.name); setHasOldTime(other.hasOldTime);
              }}
              className="font-body text-white/40 text-xs cursor-pointer hover:text-white/60 transition-colors"
            >
              Switch to {LOCATIONS.find(l => l.id !== centerId)?.name}
            </button>
          </div>
          );
        })()}

        {/* ── DATE + TIME ── */}
        {step === "date" && !loading && (() => {
          const hours = [...new Set(filteredTimeSlots.map(t => t.split(":")[0]))];
          const selectedHour = selectedTime ? selectedTime.split(":")[0] : "";
          const minutesForHour = selectedHour ? filteredTimeSlots.filter(t => t.startsWith(selectedHour + ":")) : [];
          return (
            <div>
              <h2 className="font-heading uppercase text-white text-lg tracking-wider mb-4 text-center">When do you want to bowl?</h2>

              <div className="max-w-3xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Left: Calendar */}
                <div>
                  <p className="font-body text-white/30 text-xs uppercase tracking-widest mb-3 text-center">Date</p>
                  <div className="flex items-center justify-between mb-3">
                    <button onClick={() => { if (calMonth === 0) { setCalMonth(11); setCalYear(calYear - 1); } else setCalMonth(calMonth - 1); }}
                      className="text-white/50 hover:text-white p-2 cursor-pointer">&larr;</button>
                    <span className="font-body text-white font-bold text-sm">{monthName}</span>
                    <button onClick={() => { if (calMonth === 11) { setCalMonth(0); setCalYear(calYear + 1); } else setCalMonth(calMonth + 1); }}
                      className="text-white/50 hover:text-white p-2 cursor-pointer">&rarr;</button>
                  </div>
                  <div className="grid grid-cols-7 mb-1">
                    {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(d => (
                      <div key={d} className="text-center text-[13px] text-white/30 py-1">{d}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                    {Array.from({ length: firstDay }).map((_, i) => <div key={`pad-${i}`} />)}
                    {Array.from({ length: daysInMonth }).map((_, i) => {
                      const day = i + 1;
                      const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                      const isOpen = openDateSet.has(dateStr);
                      const isSelected = dateStr === selectedDate;
                      const today = new Date();
                      const tStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
                      const isPast = dateStr < tStr;
                      return (
                        <button
                          key={day}
                          disabled={!isOpen || isPast}
                          onClick={() => { setSelectedDate(dateStr); setSelectedTime(""); setTimeout(() => timePickerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                          className={`aspect-square rounded-lg text-sm font-medium transition-all duration-150 ${
                            isSelected
                              ? "bg-[#00E2E5] text-[#000418] font-bold shadow-lg shadow-[#00E2E5]/30"
                              : isOpen && !isPast
                                ? "bg-[#00E2E5]/15 text-[#00E2E5] hover:bg-[#00E2E5]/30 cursor-pointer"
                                : "text-white/20 cursor-not-allowed"
                          }`}
                        >
                          {day}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Right: Time picker */}
                <div ref={timePickerRef}>
                  {!selectedDate ? (
                    <div className="flex items-center justify-center h-full">
                      <p className="font-body text-white/30 text-sm">Select a date first</p>
                    </div>
                  ) : filteredTimeSlots.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <p className="font-body text-white/40 text-sm text-center">
                        {isToday ? "No more times available today. Try tomorrow." : "No times available for this date."}
                      </p>
                    </div>
                  ) : (
                    <>
                      <p className="font-body text-white/30 text-xs uppercase tracking-widest mb-3 text-center">Hour</p>
                      <div className="flex flex-wrap justify-center gap-2 mb-4">
                        {hours.map(h => {
                          const hr = parseInt(h, 10);
                          const ampm = hr >= 12 ? "PM" : "AM";
                          const display = `${hr % 12 || 12} ${ampm}`;
                          const isActive = h === selectedHour;
                          return (
                            <button
                              key={h}
                              onClick={() => {
                                const firstSlot = filteredTimeSlots.find(t => t.startsWith(h + ":"));
                                if (firstSlot) setSelectedTime(firstSlot);
                              }}
                              className="rounded-lg px-4 py-2.5 text-sm font-body font-bold transition-all cursor-pointer"
                              style={{
                                backgroundColor: isActive ? gold : "rgba(7,16,39,0.5)",
                                color: isActive ? "#0a1628" : "rgba(255,255,255,0.6)",
                                border: isActive ? `2px solid ${gold}` : "1px solid rgba(255,255,255,0.1)",
                              }}
                            >
                              {display}
                            </button>
                          );
                        })}
                      </div>

                      {selectedHour && minutesForHour.length > 1 && (
                        <>
                          <p className="font-body text-white/30 text-xs uppercase tracking-widest mb-2 text-center">Minutes</p>
                          <div className="flex justify-center gap-2 mb-4">
                            {minutesForHour.map(t => {
                              const min = t.split(":")[1];
                              const isActive = t === selectedTime;
                              return (
                                <button
                                  key={t}
                                  onClick={() => setSelectedTime(t)}
                                  className="rounded-lg px-5 py-2.5 text-sm font-body font-bold transition-all cursor-pointer"
                                  style={{
                                    backgroundColor: isActive ? cyan : "rgba(7,16,39,0.5)",
                                    color: isActive ? "#0a1628" : "rgba(255,255,255,0.6)",
                                    border: isActive ? `2px solid ${cyan}` : "1px solid rgba(255,255,255,0.1)",
                                  }}
                                >
                                  :{min}
                                </button>
                              );
                            })}
                          </div>
                        </>
                      )}

                      {selectedTime && (
                        <p className="font-heading text-center text-2xl mt-2" style={{ color: gold }}>
                          {formatTimeStr(selectedTime)}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Continue button */}
              {selectedTime && (
                <div className="max-w-md mx-auto mt-6">
                  <button
                    onClick={fetchOffersAndGoToLaneType}
                    className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
                    style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}
                  >
                    See Available Packages
                  </button>
                </div>
              )}

              <button onClick={goBack} className="mt-4 font-body text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
            </div>
          );
        })()}

        {/* ── PLAYERS ── */}
        {step === "players" && !loading && (
          <div className="text-center">
            <h2 className="font-heading uppercase text-white text-lg tracking-wider mb-2">How Many Bowlers?</h2>
            <p className="font-body text-white/40 text-sm mb-6">Up to 6 per lane</p>
            <div className="flex items-center justify-center gap-6 mb-8">
              <button onClick={() => setPlayerCount(Math.max(1, playerCount - 1))}
                className="w-14 h-14 rounded-full flex items-center justify-center text-2xl text-white cursor-pointer transition-all hover:scale-105"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}30` }}>-</button>
              <span className="font-heading text-white text-5xl" style={{ color: gold }}>{playerCount}</span>
              <button onClick={() => setPlayerCount(Math.min(24, playerCount + 1))}
                className="w-14 h-14 rounded-full flex items-center justify-center text-2xl text-white cursor-pointer transition-all hover:scale-105"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}30` }}>+</button>
            </div>
            <button onClick={fetchDatesAndGoToDate}
              className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}>Continue</button>
            <button onClick={goBack} className="mt-4 font-body text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}

        {/* ── LANE TYPE ── */}
        {step === "lane-type" && !loading && (
          <div>
            <h2 className="font-heading uppercase text-white text-lg tracking-wider mb-4 text-center">Choose Your Experience</h2>
            <div className="space-y-4">
              {getLaneTypes(centerId).map(lt => {
                const count = allOffers.filter(o => classifyOffer(o.Name) === lt.key && filterOfferItems(o, selectedTime, selectedDate).length > 0).length;
                const nextTime = count === 0 ? getNextAvailableTime(allOffers, lt.key, selectedTime, selectedDate) : null;
                const isSoldOut = count === 0 && !nextTime;
                return (
                  <div
                    key={lt.key}
                    className={`w-full rounded-lg overflow-hidden text-left transition-all ${isSoldOut ? "opacity-50" : "hover:scale-[1.01]"}`}
                    style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${isSoldOut ? "rgba(253,91,86,0.3)" : lt.accent + "35"}` }}
                  >
                    <div className="flex flex-col sm:flex-row">
                      {/* Video/image side */}
                      {(lt.videos || lt.image) && (
                        <div className="relative w-full sm:w-56 h-36 sm:h-auto shrink-0 overflow-hidden">
                          {lt.videos && lt.videos.length > 0 ? (
                            <video autoPlay muted loop playsInline preload="metadata" className="absolute inset-0 w-full h-full object-cover">
                              <source src={lt.videos[0]} type="video/mp4" />
                            </video>
                          ) : lt.image ? (
                            <img src={lt.image} alt={lt.label} className="absolute inset-0 w-full h-full object-cover" />
                          ) : null}
                          <div className="absolute inset-0 bg-gradient-to-b sm:bg-gradient-to-r from-transparent to-[#071027]/70" />
                          {lt.key === "vip" && lt.videos && lt.videos.length > 1 && (
                            <div className="absolute bottom-2 left-3 flex gap-1">
                              <span className="font-body text-xs uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ backgroundColor: `${lt.accent}30`, color: lt.accent }}>NeoVerse</span>
                              <span className="font-body text-xs uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ backgroundColor: `${cyan}30`, color: cyan }}>HyperBowling</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Content side */}
                      <div className="flex-1 p-5">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-heading uppercase text-white text-base tracking-wider" style={{ textShadow: `0 0 15px ${lt.accent}25` }}>
                            {lt.label}
                          </h3>
                          {count === 0 && !nextTime && (
                            <span className="font-body text-xs uppercase tracking-wider px-2 py-0.5 rounded-full font-bold" style={{ backgroundColor: "rgba(253,91,86,0.2)", color: coral, border: `1px solid ${coral}40` }}>
                              Sold Out
                            </span>
                          )}
                          {count === 0 && nextTime && (
                            <span className="font-body text-xs uppercase tracking-wider px-2 py-0.5 rounded-full font-bold" style={{ backgroundColor: "rgba(255,215,0,0.15)", color: gold, border: `1px solid rgba(255,215,0,0.3)` }}>
                              Next: {formatTimeStr(nextTime)}
                            </span>
                          )}
                        </div>
                        <p className="font-body text-white/60 text-sm mb-3">{lt.desc}</p>

                        {lt.details && (
                          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
                            {lt.details.map(d => (
                              <span key={d} className="flex items-center gap-1.5">
                                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: lt.accent }} />
                                <span className="font-body text-white/40 text-xs">{d}</span>
                              </span>
                            ))}
                          </div>
                        )}

                        {count > 0 && (
                          <button
                            onClick={() => { setLaneType(lt.key); trackBowlingStep("Lane Type Selected", { type: lt.label }); setStep("offer"); }}
                            className="font-body text-sm font-bold uppercase tracking-wider px-5 py-2.5 rounded-full cursor-pointer transition-all hover:scale-105"
                            style={{ backgroundColor: lt.accent, color: "#0a1628" }}
                          >
                            {count} package{count !== 1 ? "s" : ""} available &rarr;
                          </button>
                        )}
                        {nextTime && count === 0 && (
                          <div className="space-y-2">
                            <p className="font-body text-xs text-white/40">
                              Sold out at {formatTimeStr(selectedTime)}
                            </p>
                            <button
                              onClick={() => setPendingTimeSwitch({ laneType: lt.key, laneLabel: lt.label, fromTime: selectedTime, toTime: nextTime })}
                              className="font-body text-sm font-bold uppercase tracking-wider px-5 py-2.5 rounded-full cursor-pointer transition-all hover:scale-105"
                              style={{ backgroundColor: gold, color: "#0a1628" }}
                            >
                              Switch to {formatTimeStr(nextTime)} &rarr;
                            </button>
                          </div>
                        )}
                        {isSoldOut && (
                          <span className="font-body text-xs font-bold uppercase tracking-wider" style={{ color: coral }}>
                            Not available today
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <button onClick={goBack} className="mt-4 font-body text-white/40 text-sm cursor-pointer">&larr; Back</button>
          </div>
        )}

        {/* ── OFFER ── */}
        {step === "offer" && !loading && (
          <div>
            <h2 className="font-heading uppercase text-white text-lg tracking-wider mb-2 text-center">Choose a Package</h2>
            <p className="font-body text-white/40 text-xs text-center mb-4">Showing packages near {formatTimeStr(selectedTime)}</p>
            <div className="space-y-4">
              {filteredOffers.map(offer => {
                const validItems = filterOfferItems(offer, selectedTime, selectedDate);
                if (validItems.length === 0) return null; // Hide offers with no items within 1 hour

                const perPerson = isPerPerson(offer.Name);
                const firstItem = validItems[0];
                const basePrice = firstItem?.Total || 0;
                const perPersonPrice = perPerson && playerCount > 0 ? basePrice / playerCount : 0;
                const hasMultipleItems = validItems.length > 1;

                function handleSelectItem(item: OfferItem) {
                  const tariff = { Id: item.ItemId, Name: offer.Name, Price: item.Total, Duration: formatDuration(item.Quantity, item.QuantityType) };

                  // Check if item time differs from selected time
                  const itemTime = item.Time;
                  if (!item.Reason && item.Remaining > 0 && itemTime !== selectedTime) {
                    // Time shift — show confirmation
                    setPendingOffer({ offer, tariff, newTime: itemTime });
                    return;
                  }

                  // Check alternatives
                  if (item.Reason || item.Remaining === 0) {
                    const bestAlt = item.Alternatives?.find(a => a.Remaining > 0 && isWithinOneHour(a.Time, selectedTime));
                    if (bestAlt && bestAlt.Time !== selectedTime) {
                      setPendingOffer({ offer, tariff: { ...tariff, Price: bestAlt.Total }, newTime: bestAlt.Time });
                      return;
                    }
                  }

                  selectOffer(offer, tariff);
                }

                return (
                  <div
                    key={offer.OfferId}
                    className="rounded-lg overflow-hidden"
                    style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}25` }}
                  >
                    <div className="flex flex-col sm:flex-row">
                    {offer.ImageUrl && (
                      <div className="relative w-full sm:w-72 h-40 shrink-0 overflow-hidden sm:min-h-[200px]">
                        <img src={offer.ImageUrl} alt={offer.Name} className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-gradient-to-b sm:bg-gradient-to-r from-transparent to-[#071027]/80" />
                        <span className="absolute top-2 right-2 font-body text-xs uppercase tracking-wider px-2 py-1 rounded-full font-bold"
                          style={{ backgroundColor: perPerson ? `${coral}90` : `${gold}90`, color: "#fff" }}>
                          {perPerson ? "Per Person" : "Per Lane"}
                        </span>
                      </div>
                    )}
                    <div className="p-4">
                      <h3 className="font-heading uppercase text-white text-sm tracking-wider mb-1">{offer.Name}</h3>
                      {offer.Description && <p className="font-body text-white/50 text-xs mb-3">{stripHtml(offer.Description)}</p>}

                      <div className="grid gap-2 grid-cols-3">
                        {validItems.map(item => {
                          const timeShift = (!item.Reason && item.Remaining > 0 && item.Time !== selectedTime) ? item.Time : null;
                          return (
                            <button
                              key={item.ItemId}
                              onClick={() => handleSelectItem(item)}
                              className="flex flex-col items-center justify-center rounded-lg p-4 cursor-pointer transition-all hover:bg-white/5 hover:scale-[1.02] text-center"
                              style={{ border: `1px solid ${timeShift ? "rgba(255,215,0,0.3)" : "rgba(255,255,255,0.1)"}` }}
                            >
                              {hasMultipleItems && (
                                <span className="font-heading text-white text-sm tracking-wider mb-1">{formatDuration(item.Quantity, item.QuantityType)}</span>
                              )}
                              <span className="font-heading text-xl mb-1" style={{ color: gold }}>${item.Total.toFixed(2)}</span>
                              {perPerson && (
                                <span className="font-body text-white/40 text-xs">${perPersonPrice.toFixed(2)}/person</span>
                              )}
                              {!perPerson && (
                                <span className="font-body text-white/40 text-xs">per lane</span>
                              )}
                              {item.Remaining > 0 && !item.Reason && (
                                <span className="font-body text-white/20 text-xs mt-1">{item.Remaining} left</span>
                              )}
                              {timeShift && (
                                <span className="font-body text-xs mt-1" style={{ color: gold }}>at {formatTimeStr(timeShift)}</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    </div>
                  </div>
                );
              }).filter(Boolean)}
            </div>
            {filteredOffers.filter(o => filterOfferItems(o, selectedTime, selectedDate).length > 0).length === 0 && (
              <p className="font-body text-white/40 text-sm text-center py-8">No packages available within an hour of {formatTimeStr(selectedTime)}. Try a different time.</p>
            )}
            <button onClick={goBack} className="mt-4 font-body text-white/40 text-sm cursor-pointer">&larr; Back</button>
          </div>
        )}

        {/* ── FOOD & BEVERAGE (Pizza Bowl only, for now) ── */}
        {step === "food-beverage" && (
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="text-center mb-2">
              <p className="font-body text-[11px] uppercase tracking-[0.2em]" style={{ color: coral }}>Included with Pizza Bowl</p>
              <h2 className="font-heading uppercase text-white text-lg tracking-wider mt-1">Customize Your Food</h2>
              <p className="font-body text-white/50 text-xs mt-1">Pick your pizza toppings and soda flavor.</p>
            </div>

            {fbLoading && (
              <div className="flex items-center justify-center py-16 gap-3">
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
                <span className="font-body text-white/50 text-sm">Loading menu…</span>
              </div>
            )}

            {!fbLoading && (
              <>
                {/* Complimentary VIP Chips & Salsa — read-only, proportional to the other cards */}
                {fbChipsItem && (
                  <div className="rounded-xl overflow-hidden bg-white/[0.03] border border-white/10">
                    <div className="flex items-center gap-3 p-4">
                      {fbChipsItem.ImageUrl && (
                        <div className="shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-white/5">
                          <img
                            src={fbChipsItem.ImageUrl}
                            alt={fbChipsItem.Name}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              const wrapper = (e.currentTarget as HTMLImageElement).parentElement;
                              if (wrapper) wrapper.style.display = "none";
                            }}
                          />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider" style={{ backgroundColor: gold, color: "#0a1628" }}>Complimentary</span>
                          <h3 className="font-body text-white font-bold text-sm">{fbChipsItem.Name}</h3>
                        </div>
                        <p className="font-body text-white/50 text-xs">Included with your VIP lane — one order per 6 bowlers.</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Pizza Bowl Pizza — one card per lane */}
                {fbPizzaItem && Array.from({ length: includedLaneCount }).map((_, laneIdx) => (
                  <div key={`pizza-${laneIdx}`} data-fb-card={`pizza-${laneIdx}`} className="scroll-mt-[190px] sm:scroll-mt-[170px]">
                    <ModifierCard
                      title={includedLaneCount > 1 ? `${fbPizzaItem.item.Name} — Lane ${laneIdx + 1}` : fbPizzaItem.item.Name}
                      subtitle={includedLaneCount > 1 ? "Included — customize each lane separately" : "Included — 1 per lane"}
                      imageUrl={fbPizzaItem.item.ImageUrl}
                      accent={coral}
                      modifiers={fbPizzaItem.modifiers}
                      selections={fbPizzaSelections[laneIdx] || {}}
                      onToggle={(group, id) => toggleModifier(setFbPizzaSelections, laneIdx, group, id)}
                    />
                  </div>
                ))}

                {/* Pizza Bowl Soda Pitcher — one card per lane */}
                {fbSodaItem && Array.from({ length: includedLaneCount }).map((_, laneIdx) => (
                  <div key={`soda-${laneIdx}`} data-fb-card={`soda-${laneIdx}`} className="scroll-mt-[190px] sm:scroll-mt-[170px]">
                    <ModifierCard
                      title={includedLaneCount > 1 ? `${fbSodaItem.item.Name} — Lane ${laneIdx + 1}` : fbSodaItem.item.Name}
                      subtitle={includedLaneCount > 1 ? "Included — pick a flavor for each lane" : "Included — 1 per lane"}
                      imageUrl={fbSodaItem.item.ImageUrl}
                      accent={coral}
                      modifiers={fbSodaItem.modifiers}
                      selections={fbSodaSelections[laneIdx] || {}}
                      onToggle={(group, id) => toggleModifier(setFbSodaSelections, laneIdx, group, id)}
                    />
                  </div>
                ))}

                {!fbPizzaItem && !fbSodaItem && !fbChipsItem && (
                  <p className="font-body text-white/50 text-sm text-center py-8">
                    No included items to configure for this package.
                  </p>
                )}

                {/* Placeholder for future paid F&B items (wings, pizzas, sandwiches, etc.) */}
                <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.015] p-5 text-center">
                  <p className="font-body text-white/35 text-xs uppercase tracking-[0.2em]">Order more food &amp; drink</p>
                  <p className="font-body text-white/25 text-[11px] mt-1.5">Appetizers, wings, sandwiches, pizzas, and desserts — coming soon.</p>
                </div>
              </>
            )}

            {(() => {
              // Gate Continue — every radio (MaxQuantity=1) group on each included
              // item + lane must have a selection. QAMF's MinQuantity=0 on these
              // groups isn't enforced server-side but we want the guest to make
              // an explicit choice (even if it's "No Topping" / "No beverage")
              // so nothing ends up defaulted silently.
              const missing: string[] = [];
              const checkItem = (
                item: { Name: string; ImageUrl?: string } | null,
                modifiers: ItemModifiers | undefined,
                laneSelections: Array<Record<number, Set<number>>>,
                itemKind: "pizza" | "soda",
              ) => {
                if (!item || !modifiers) return;
                for (let laneIdx = 0; laneIdx < includedLaneCount; laneIdx++) {
                  const laneSel = laneSelections[laneIdx] || {};
                  const requiredGroups = modifiers.ModifiersGroups.filter((g) => g.Rules.MaxQuantity === 1);
                  for (const g of requiredGroups) {
                    const picked = laneSel[g.IdModifierGroup];
                    if (!picked || picked.size === 0) {
                      const laneLabel = includedLaneCount > 1 ? ` · Lane ${laneIdx + 1}` : "";
                      missing.push(`${itemKind === "pizza" ? "Pizza" : "Soda"}${laneLabel}: ${g.Name}`);
                    }
                  }
                }
              };
              checkItem(fbPizzaItem?.item || null, fbPizzaItem?.modifiers, fbPizzaSelections, "pizza");
              checkItem(fbSodaItem?.item || null, fbSodaItem?.modifiers, fbSodaSelections, "soda");
              const canContinue = !fbLoading && missing.length === 0;
              return (
                <div data-fb-continue className="pt-2 scroll-mt-[200px]">
                  {missing.length > 0 && (
                    <p className="font-body text-amber-400/80 text-xs text-center mb-2">
                      Please choose {missing.join(" · ")}
                    </p>
                  )}
                  <button
                    onClick={() => setStep("extras")}
                    disabled={!canContinue}
                    className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
                    style={{ backgroundColor: coral, boxShadow: !canContinue ? "none" : `0 0 16px ${coral}30` }}
                  >
                    Continue
                  </button>
                  <button onClick={goBack} className="mt-3 font-body text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
                </div>
              );
            })()}
          </div>
        )}

        {/* ── EXTRAS ── */}
        {step === "extras" && !loading && (
          <div>
            <h2 className="font-heading uppercase text-white text-lg tracking-wider mb-2 text-center">Level Up Your Visit</h2>
            <p className="font-body text-white/40 text-xs text-center mb-6">Add activities to your bowling session</p>

            {/* Bowling time reference */}
            <div className="rounded-lg p-3 mb-6" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1px solid rgba(255,255,255,0.1)" }}>
              <p className="font-body text-white/40 text-xs uppercase tracking-wider mb-1">Your Bowling Time</p>
              <p className="font-body text-white text-sm font-bold">
                {formatTimeStr(selectedTime)} &bull; {selectedOffer?.Name} &bull; {playerCount} bowlers
              </p>
            </div>

            {/* VIP Chips & Salsa included */}
            {selectedOffer && classifyOffer(selectedOffer.Name) === "vip" && (
              <div className="rounded-lg p-4 mb-4 flex items-center gap-3" style={{ backgroundColor: `${gold}08`, border: `1.78px dashed ${gold}25` }}>
                <span className="font-body text-sm" style={{ color: gold }}>&#x1f37f;</span>
                <div>
                  <span className="font-body text-white font-bold text-sm">Complimentary Chips &amp; Salsa</span>
                  <span className="font-body text-white/40 text-xs ml-2">Included with VIP</span>
                </div>
              </div>
            )}

            {/* Shoes toggle */}
            {shoes.length > 0 && (
              <div className="rounded-lg p-4 mb-4" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${cyan}25` }}>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-body text-white font-bold text-sm">Bowling Shoes</h3>
                    <p className="font-body text-white/40 text-xs">${shoes[0].Price}/person</p>
                  </div>
                  <button type="button" onClick={() => setWantShoes(!wantShoes)}
                    role="switch" aria-checked={wantShoes} aria-label="Add bowling shoes"
                    className="w-12 h-7 rounded-full transition-all cursor-pointer" style={{ backgroundColor: wantShoes ? coral : "rgba(255,255,255,0.1)" }}>
                    <div className="w-5 h-5 rounded-full bg-white transition-all" style={{ marginLeft: wantShoes ? "26px" : "2px" }} />
                  </button>
                </div>
              </div>
            )}

            {/* BMI Add-ons */}
            {currentAddons.length > 0 && (
              <div className="space-y-4 mb-6">
                {currentAddons.map(addon => {
                  const qty = bmiAddonQty[addon.productId] || 0;
                  const isSelected = qty > 0;
                  const slots = bmiTimeSlots[addon.productId] || [];
                  const selectedIdx = bmiSelectedTime[addon.productId];
                  const isLoadingSlots = bmiLoadingSlots[addon.productId];

                  return (
                    <div
                      key={addon.productId}
                      data-addon-id={addon.productId}
                      className="rounded-lg overflow-hidden transition-all"
                      style={{
                        backgroundColor: isSelected ? `${addon.accent}08` : "rgba(7,16,39,0.5)",
                        border: `1.78px dashed ${isSelected ? addon.accent + "50" : "rgba(255,255,255,0.1)"}`,
                      }}
                    >
                      <div className="flex flex-col sm:flex-row">
                        {/* Image */}
                        <div className="relative w-full sm:w-36 h-28 sm:h-auto shrink-0 overflow-hidden">
                          <img src={addon.image} alt={addon.shortName} className="w-full h-full object-cover" />
                          <span className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-xs font-bold text-white" style={{ backgroundColor: addon.accent }}>
                            {addon.shortName}
                          </span>
                        </div>

                        <div className="flex-1 p-4">
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <h3 className="font-body text-white font-bold text-sm">{addon.name}</h3>
                            <span className="font-body text-sm font-bold shrink-0" style={{ color: addon.accent }}>
                              {addon.perPerson ? `$${addon.price}/person` : `$${addon.price}${addon.maxPerGroup ? ` (up to ${addon.maxPerGroup})` : ""}`}
                            </span>
                          </div>
                          <p className="font-body text-white/40 text-xs mb-3">{addon.desc}</p>

                          {/* Add/quantity controls */}
                          {addon.perPerson ? (
                            qty === 0 ? (
                              <button
                                onClick={() => setBmiQty(addon.productId, playerCount)}
                                className="w-full py-2.5 rounded-lg text-xs font-bold font-body transition-colors cursor-pointer"
                                style={{ backgroundColor: `${addon.accent}15`, color: addon.accent, border: `1px solid ${addon.accent}30` }}
                              >
                                Add for all {playerCount} bowlers &mdash; ${(addon.price * playerCount).toFixed(2)}
                              </button>
                            ) : (
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <button onClick={() => setBmiQty(addon.productId, qty - 1)}
                                    className="w-7 h-7 rounded border border-white/20 text-white/50 hover:text-white text-sm cursor-pointer flex items-center justify-center">-</button>
                                  <span className="w-6 text-center text-white font-bold text-xs">{qty}</span>
                                  <button onClick={() => setBmiQty(addon.productId, qty + 1)}
                                    className="w-7 h-7 rounded border border-white/20 text-white/50 hover:text-white text-sm cursor-pointer flex items-center justify-center">+</button>
                                  <span className="font-body text-white/30 text-xs">{qty} people</span>
                                </div>
                                <span className="font-body text-sm font-bold" style={{ color: addon.accent }}>${(addon.price * qty).toFixed(2)}</span>
                              </div>
                            )
                          ) : (
                            <div className="flex items-center justify-between">
                              <button
                                onClick={() => setBmiQty(addon.productId, qty > 0 ? 0 : 1)}
                                className="px-4 py-2 rounded-lg text-xs font-bold font-body transition-colors cursor-pointer"
                                style={{
                                  backgroundColor: isSelected ? addon.accent : "rgba(255,255,255,0.1)",
                                  color: isSelected ? "#0a1628" : "rgba(255,255,255,0.6)",
                                }}
                              >
                                {isSelected ? "Added \u2713" : "Add to Booking"}
                              </button>
                              {isSelected && <span className="font-body text-sm font-bold" style={{ color: addon.accent }}>${addon.price.toFixed(2)}</span>}
                            </div>
                          )}

                          {/* Time picker */}
                          {isSelected && (
                            <div className="mt-3 pt-3 border-t border-white/10">
                              {isLoadingSlots ? (
                                <div className="flex items-center gap-2 font-body text-white/40 text-xs">
                                  <div className="w-3 h-3 border border-white/30 border-t-white/80 rounded-full animate-spin" />
                                  Loading times...
                                </div>
                              ) : slots.length === 0 ? (
                                <p className="font-body text-amber-400/70 text-xs">No times available on this date</p>
                              ) : (
                                <div>
                                  <p className="font-body text-white/50 text-xs uppercase tracking-wider mb-2">Select a time</p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {(() => {
                                      // Merge bowling time into timeline
                                      const bowlTimeMs = new Date(`${resolveDateTime(selectedDate, selectedTime)}:00`).getTime();
                                      const items: { time: number; type: "slot" | "bowling"; idx?: number; slot?: typeof slots[0] }[] = [
                                        ...slots.map((s, idx) => ({ time: parseBmiLocal(s.start).getTime(), type: "slot" as const, idx, slot: s })),
                                        { time: bowlTimeMs, type: "bowling" as const },
                                      ];
                                      items.sort((a, b) => a.time - b.time);

                                      return items.map((item, i) => {
                                        if (item.type === "bowling") {
                                          return (
                                            <span key="bowling" className="px-3 py-1.5 rounded-lg text-xs font-bold font-body"
                                              style={{ backgroundColor: `${coral}20`, color: coral, border: `1px solid ${coral}40` }}>
                                              {formatTimeStr(selectedTime)} Bowling
                                            </span>
                                          );
                                        }
                                        const addonConflict = conflictsWithOtherAddon(item.slot!.start, item.slot!.stop, addon.productId);
                                        return (
                                          <button
                                            key={item.slot!.start}
                                            onClick={() => !addonConflict && holdAddonSlot(addon.productId, item.idx!)}
                                            disabled={addonConflict}
                                            className={`px-3 py-1.5 rounded-lg text-xs font-bold font-body transition-all ${addonConflict ? "cursor-not-allowed opacity-30" : "cursor-pointer"}`}
                                            style={{
                                              backgroundColor: selectedIdx === item.idx ? addon.accent : "rgba(7,16,39,0.5)",
                                              color: selectedIdx === item.idx ? "#0a1628" : addonConflict ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.6)",
                                              border: `1px solid ${selectedIdx === item.idx ? addon.accent : "rgba(255,255,255,0.1)"}`,
                                            }}
                                          >
                                            {formatBmiTime(item.slot!.start)}
                                          </button>
                                        );
                                      });
                                    })()}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {(() => {
              const missingTimes = currentAddons.filter((addon) => {
                const qty = bmiAddonQty[addon.productId] || 0;
                if (qty <= 0) return false;
                const slots = bmiTimeSlots[addon.productId] || [];
                if (slots.length === 0) return false;
                return bmiSelectedTime[addon.productId] === undefined;
              });
              const disabled = missingTimes.length > 0;
              return (
                <>
                  {disabled && (
                    <p className="font-body text-amber-400/80 text-xs text-center mb-2">
                      Select a time for: {missingTimes.map((a) => a.shortName || a.name).join(", ")}
                    </p>
                  )}
                  <button
                    onClick={goToReview}
                    disabled={disabled}
                    className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
                    style={{ backgroundColor: coral, boxShadow: disabled ? "none" : `0 0 16px ${coral}30` }}
                  >
                    Review Order
                  </button>
                </>
              );
            })()}
            <button onClick={goBack} className="mt-4 font-body text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}

        {/* ── REVIEW ── */}
        {step === "review" && !loading && cartSummary && (
          <div>
            <h2 className="font-heading uppercase text-white text-lg tracking-wider mb-4 text-center">Order Summary</h2>
            <div className="rounded-lg p-5 mb-6" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${gold}30` }}>
              <div className="space-y-2 mb-4 pb-4 border-b border-white/10">
                <div className="flex justify-between">
                  <span className="font-body text-white text-sm">{selectedOffer?.Name}</span>
                  <span className="font-body text-white text-sm">${selectedTariff?.Price.toFixed(2)}</span>
                </div>
                <p className="font-body text-white/50 text-xs">
                  {new Date(calYear, calMonth, parseInt(selectedDate.split("-")[2])).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} at {formatTimeStr(selectedTime)} &bull; {playerCount} bowlers
                </p>
                {wantShoes && shoes.length > 0 && (
                  <div className="flex justify-between mt-1">
                    <span className="font-body text-white/70 text-sm">Bowling Shoes x{playerCount}</span>
                    <span className="font-body text-white/70 text-sm">${(shoes[0].Price * playerCount).toFixed(2)}</span>
                  </div>
                )}
                {selectedOffer && classifyOffer(selectedOffer.Name) === "vip" && (
                  <div className="flex justify-between mt-1">
                    <span className="font-body text-sm" style={{ color: gold }}>Chips &amp; Salsa x{Math.ceil(playerCount / 6)} (per lane)</span>
                    <span className="font-body text-sm" style={{ color: gold }}>FREE</span>
                  </div>
                )}

                {/* Pizza Bowl included items with chosen modifiers — one row per lane */}
                {selectedOffer && isPizzaBowl(selectedOffer.Name) && fbPizzaItem && Array.from({ length: includedLaneCount }).map((_, laneIdx) => {
                  const { modifiers, upchargeTotal } = buildItemModifiers(fbPizzaItem.modifiers, fbPizzaSelections[laneIdx] || {});
                  const laneLabel = includedLaneCount > 1 ? ` (Lane ${laneIdx + 1})` : "";
                  return (
                    <div key={`pizza-summary-${laneIdx}`} className="mt-1">
                      <div className="flex justify-between">
                        <span className="font-body text-sm" style={{ color: upchargeTotal > 0 ? "#fff" : gold }}>{fbPizzaItem.item.Name}{laneLabel}</span>
                        <span className="font-body text-sm" style={{ color: upchargeTotal > 0 ? "#fff" : gold }}>
                          {upchargeTotal > 0 ? `$${upchargeTotal.toFixed(2)}` : "FREE"}
                        </span>
                      </div>
                      {modifiers.length > 0 && (
                        <p className="font-body text-white/50 text-xs mt-0.5">
                          {modifiers.map((m) => m.Name).join(", ")}
                        </p>
                      )}
                    </div>
                  );
                })}
                {selectedOffer && isPizzaBowl(selectedOffer.Name) && fbSodaItem && Array.from({ length: includedLaneCount }).map((_, laneIdx) => {
                  const { modifiers, upchargeTotal } = buildItemModifiers(fbSodaItem.modifiers, fbSodaSelections[laneIdx] || {});
                  const laneLabel = includedLaneCount > 1 ? ` (Lane ${laneIdx + 1})` : "";
                  return (
                    <div key={`soda-summary-${laneIdx}`} className="mt-1">
                      <div className="flex justify-between">
                        <span className="font-body text-sm" style={{ color: upchargeTotal > 0 ? "#fff" : gold }}>{fbSodaItem.item.Name}{laneLabel}</span>
                        <span className="font-body text-sm" style={{ color: upchargeTotal > 0 ? "#fff" : gold }}>
                          {upchargeTotal > 0 ? `$${upchargeTotal.toFixed(2)}` : "FREE"}
                        </span>
                      </div>
                      {modifiers.length > 0 && (
                        <p className="font-body text-white/50 text-xs mt-0.5">
                          {modifiers.map((m) => m.Name).join(", ")}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              {/* BMI add-ons with prices */}
              {getBmiAddons().length > 0 && (
                <div className="space-y-1 mb-4 pb-4 border-b border-white/10">
                  <p className="font-body text-white/40 text-xs uppercase tracking-wider mb-2">Add-On Activities</p>
                  {getBmiAddons().map(a => (
                    <div key={a.productId} className="flex justify-between">
                      <span className="font-body text-white/70 text-sm">
                        {a.name} {a.selectedTime ? `at ${formatBmiTime(a.selectedTime)}` : ""} {a.perPerson ? `x${a.quantity}` : ""}
                      </span>
                      <span className="font-body text-white text-sm">${(a.price * a.quantity).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1 mb-4 pb-4 border-b border-white/10">
                <div className="flex justify-between"><span className="font-body text-white/60 text-sm">Subtotal</span><span className="font-body text-white text-sm">${cartSummary.TotalItems.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="font-body text-white/60 text-sm">Tax</span><span className="font-body text-white text-sm">${cartSummary.AddedTaxes.toFixed(2)}</span></div>
                {cartSummary.Fee > 0 && (
                  <div className="flex justify-between"><span className="font-body text-white/60 text-sm">Service Fee</span><span className="font-body text-white text-sm">${cartSummary.Fee.toFixed(2)}</span></div>
                )}
              </div>
              <div className="flex justify-between">
                <span className="font-body text-white font-bold">Total Due</span>
                <span className="font-heading text-xl" style={{ color: gold }}>${cartSummary.Total.toFixed(2)}</span>
              </div>
            </div>
            <button onClick={() => setStep("details")}
              className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}>Continue to Payment</button>
            <button onClick={goBack} className="mt-4 font-body text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}

        {/* ── DETAILS ── */}
        {step === "details" && !redirectingToPayment && !loading && (
          <div>
            <h2 className="font-heading uppercase text-white text-lg tracking-wider mb-4 text-center">Your Details</h2>
            <div className="space-y-3 mb-6">
              <input type="text" placeholder="Full Name" value={guestName} onChange={e => setGuestName(e.target.value)}
                className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-body text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors" />
              <input type="email" placeholder="Email" value={guestEmail} onChange={e => setGuestEmail(e.target.value)}
                className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-body text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors" />
              <input type="tel" placeholder="Phone Number" value={guestPhone} onChange={e => setGuestPhone(e.target.value)}
                className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-body text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors" />
            </div>
            <button onClick={submitBooking} disabled={loading}
              className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-[#0a1628] cursor-pointer transition-all hover:scale-[1.02] disabled:opacity-50"
              style={{ backgroundColor: gold, boxShadow: `0 0 16px ${gold}30` }}>
              {loading ? "Processing..." : "Pay & Confirm"}
            </button>
            <button onClick={goBack} className="mt-4 font-body text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}

        {/* ── REDIRECTING TO PAYMENT ── */}
        {redirectingToPayment && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="relative mb-6">
              <div className="w-16 h-16 border-2 border-white/10 border-t-[#FFD700] rounded-full animate-spin" />
              <svg className="absolute inset-0 m-auto w-7 h-7 text-[#FFD700]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h2 className="font-heading uppercase text-white text-lg tracking-wider mb-2">
              Loading Secure Payment
            </h2>
            <p className="font-body text-white/50 text-sm">
              Opening secure checkout — please wait...
            </p>
          </div>
        )}
      </section>

      {/* Location confirmation modal */}
      {showLocationConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4" {...modalBackdropProps(() => setShowLocationConfirm(false))}>
          <div className="rounded-lg p-6 max-w-sm w-full text-center" style={{ backgroundColor: "#0a1628", border: `1.78px dashed ${coral}40` }}>
            <h3 className="font-heading uppercase text-white text-base tracking-wider mb-2">
              Confirm Location
            </h3>
            <p className="font-body text-white/60 text-sm mb-1">
              You&apos;re booking at:
            </p>
            <p className="font-heading font-black uppercase text-white text-xl mb-1" style={{ textShadow: `0 0 20px ${coral}30` }}>
              {centerName}
            </p>
            <p className="font-body text-white/40 text-xs mb-6">
              {LOCATIONS.find(l => l.id === centerId)?.address}
            </p>
            <button
              onClick={() => {
                setShowLocationConfirm(false);
                selectLocation(LOCATIONS.find(l => l.id === centerId)!);
              }}
              className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}
            >
              Yes, this is correct
            </button>
          </div>
        </div>
      )}

      {/* VIP Upgrade modal */}
      {showVipUpgrade && selectedOffer && (() => {
        const upgrade = findVipUpgrade(selectedOffer, allOffers, selectedTime);
        if (!upgrade) return null;
        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 px-4" {...modalBackdropProps(() => setShowVipUpgrade(false))}>
            <div className="rounded-lg overflow-hidden max-w-md w-full" style={{ backgroundColor: "#0a1628", border: `1.78px dashed ${gold}40` }}>
              {/* Large video */}
              <div className="relative h-48 overflow-hidden">
                <video autoPlay muted loop playsInline preload="metadata" className="absolute inset-0 w-full h-full object-cover">
                  <source src={`${BLOB}/videos/headpinz-neoverse-v2.mp4`} type="video/mp4" />
                </video>
                <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#0a1628]" />
                <div className="absolute bottom-3 left-4 flex gap-2">
                  <span className="font-body text-xs uppercase tracking-wider px-2 py-1 rounded-full font-bold" style={{ backgroundColor: `${gold}50`, color: gold }}>NeoVerse</span>
                  <span className="font-body text-xs uppercase tracking-wider px-2 py-1 rounded-full font-bold" style={{ backgroundColor: `${cyan}50`, color: cyan }}>HyperBowling</span>
                </div>
              </div>

              <div className="p-6 text-center">
                <h3 className="font-heading uppercase text-white text-lg tracking-wider mb-2" style={{ textShadow: `0 0 20px ${gold}30` }}>
                  Upgrade to VIP?
                </h3>
                <p className="font-body text-white/60 text-sm mb-2">
                  NeoVerse interactive LED walls and HyperBowling LED target scoring in our private VIP suite.
                </p>
                <p className="font-body text-white/40 text-xs mb-6">
                  8 VIP lanes &bull; Complimentary Chips &amp; Salsa &bull; Private lounge
                </p>

                <div className="flex gap-3">
                  <button
                    onClick={() => setShowVipUpgrade(false)}
                    className="flex-1 py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white cursor-pointer border border-white/20 hover:border-white/40 transition-all"
                  >
                    No Thanks
                  </button>
                  <button
                    onClick={() => {
                      setShowVipUpgrade(false);
                      selectOffer(upgrade.offer, { Id: upgrade.item.ItemId, Name: upgrade.offer.Name, Price: upgrade.item.Total, Duration: formatDuration(upgrade.item.Quantity, upgrade.item.QuantityType) });
                    }}
                    className="flex-1 py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-[#0a1628] cursor-pointer transition-all hover:scale-[1.02]"
                    style={{ backgroundColor: gold, boxShadow: `0 0 20px ${gold}30` }}
                  >
                    Upgrade +${upgrade.priceDiff.toFixed(2)}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Time change confirmation modal */}
      {pendingOffer && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4"
          {...modalBackdropProps(() => setPendingOffer(null))}
        >
          <div
            className="rounded-lg p-6 max-w-sm w-full text-center"
            style={{ backgroundColor: "#0a1628", border: `1.78px dashed ${gold}40` }}
          >
            <h3 className="font-heading uppercase text-white text-base tracking-wider mb-2">
              Time Change
            </h3>
            <p className="font-body text-white/60 text-sm mb-4">
              <strong>{pendingOffer.offer.Name}</strong> is not available at {formatTimeStr(selectedTime)} but is available at:
            </p>
            <p className="font-heading text-2xl mb-6" style={{ color: gold }}>
              {formatTimeStr(pendingOffer.newTime)}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setPendingOffer(null)}
                className="flex-1 py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white cursor-pointer border border-white/20 hover:border-white/40 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const { offer, tariff, newTime } = pendingOffer;
                  setPendingOffer(null);
                  selectOffer(offer, tariff, newTime);
                }}
                className="flex-1 py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-[#0a1628] cursor-pointer transition-all hover:scale-[1.02]"
                style={{ backgroundColor: gold, boxShadow: `0 0 16px ${gold}30` }}
              >
                Accept {formatTimeStr(pendingOffer.newTime)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Time switch confirmation modal */}
      {pendingTimeSwitch && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4"
          {...modalBackdropProps(() => setPendingTimeSwitch(null))}
        >
          <div
            className="rounded-lg p-6 max-w-sm w-full text-center"
            style={{ backgroundColor: "#0a1628", border: `1.78px dashed ${gold}40` }}
          >
            <h3 className="font-heading uppercase text-white text-base tracking-wider mb-2">
              Switch Time?
            </h3>
            <p className="font-body text-white/60 text-sm mb-1">
              <strong className="text-white">{pendingTimeSwitch.laneLabel}</strong> is sold out at {formatTimeStr(pendingTimeSwitch.fromTime)}
            </p>
            <p className="font-body text-white/60 text-sm mb-4">
              The next available time is:
            </p>
            <p className="font-heading text-3xl mb-6" style={{ color: gold }}>
              {formatTimeStr(pendingTimeSwitch.toTime)}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setPendingTimeSwitch(null)}
                className="flex-1 py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white cursor-pointer border border-white/20 hover:border-white/40 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const { laneType, laneLabel, toTime } = pendingTimeSwitch;
                  setSelectedTime(toTime);
                  setLaneType(laneType as LaneType);
                  trackBowlingStep("Lane Type Selected (time switch)", { type: laneLabel, from: pendingTimeSwitch.fromTime, to: toTime });
                  setPendingTimeSwitch(null);
                  setStep("offer");
                }}
                className="flex-1 py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-[#0a1628] cursor-pointer transition-all hover:scale-[1.02]"
                style={{ backgroundColor: gold, boxShadow: `0 0 16px ${gold}30` }}
              >
                Switch to {formatTimeStr(pendingTimeSwitch.toTime)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
