"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { trackBowlingStep } from "@/lib/analytics";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Step = "location" | "players" | "date" | "lane-type" | "offer" | "extras" | "review" | "details";
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

/* BMI Add-on products (HeadPinz Fort Myers only) */
const BMI_ADDONS_PAGE = "43370985";
const BMI_ADDONS = [
  {
    productId: "43370936",
    name: "Nexus Gel Blaster Arena",
    shortName: "Gel Blasters",
    desc: "High-tech blasters, glowing environments, and fast-paced team battles using eco-friendly Gellets.",
    price: 12,
    perPerson: true,
    qamfExtraId: 13751, // QAMF PriceKeyId for billing
    image: `${BLOB}/images/addons/gelblaster-gtOdWfUsDWYEf72h2aBEytF5GCuZUs.jpg`,
    accent: "#39FF14",
  },
  {
    productId: "43370955",
    name: "Nexus Laser Tag Arena",
    shortName: "Laser Tag",
    desc: "Immersive team-based battles with advanced laser blasters and vests in a glowing arena.",
    price: 10,
    perPerson: true,
    qamfExtraId: 13678, // QAMF PriceKeyId for billing
    image: `${BLOB}/images/addons/lasertag-uMlQDT8COLcGQVEfVyqgjgUOseIZjI.jpg`,
    accent: "#E41C1D",
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
    const bowlStart = new Date(`${selectedDate}T${selectedTime}:00`).getTime();
    // Assume bowling is ~2 hours
    const bowlEnd = bowlStart + 2 * 60 * 60_000;
    const sStart = parseBmiLocal(slotStart).getTime();
    const sStop = parseBmiLocal(slotStop).getTime();
    const buffer = 15 * 60_000; // 15 min buffer
    return sStart < (bowlEnd + buffer) && sStop > (bowlStart - buffer);
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
          const res = await fetch("/api/sms?endpoint=dayplanner%2Fdayplanner", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              productId,
              pageId: BMI_ADDONS_PAGE,
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
      if (allSlots.length > 0) setBmiSelectedTime(prev => ({ ...prev, [productId]: 0 }));
    } catch {
      setBmiTimeSlots(prev => ({ ...prev, [productId]: [] }));
    } finally {
      setBmiLoadingSlots(prev => ({ ...prev, [productId]: false }));
    }
  }

  function setBmiQty(productId: string, qty: number) {
    setBmiAddonQty(prev => ({ ...prev, [productId]: Math.max(0, qty) }));
    if (qty > 0 && !bmiTimeSlots[productId] && !bmiLoadingSlots[productId]) {
      fetchBmiTimeSlots(productId, qty);
    }
    if (qty === 0) {
      setBmiSelectedTime(prev => { const n = { ...prev }; delete n[productId]; return n; });
    }
  }

  function getBmiAddons(): BmiAddonSelection[] {
    return BMI_ADDONS.filter(a => (bmiAddonQty[a.productId] || 0) > 0).map(a => {
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
      const today = new Date().toISOString().split("T")[0];
      const end = new Date(Date.now() + 90 * 86400000).toISOString().split("T")[0];
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
    let [eh, em] = end.split(":").map(Number);
    // If end is midnight (00:00) or next day, treat as 23:45
    if (eh === 0) { eh = 23; em = 45; }
    if (eh < sh) { eh = 23; em = 45; }
    for (let h = sh; h <= eh; h++) {
      for (const m of [0, 15, 30, 45]) {
        if (h === sh && m < sm) continue;
        if (h === eh && m > em) continue;
        timeSlots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
      }
    }
  }

  // For same-day bookings, filter out times that are less than 15 min from now
  const todayStr = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; })();
  const isToday = selectedDate === todayStr;
  const filteredTimeSlots = isToday
    ? timeSlots.filter(t => {
        const now = new Date();
        const [h, m] = t.split(":").map(Number);
        const slotDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
        return slotDate.getTime() > now.getTime() + 15 * 60000; // at least 15 min from now
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
      const dt = `${selectedDate}T${selectedTime}`;
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
      const dt = `${selectedDate}T${useTime}`;
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
      setStep("extras");
      // Show VIP upgrade modal if regular and not already shown
      if (classifyOffer(offer.Name) === "regular" && !vipUpgradeShown) {
        const upgrade = findVipUpgrade(offer, allOffers, useTime);
        if (upgrade) { setShowVipUpgrade(true); setVipUpgradeShown(true); }
      }
    } catch { setError("Failed to create reservation"); }
    finally { setLoading(false); }
  }

  /* ── Step: Review cart ───────────────────────────────────────── */

  async function goToReview() {
    setLoading(true);
    setError("");
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
      for (const addon of BMI_ADDONS) {
        const qty = bmiAddonQty[addon.productId] || 0;
        if (qty > 0 && addon.qamfExtraId) {
          extraItems.push({ PriceKeyId: addon.qamfExtraId, Quantity: qty, UnitPrice: addon.price, Note: "" });
        }
      }

      const summary = await qamf(`centers/${centerId}/Cart/CreateSummary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Time: `${selectedDate}T${selectedTime}`,
          Items: {
            Extra: extraItems,
            FoodAndBeverage: classifyOffer(selectedOffer!.Name) === "vip"
              ? [{ PriceKeyId: 13186, Quantity: Math.ceil(playerCount / 6), UnitPrice: 0, Note: "", Modifiers: [] }]
              : [],
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
      const cartItems: { Name: string; Type: string; PriceKeyId: number; Quantity: number; UnitPrice: number; Modifiers?: never[] }[] = [];

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
      BMI_ADDONS.forEach(addon => {
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

      // Add free chips & salsa for VIP packages
      if (classifyOffer(selectedOffer!.Name) === "vip") {
        cartItems.push({
          Name: "VIP Chips & Salsa",
          Type: "FoodBeverage",
          PriceKeyId: 13186,
          Quantity: playerCount,
          UnitPrice: 0,
        });
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

  const allSteps: Step[] = ["location", "players", "date", "lane-type", "offer", "extras", "review", "details"];
  const stepLabels = ["Location", "Party", "Date", "Type", "Package", "Extras", "Review", "Pay"];
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
          <div className="max-w-4xl mx-auto px-4 py-3 overflow-x-auto">
            <div className="flex items-center gap-0 min-w-max">
              {allSteps.map((s, i) => {
                const isPast = i < stepIndex;
                const isCurrent = i === stepIndex;
                const isFuture = i > stepIndex;
                return (
                  <div key={s} className="flex items-center">
                    <div
                      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs sm:text-sm font-[var(--font-hp-body)] font-bold transition-all ${
                        isCurrent ? `text-[${coral}]` :
                        isPast ? "text-white/60" :
                        "text-white/20"
                      }`}
                      style={{ color: isCurrent ? coral : undefined }}
                    >
                      <span
                        className="w-5 h-5 rounded-full text-[10px] flex items-center justify-center font-bold"
                        style={{
                          backgroundColor: isCurrent ? coral : isPast ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.08)",
                          color: isCurrent ? "#fff" : isPast ? "#fff" : "rgba(255,255,255,0.2)",
                        }}
                      >
                        {isPast ? "\u2713" : i + 1}
                      </span>
                      <span className="hidden sm:inline">{stepLabels[i]}</span>
                    </div>
                    {i < allSteps.length - 1 && <span className="text-white/15 mx-0.5">&rsaquo;</span>}
                  </div>
                );
              })}

              {/* Lane held indicator */}
              {reservationKey && countdown && (
                <span
                  className="ml-auto inline-flex items-center gap-1.5 font-[var(--font-hp-body)] text-xs px-3 py-1 rounded-full shrink-0"
                  style={{
                    backgroundColor: countdown === "Expired" ? "rgba(253,91,86,0.15)" : "rgba(255,215,0,0.1)",
                    color: countdown === "Expired" ? coral : gold,
                  }}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: countdown === "Expired" ? coral : gold, animation: countdown !== "Expired" ? "pulse 2s infinite" : "none" }} />
                  {countdown === "Expired" ? "Expired" : countdown}
                  <button onClick={clearReservation} className="ml-1 text-white/40 hover:text-white cursor-pointer">&times;</button>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Booking context bar — always visible once location is selected */}
      {centerName && step !== "location" && (
        <div className="bg-[#071027] border-b border-white/5">
          <div className="max-w-4xl mx-auto px-4 py-2 flex items-center justify-center gap-3 flex-wrap text-center">
            <span className="inline-flex items-center gap-1.5 font-[var(--font-hp-body)] text-xs text-white/60">
              <svg className="w-3.5 h-3.5 text-[#fd5b56]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              {centerName}
            </span>
            {selectedDate && (
              <>
                <span className="text-white/20">|</span>
                <span className="inline-flex items-center gap-1.5 font-[var(--font-hp-body)] text-xs text-white/60">
                  <svg className="w-3.5 h-3.5 text-[#00E2E5]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  {new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                </span>
              </>
            )}
            {selectedTime && (
              <>
                <span className="text-white/20">|</span>
                <span className="inline-flex items-center gap-1.5 font-[var(--font-hp-body)] text-xs text-white/60">
                  <svg className="w-3.5 h-3.5 text-[#FFD700]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  {formatTimeStr(selectedTime)}
                </span>
              </>
            )}
            {playerCount > 0 && selectedDate && (
              <>
                <span className="text-white/20">|</span>
                <span className="inline-flex items-center gap-1.5 font-[var(--font-hp-body)] text-xs text-white/60">
                  <svg className="w-3.5 h-3.5 text-white/40" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                  {playerCount} bowler{playerCount !== 1 ? "s" : ""}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="max-w-lg mx-auto px-4 mb-4">
          <div className="bg-[#fd5b56]/10 border border-[#fd5b56]/30 rounded-lg px-4 py-3 text-center">
            <p className="font-[var(--font-hp-body)] text-[#fd5b56] text-sm">{error}</p>
          </div>
        </div>
      )}

      {loading && (
        <div className="text-center py-12">
          <div className="inline-block w-8 h-8 border-2 border-white/20 border-t-[#fd5b56] rounded-full animate-spin" />
        </div>
      )}

      <section className="max-w-5xl mx-auto px-4 py-8 pb-24">

        {/* ── LOCATION CONFIRM ── */}
        {step === "location" && !loading && centerId && (
          <div className="text-center">
            <div className="rounded-lg p-6 mb-6" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${gold}30` }}>
              <p className="font-[var(--font-hp-body)] text-white/50 text-xs uppercase tracking-wider mb-2">You&apos;re booking at</p>
              <h3 className="font-[var(--font-hp-display)] uppercase text-white text-xl tracking-wider" style={{ textShadow: `0 0 20px ${gold}25` }}>
                {centerName}
              </h3>
              <p className="font-[var(--font-hp-body)] text-white/40 text-sm mt-1">
                {LOCATIONS.find(l => l.id === centerId)?.address}
              </p>
            </div>
            <button
              onClick={() => setShowLocationConfirm(true)}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}
            >
              Continue
            </button>
            <button
              onClick={() => {
                const other = LOCATIONS.find(l => l.id !== centerId)!;
                setCenterId(other.id); setCenterName(other.name); setHasOldTime(other.hasOldTime);
              }}
              className="mt-3 font-[var(--font-hp-body)] text-white/40 text-xs cursor-pointer hover:text-white/60 transition-colors"
            >
              Switch to {LOCATIONS.find(l => l.id !== centerId)?.name}
            </button>
          </div>
        )}

        {/* ── DATE + TIME (Calendar) ── */}
        {step === "date" && !loading && (
          <div>
            <div className="text-center mb-4">
              <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-1">Pick a Date</h2>
              <p className="font-[var(--font-hp-body)] text-white/40 text-sm">{playerCount} bowlers &bull; {getLaneTypes(centerId).find(l => l.key === laneType)?.label}</p>
            </div>

            <div className="max-w-sm mx-auto">
            {/* Calendar — collapses to chip once date is selected */}
            {!selectedDate ? (
              <>
                {/* Month navigation */}
                <div className="flex items-center justify-between mb-4">
                  <button onClick={() => { if (calMonth === 0) { setCalMonth(11); setCalYear(calYear - 1); } else setCalMonth(calMonth - 1); }}
                    className="text-white/50 hover:text-white p-2 cursor-pointer">&larr;</button>
                  <span className="font-[var(--font-hp-body)] text-white font-bold text-sm">{monthName}</span>
                  <button onClick={() => { if (calMonth === 11) { setCalMonth(0); setCalYear(calYear + 1); } else setCalMonth(calMonth + 1); }}
                    className="text-white/50 hover:text-white p-2 cursor-pointer">&rarr;</button>
                </div>

                {/* Day headers */}
                <div className="grid grid-cols-7 mb-1">
                  {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(d => (
                    <div key={d} className="text-center text-[11px] text-white/30 py-1">{d}</div>
                  ))}
                </div>

                {/* Calendar grid */}
                <div className="grid grid-cols-7 gap-1">
                  {Array.from({ length: firstDay }).map((_, i) => <div key={`pad-${i}`} />)}
                  {Array.from({ length: daysInMonth }).map((_, i) => {
                    const day = i + 1;
                    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                    const isOpen = openDateSet.has(dateStr);
                    const today = new Date();
                    const tStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
                    const isPast = dateStr < tStr;
                    return (
                      <button
                        key={day}
                        disabled={!isOpen || isPast}
                        onClick={() => { setSelectedDate(dateStr); setSelectedTime(""); setTimeout(() => timePickerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                        className={`aspect-square rounded-lg text-sm font-medium transition-all duration-150 ${
                          isOpen && !isPast
                            ? "bg-[#00E2E5]/15 text-[#00E2E5] hover:bg-[#00E2E5]/30 cursor-pointer"
                            : "text-white/20 cursor-not-allowed"
                        }`}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center gap-2 mb-3">
                <button
                  onClick={() => { setSelectedDate(""); setSelectedTime(""); }}
                  className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-[var(--font-hp-body)] font-bold cursor-pointer transition-all hover:scale-105"
                  style={{ backgroundColor: cyan, color: "#0a1628" }}
                >
                  {new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                  <svg className="w-3.5 h-3.5 opacity-60" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                </button>
                <span className="font-[var(--font-hp-body)] text-white/30 text-[10px]">tap to change</span>
              </div>
            )}

            {/* Time picker — hour + minute selectors */}
            {selectedDate && (
              <div ref={timePickerRef}>
                <h3 className="font-[var(--font-hp-body)] text-white/60 text-sm mb-3 text-center">Select a Time</h3>
                {filteredTimeSlots.length === 0 ? (
                  <p className="font-[var(--font-hp-body)] text-white/40 text-sm text-center py-4">
                    {isToday ? "No more times available today. Try tomorrow." : "No times available for this date."}
                  </p>
                ) : (() => {
                  // Group available times by hour
                  const hours = [...new Set(filteredTimeSlots.map(t => t.split(":")[0]))];
                  const selectedHour = selectedTime ? selectedTime.split(":")[0] : "";
                  const minutesForHour = selectedHour ? filteredTimeSlots.filter(t => t.startsWith(selectedHour + ":")) : [];
                  return (
                    <>
                      {/* Hour selector — collapses to chip once selected */}
                      {!selectedHour ? (
                        <>
                          <p className="font-[var(--font-hp-body)] text-white/30 text-[10px] uppercase tracking-widest mb-2 text-center">Hour</p>
                          <div className="flex flex-wrap justify-center gap-2 mb-4">
                            {hours.map(h => {
                              const hr = parseInt(h, 10);
                              const ampm = hr >= 12 ? "PM" : "AM";
                              const display = `${hr % 12 || 12} ${ampm}`;
                              return (
                                <button
                                  key={h}
                                  onClick={() => {
                                    const firstSlot = filteredTimeSlots.find(t => t.startsWith(h + ":"));
                                    if (firstSlot) setSelectedTime(firstSlot);
                                  }}
                                  className="rounded-lg px-4 py-2.5 text-sm font-[var(--font-hp-body)] font-bold transition-all cursor-pointer"
                                  style={{ backgroundColor: "rgba(7,16,39,0.5)", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.1)" }}
                                >
                                  {display}
                                </button>
                              );
                            })}
                          </div>
                        </>
                      ) : (
                        <div className="flex items-center justify-center gap-2 mb-3">
                          <button
                            onClick={() => setSelectedTime("")}
                            className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-[var(--font-hp-body)] font-bold cursor-pointer transition-all hover:scale-105"
                            style={{ backgroundColor: gold, color: "#0a1628" }}
                          >
                            {(() => { const hr = parseInt(selectedHour, 10); return `${hr % 12 || 12} ${hr >= 12 ? "PM" : "AM"}`; })()}
                            <svg className="w-3.5 h-3.5 opacity-60" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                          </button>
                          <span className="font-[var(--font-hp-body)] text-white/30 text-[10px]">tap to change</span>
                        </div>
                      )}

                      {/* Minute selector — shows after hour is picked */}
                      {selectedHour && minutesForHour.length > 1 && (
                        <>
                          <p className="font-[var(--font-hp-body)] text-white/30 text-[10px] uppercase tracking-widest mb-2 text-center">Minutes</p>
                          <div className="flex justify-center gap-2 mb-4">
                            {minutesForHour.map(t => {
                              const min = t.split(":")[1];
                              const isActive = t === selectedTime;
                              return (
                                <button
                                  key={t}
                                  onClick={() => setSelectedTime(t)}
                                  className="rounded-lg px-5 py-2.5 text-sm font-[var(--font-hp-body)] font-bold transition-all cursor-pointer"
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

                      {/* Selected time display */}
                      {selectedTime && (
                        <p className="font-[var(--font-hp-display)] text-center text-2xl mb-4" style={{ color: gold }}>
                          {formatTimeStr(selectedTime)}
                        </p>
                      )}
                    </>
                  );
                })()}

                {selectedTime && (
                  <button
                    onClick={fetchOffersAndGoToLaneType}
                    className="w-full mt-2 py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
                    style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}
                  >
                    See Available Packages
                  </button>
                )}
              </div>
            )}
            </div>

            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer">&larr; Back</button>
          </div>
        )}

        {/* ── PLAYERS ── */}
        {step === "players" && !loading && (
          <div className="text-center">
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-2">How Many Bowlers?</h2>
            <p className="font-[var(--font-hp-body)] text-white/40 text-sm mb-6">Up to 6 per lane</p>
            <div className="flex items-center justify-center gap-6 mb-8">
              <button onClick={() => setPlayerCount(Math.max(1, playerCount - 1))}
                className="w-14 h-14 rounded-full flex items-center justify-center text-2xl text-white cursor-pointer transition-all hover:scale-105"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}30` }}>-</button>
              <span className="font-[var(--font-hp-display)] text-white text-5xl" style={{ color: gold }}>{playerCount}</span>
              <button onClick={() => setPlayerCount(Math.min(24, playerCount + 1))}
                className="w-14 h-14 rounded-full flex items-center justify-center text-2xl text-white cursor-pointer transition-all hover:scale-105"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}30` }}>+</button>
            </div>
            <button onClick={fetchDatesAndGoToDate}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}>Continue</button>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}

        {/* ── LANE TYPE ── */}
        {step === "lane-type" && !loading && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Choose Your Experience</h2>
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
                              <span className="font-[var(--font-hp-body)] text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ backgroundColor: `${lt.accent}30`, color: lt.accent }}>NeoVerse</span>
                              <span className="font-[var(--font-hp-body)] text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ backgroundColor: `${cyan}30`, color: cyan }}>HyperBowling</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Content side */}
                      <div className="flex-1 p-5">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider" style={{ textShadow: `0 0 15px ${lt.accent}25` }}>
                            {lt.label}
                          </h3>
                          {count === 0 && !nextTime && (
                            <span className="font-[var(--font-hp-body)] text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold" style={{ backgroundColor: "rgba(253,91,86,0.2)", color: coral, border: `1px solid ${coral}40` }}>
                              Sold Out
                            </span>
                          )}
                          {count === 0 && nextTime && (
                            <span className="font-[var(--font-hp-body)] text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold" style={{ backgroundColor: "rgba(255,215,0,0.15)", color: gold, border: `1px solid rgba(255,215,0,0.3)` }}>
                              Next: {formatTimeStr(nextTime)}
                            </span>
                          )}
                        </div>
                        <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-3">{lt.desc}</p>

                        {lt.details && (
                          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
                            {lt.details.map(d => (
                              <span key={d} className="flex items-center gap-1.5">
                                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: lt.accent }} />
                                <span className="font-[var(--font-hp-body)] text-white/40 text-xs">{d}</span>
                              </span>
                            ))}
                          </div>
                        )}

                        {count > 0 && (
                          <button
                            onClick={() => { setLaneType(lt.key); trackBowlingStep("Lane Type Selected", { type: lt.label }); setStep("offer"); }}
                            className="font-[var(--font-hp-body)] text-sm font-bold uppercase tracking-wider px-5 py-2.5 rounded-full cursor-pointer transition-all hover:scale-105"
                            style={{ backgroundColor: lt.accent, color: "#0a1628" }}
                          >
                            {count} package{count !== 1 ? "s" : ""} available &rarr;
                          </button>
                        )}
                        {nextTime && count === 0 && (
                          <div className="space-y-2">
                            <p className="font-[var(--font-hp-body)] text-xs text-white/40">
                              Sold out at {formatTimeStr(selectedTime)}
                            </p>
                            <button
                              onClick={() => setPendingTimeSwitch({ laneType: lt.key, laneLabel: lt.label, fromTime: selectedTime, toTime: nextTime })}
                              className="font-[var(--font-hp-body)] text-sm font-bold uppercase tracking-wider px-5 py-2.5 rounded-full cursor-pointer transition-all hover:scale-105"
                              style={{ backgroundColor: gold, color: "#0a1628" }}
                            >
                              Switch to {formatTimeStr(nextTime)} &rarr;
                            </button>
                          </div>
                        )}
                        {isSoldOut && (
                          <span className="font-[var(--font-hp-body)] text-xs font-bold uppercase tracking-wider" style={{ color: coral }}>
                            Not available today
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer">&larr; Back</button>
          </div>
        )}

        {/* ── OFFER ── */}
        {step === "offer" && !loading && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-2 text-center">Choose a Package</h2>
            <p className="font-[var(--font-hp-body)] text-white/40 text-xs text-center mb-4">Showing packages near {formatTimeStr(selectedTime)}</p>
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
                        <span className="absolute top-2 right-2 font-[var(--font-hp-body)] text-[10px] uppercase tracking-wider px-2 py-1 rounded-full font-bold"
                          style={{ backgroundColor: perPerson ? `${coral}90` : `${gold}90`, color: "#fff" }}>
                          {perPerson ? "Per Person" : "Per Lane"}
                        </span>
                      </div>
                    )}
                    <div className="p-4">
                      <h3 className="font-[var(--font-hp-display)] uppercase text-white text-sm tracking-wider mb-1">{offer.Name}</h3>
                      {offer.Description && <p className="font-[var(--font-hp-body)] text-white/50 text-xs mb-3">{stripHtml(offer.Description)}</p>}

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
                                <span className="font-[var(--font-hp-display)] text-white text-sm tracking-wider mb-1">{formatDuration(item.Quantity, item.QuantityType)}</span>
                              )}
                              <span className="font-[var(--font-hp-display)] text-xl mb-1" style={{ color: gold }}>${item.Total.toFixed(2)}</span>
                              {perPerson && (
                                <span className="font-[var(--font-hp-body)] text-white/40 text-[10px]">${perPersonPrice.toFixed(2)}/person</span>
                              )}
                              {!perPerson && (
                                <span className="font-[var(--font-hp-body)] text-white/40 text-[10px]">per lane</span>
                              )}
                              {item.Remaining > 0 && !item.Reason && (
                                <span className="font-[var(--font-hp-body)] text-white/20 text-[10px] mt-1">{item.Remaining} left</span>
                              )}
                              {timeShift && (
                                <span className="font-[var(--font-hp-body)] text-[10px] mt-1" style={{ color: gold }}>at {formatTimeStr(timeShift)}</span>
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
              <p className="font-[var(--font-hp-body)] text-white/40 text-sm text-center py-8">No packages available within an hour of {formatTimeStr(selectedTime)}. Try a different time.</p>
            )}
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer">&larr; Back</button>
          </div>
        )}

        {/* ── EXTRAS ── */}
        {step === "extras" && !loading && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-2 text-center">Level Up Your Visit</h2>
            <p className="font-[var(--font-hp-body)] text-white/40 text-xs text-center mb-6">Add activities to your bowling session</p>

            {/* Bowling time reference */}
            <div className="rounded-lg p-3 mb-6" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1px solid rgba(255,255,255,0.1)" }}>
              <p className="font-[var(--font-hp-body)] text-white/40 text-[10px] uppercase tracking-wider mb-1">Your Bowling Time</p>
              <p className="font-[var(--font-hp-body)] text-white text-sm font-bold">
                {formatTimeStr(selectedTime)} &bull; {selectedOffer?.Name} &bull; {playerCount} bowlers
              </p>
            </div>

            {/* VIP Chips & Salsa included */}
            {selectedOffer && classifyOffer(selectedOffer.Name) === "vip" && (
              <div className="rounded-lg p-4 mb-4 flex items-center gap-3" style={{ backgroundColor: `${gold}08`, border: `1.78px dashed ${gold}25` }}>
                <span className="font-[var(--font-hp-body)] text-sm" style={{ color: gold }}>&#x1f37f;</span>
                <div>
                  <span className="font-[var(--font-hp-body)] text-white font-bold text-sm">Complimentary Chips &amp; Salsa</span>
                  <span className="font-[var(--font-hp-body)] text-white/40 text-xs ml-2">Included with VIP</span>
                </div>
              </div>
            )}

            {/* Shoes toggle */}
            {shoes.length > 0 && (
              <div className="rounded-lg p-4 mb-4" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${cyan}25` }}>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-[var(--font-hp-body)] text-white font-bold text-sm">Bowling Shoes</h3>
                    <p className="font-[var(--font-hp-body)] text-white/40 text-xs">${shoes[0].Price}/person</p>
                  </div>
                  <button onClick={() => setWantShoes(!wantShoes)}
                    className="w-12 h-7 rounded-full transition-all cursor-pointer" style={{ backgroundColor: wantShoes ? coral : "rgba(255,255,255,0.1)" }}>
                    <div className="w-5 h-5 rounded-full bg-white transition-all" style={{ marginLeft: wantShoes ? "26px" : "2px" }} />
                  </button>
                </div>
              </div>
            )}

            {/* BMI Add-ons (FM only) */}
            {centerId === "9172" && (
              <div className="space-y-4 mb-6">
                {BMI_ADDONS.map(addon => {
                  const qty = bmiAddonQty[addon.productId] || 0;
                  const isSelected = qty > 0;
                  const slots = bmiTimeSlots[addon.productId] || [];
                  const selectedIdx = bmiSelectedTime[addon.productId];
                  const isLoadingSlots = bmiLoadingSlots[addon.productId];

                  return (
                    <div
                      key={addon.productId}
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
                          <span className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: addon.accent }}>
                            {addon.shortName}
                          </span>
                        </div>

                        <div className="flex-1 p-4">
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <h3 className="font-[var(--font-hp-body)] text-white font-bold text-sm">{addon.name}</h3>
                            <span className="font-[var(--font-hp-body)] text-sm font-bold shrink-0" style={{ color: addon.accent }}>
                              {addon.perPerson ? `$${addon.price}/person` : `$${addon.price}${addon.maxPerGroup ? ` (up to ${addon.maxPerGroup})` : ""}`}
                            </span>
                          </div>
                          <p className="font-[var(--font-hp-body)] text-white/40 text-xs mb-3">{addon.desc}</p>

                          {/* Add/quantity controls */}
                          {addon.perPerson ? (
                            qty === 0 ? (
                              <button
                                onClick={() => setBmiQty(addon.productId, playerCount)}
                                className="w-full py-2.5 rounded-lg text-xs font-bold font-[var(--font-hp-body)] transition-colors cursor-pointer"
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
                                  <span className="font-[var(--font-hp-body)] text-white/30 text-[10px]">{qty} people</span>
                                </div>
                                <span className="font-[var(--font-hp-body)] text-sm font-bold" style={{ color: addon.accent }}>${(addon.price * qty).toFixed(2)}</span>
                              </div>
                            )
                          ) : (
                            <div className="flex items-center justify-between">
                              <button
                                onClick={() => setBmiQty(addon.productId, qty > 0 ? 0 : 1)}
                                className="px-4 py-2 rounded-lg text-xs font-bold font-[var(--font-hp-body)] transition-colors cursor-pointer"
                                style={{
                                  backgroundColor: isSelected ? addon.accent : "rgba(255,255,255,0.1)",
                                  color: isSelected ? "#0a1628" : "rgba(255,255,255,0.6)",
                                }}
                              >
                                {isSelected ? "Added \u2713" : "Add to Booking"}
                              </button>
                              {isSelected && <span className="font-[var(--font-hp-body)] text-sm font-bold" style={{ color: addon.accent }}>${addon.price.toFixed(2)}</span>}
                            </div>
                          )}

                          {/* Time picker */}
                          {isSelected && (
                            <div className="mt-3 pt-3 border-t border-white/10">
                              {isLoadingSlots ? (
                                <div className="flex items-center gap-2 font-[var(--font-hp-body)] text-white/40 text-xs">
                                  <div className="w-3 h-3 border border-white/30 border-t-white/80 rounded-full animate-spin" />
                                  Loading times...
                                </div>
                              ) : slots.length === 0 ? (
                                <p className="font-[var(--font-hp-body)] text-amber-400/70 text-xs">No times available on this date</p>
                              ) : (
                                <div>
                                  <p className="font-[var(--font-hp-body)] text-white/50 text-[10px] uppercase tracking-wider mb-2">Select a time</p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {(() => {
                                      // Merge bowling time into timeline
                                      const bowlTimeMs = new Date(`${selectedDate}T${selectedTime}:00`).getTime();
                                      const items: { time: number; type: "slot" | "bowling"; idx?: number; slot?: typeof slots[0] }[] = [
                                        ...slots.map((s, idx) => ({ time: parseBmiLocal(s.start).getTime(), type: "slot" as const, idx, slot: s })),
                                        { time: bowlTimeMs, type: "bowling" as const },
                                      ];
                                      items.sort((a, b) => a.time - b.time);

                                      return items.map((item, i) => {
                                        if (item.type === "bowling") {
                                          return (
                                            <span key="bowling" className="px-3 py-1.5 rounded-lg text-xs font-bold font-[var(--font-hp-body)]"
                                              style={{ backgroundColor: `${coral}20`, color: coral, border: `1px solid ${coral}40` }}>
                                              {formatTimeStr(selectedTime)} Bowling
                                            </span>
                                          );
                                        }
                                        return (
                                          <button
                                            key={item.slot!.start}
                                            onClick={() => setBmiSelectedTime(prev => ({ ...prev, [addon.productId]: item.idx! }))}
                                            className="px-3 py-1.5 rounded-lg text-xs font-bold font-[var(--font-hp-body)] transition-all cursor-pointer"
                                            style={{
                                              backgroundColor: selectedIdx === item.idx ? addon.accent : "rgba(7,16,39,0.5)",
                                              color: selectedIdx === item.idx ? "#0a1628" : "rgba(255,255,255,0.6)",
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

            <button onClick={goToReview}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}>Review Order</button>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}

        {/* ── REVIEW ── */}
        {step === "review" && !loading && cartSummary && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Order Summary</h2>
            <div className="rounded-lg p-5 mb-6" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${gold}30` }}>
              <div className="space-y-2 mb-4 pb-4 border-b border-white/10">
                <div className="flex justify-between">
                  <span className="font-[var(--font-hp-body)] text-white text-sm">{selectedOffer?.Name}</span>
                  <span className="font-[var(--font-hp-body)] text-white text-sm">${selectedTariff?.Price.toFixed(2)}</span>
                </div>
                <p className="font-[var(--font-hp-body)] text-white/50 text-xs">
                  {new Date(calYear, calMonth, parseInt(selectedDate.split("-")[2])).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} at {formatTimeStr(selectedTime)} &bull; {playerCount} bowlers
                </p>
                {wantShoes && shoes.length > 0 && (
                  <div className="flex justify-between mt-1">
                    <span className="font-[var(--font-hp-body)] text-white/70 text-sm">Bowling Shoes x{playerCount}</span>
                    <span className="font-[var(--font-hp-body)] text-white/70 text-sm">${(shoes[0].Price * playerCount).toFixed(2)}</span>
                  </div>
                )}
                {selectedOffer && classifyOffer(selectedOffer.Name) === "vip" && (
                  <div className="flex justify-between mt-1">
                    <span className="font-[var(--font-hp-body)] text-sm" style={{ color: gold }}>Chips &amp; Salsa x{Math.ceil(playerCount / 6)} (per lane)</span>
                    <span className="font-[var(--font-hp-body)] text-sm" style={{ color: gold }}>FREE</span>
                  </div>
                )}
              </div>
              {/* BMI add-ons with prices */}
              {getBmiAddons().length > 0 && (
                <div className="space-y-1 mb-4 pb-4 border-b border-white/10">
                  <p className="font-[var(--font-hp-body)] text-white/40 text-[10px] uppercase tracking-wider mb-2">Add-On Activities</p>
                  {getBmiAddons().map(a => (
                    <div key={a.productId} className="flex justify-between">
                      <span className="font-[var(--font-hp-body)] text-white/70 text-sm">
                        {a.name} {a.selectedTime ? `at ${formatBmiTime(a.selectedTime)}` : ""} {a.perPerson ? `x${a.quantity}` : ""}
                      </span>
                      <span className="font-[var(--font-hp-body)] text-white text-sm">${(a.price * a.quantity).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1 mb-4 pb-4 border-b border-white/10">
                <div className="flex justify-between"><span className="font-[var(--font-hp-body)] text-white/60 text-sm">Subtotal</span><span className="font-[var(--font-hp-body)] text-white text-sm">${cartSummary.TotalItems.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="font-[var(--font-hp-body)] text-white/60 text-sm">Tax</span><span className="font-[var(--font-hp-body)] text-white text-sm">${cartSummary.AddedTaxes.toFixed(2)}</span></div>
                {cartSummary.Fee > 0 && (
                  <div className="flex justify-between"><span className="font-[var(--font-hp-body)] text-white/60 text-sm">Service Fee</span><span className="font-[var(--font-hp-body)] text-white text-sm">${cartSummary.Fee.toFixed(2)}</span></div>
                )}
              </div>
              <div className="flex justify-between">
                <span className="font-[var(--font-hp-body)] text-white font-bold">Total Due</span>
                <span className="font-[var(--font-hp-display)] text-xl" style={{ color: gold }}>${cartSummary.Total.toFixed(2)}</span>
              </div>
            </div>
            <button onClick={() => setStep("details")}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}>Continue to Payment</button>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}

        {/* ── DETAILS ── */}
        {step === "details" && !redirectingToPayment && !loading && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Your Details</h2>
            <div className="space-y-3 mb-6">
              <input type="text" placeholder="Full Name" value={guestName} onChange={e => setGuestName(e.target.value)}
                className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-[var(--font-hp-body)] text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors" />
              <input type="email" placeholder="Email" value={guestEmail} onChange={e => setGuestEmail(e.target.value)}
                className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-[var(--font-hp-body)] text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors" />
              <input type="tel" placeholder="Phone Number" value={guestPhone} onChange={e => setGuestPhone(e.target.value)}
                className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-[var(--font-hp-body)] text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors" />
            </div>
            <button onClick={submitBooking} disabled={loading}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-[#0a1628] cursor-pointer transition-all hover:scale-[1.02] disabled:opacity-50"
              style={{ backgroundColor: gold, boxShadow: `0 0 16px ${gold}30` }}>
              {loading ? "Processing..." : "Pay & Confirm"}
            </button>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
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
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-2">
              Loading Secure Payment
            </h2>
            <p className="font-[var(--font-hp-body)] text-white/50 text-sm">
              Opening secure checkout — please wait...
            </p>
          </div>
        )}
      </section>

      {/* Location confirmation modal */}
      {showLocationConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4" onClick={() => setShowLocationConfirm(false)}>
          <div className="rounded-lg p-6 max-w-sm w-full text-center" style={{ backgroundColor: "#0a1628", border: `1.78px dashed ${coral}40` }} onClick={e => e.stopPropagation()}>
            <h3 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-2">
              Confirm Location
            </h3>
            <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-1">
              You&apos;re booking at:
            </p>
            <p className="font-[var(--font-hp-hero)] font-black uppercase text-white text-xl mb-1" style={{ textShadow: `0 0 20px ${coral}30` }}>
              {centerName}
            </p>
            <p className="font-[var(--font-hp-body)] text-white/40 text-xs mb-6">
              {LOCATIONS.find(l => l.id === centerId)?.address}
            </p>
            <button
              onClick={() => {
                setShowLocationConfirm(false);
                selectLocation(LOCATIONS.find(l => l.id === centerId)!);
              }}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
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
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 px-4" onClick={() => setShowVipUpgrade(false)}>
            <div className="rounded-lg overflow-hidden max-w-md w-full" style={{ backgroundColor: "#0a1628", border: `1.78px dashed ${gold}40` }} onClick={e => e.stopPropagation()}>
              {/* Large video */}
              <div className="relative h-48 overflow-hidden">
                <video autoPlay muted loop playsInline preload="metadata" className="absolute inset-0 w-full h-full object-cover">
                  <source src={`${BLOB}/videos/headpinz-neoverse-v2.mp4`} type="video/mp4" />
                </video>
                <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#0a1628]" />
                <div className="absolute bottom-3 left-4 flex gap-2">
                  <span className="font-[var(--font-hp-body)] text-[10px] uppercase tracking-wider px-2 py-1 rounded-full font-bold" style={{ backgroundColor: `${gold}50`, color: gold }}>NeoVerse</span>
                  <span className="font-[var(--font-hp-body)] text-[10px] uppercase tracking-wider px-2 py-1 rounded-full font-bold" style={{ backgroundColor: `${cyan}50`, color: cyan }}>HyperBowling</span>
                </div>
              </div>

              <div className="p-6 text-center">
                <h3 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-2" style={{ textShadow: `0 0 20px ${gold}30` }}>
                  Upgrade to VIP?
                </h3>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-2">
                  NeoVerse interactive LED walls and HyperBowling LED target scoring in our private VIP suite.
                </p>
                <p className="font-[var(--font-hp-body)] text-white/40 text-xs mb-6">
                  8 VIP lanes &bull; Complimentary Chips &amp; Salsa &bull; Private lounge
                </p>

                <div className="flex gap-3">
                  <button
                    onClick={() => setShowVipUpgrade(false)}
                    className="flex-1 py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer border border-white/20 hover:border-white/40 transition-all"
                  >
                    No Thanks
                  </button>
                  <button
                    onClick={() => {
                      setShowVipUpgrade(false);
                      selectOffer(upgrade.offer, { Id: upgrade.item.ItemId, Name: upgrade.offer.Name, Price: upgrade.item.Total, Duration: formatDuration(upgrade.item.Quantity, upgrade.item.QuantityType) });
                    }}
                    className="flex-1 py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-[#0a1628] cursor-pointer transition-all hover:scale-[1.02]"
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
          onClick={() => setPendingOffer(null)}
        >
          <div
            className="rounded-lg p-6 max-w-sm w-full text-center"
            style={{ backgroundColor: "#0a1628", border: `1.78px dashed ${gold}40` }}
            onClick={e => e.stopPropagation()}
          >
            <h3 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-2">
              Time Change
            </h3>
            <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-4">
              <strong>{pendingOffer.offer.Name}</strong> is not available at {formatTimeStr(selectedTime)} but is available at:
            </p>
            <p className="font-[var(--font-hp-display)] text-2xl mb-6" style={{ color: gold }}>
              {formatTimeStr(pendingOffer.newTime)}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setPendingOffer(null)}
                className="flex-1 py-3 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer border border-white/20 hover:border-white/40 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const { offer, tariff, newTime } = pendingOffer;
                  setPendingOffer(null);
                  selectOffer(offer, tariff, newTime);
                }}
                className="flex-1 py-3 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-[#0a1628] cursor-pointer transition-all hover:scale-[1.02]"
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
          onClick={() => setPendingTimeSwitch(null)}
        >
          <div
            className="rounded-lg p-6 max-w-sm w-full text-center"
            style={{ backgroundColor: "#0a1628", border: `1.78px dashed ${gold}40` }}
            onClick={e => e.stopPropagation()}
          >
            <h3 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-2">
              Switch Time?
            </h3>
            <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-1">
              <strong className="text-white">{pendingTimeSwitch.laneLabel}</strong> is sold out at {formatTimeStr(pendingTimeSwitch.fromTime)}
            </p>
            <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-4">
              The next available time is:
            </p>
            <p className="font-[var(--font-hp-display)] text-3xl mb-6" style={{ color: gold }}>
              {formatTimeStr(pendingTimeSwitch.toTime)}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setPendingTimeSwitch(null)}
                className="flex-1 py-3 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer border border-white/20 hover:border-white/40 transition-all"
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
                className="flex-1 py-3 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-[#0a1628] cursor-pointer transition-all hover:scale-[1.02]"
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
