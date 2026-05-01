"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import HeadPinzNav from "@/components/headpinz/Nav";
import ClickwrapCheckbox from "@/components/booking/ClickwrapCheckbox";
import { CURRENT_POLICY_VERSION } from "@/lib/clickwrap";
import {
  bookableDateRange,
  isKbfBookableDate,
  isKbfPreLaunchPeriod,
  KBF_PROGRAM_START_YMD,
} from "@/lib/kbf-schedule";
import {
  getBookingLocation,
  setBookingLocation,
  syncLocationFromUrl,
} from "@/lib/booking-location";
import { bookAttractionSlot, type BmiProposal } from "@/lib/attractions-data";

/**
 * Kids Bowl Free booking wizard.
 *
 *   1. lookup     — explainer + email/phone form
 *   2. verify     — 6-digit OTP + optional "save phone for SMS 2FA"
 *   3. bowlers    — checkbox cards per kid/adult, with shoe + bumper
 *                   toggles (default ON, prefs auto-fill)
 *   4. center     — FM or Naples
 *   5. date-time  — pick a slot from the KBF web offers (Regular vs VIP)
 *   6. review     — clickwrap + parent contact + go
 *   7. confirm    — server redirect → /hp/book/kids-bowl-free/confirmation
 *
 * Mirrors the bowling wizard (`/hp/book/bowling`) for visual consistency.
 * Lane math, time-window enforcement, and price totals are all handled
 * server-side by /api/kbf/{offers,reserve} so this file stays focused
 * on UX state.
 */

const CORAL = "#fd5b56";
const GOLD = "#FFD700";
const BG = "#0a1628";

// ── QAMF client helpers (verbatim copy from /book/bowling) ─────────────────
// All four QAMF calls (book-for-later, PATCH players, CreateSummary,
// guest/confirm) fire from the wizard CLIENT through the /api/qamf
// catch-all proxy, mirroring bowling's progressive lane-hold UX.
// Session token shuttles via sessionStorage so the lane stays held
// even if the user back-navigates between steps.

const QAMF_API = "/api/qamf";

function getQamfSessionToken(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("qamf_session_token") || "";
}

function setQamfSessionToken(tok: string) {
  if (typeof window === "undefined") return;
  if (tok) sessionStorage.setItem("qamf_session_token", tok);
  else sessionStorage.removeItem("qamf_session_token");
}

/** Custom error from the qamf wrapper that exposes the HTTP status
 *  so callers can map it to a friendly message instead of leaking
 *  raw "QAMF 409" strings into the UI. */
class QamfError extends Error {
  status: number;
  constructor(status: number, message?: string) {
    super(message ?? `QAMF ${status}`);
    this.status = status;
    this.name = "QamfError";
  }
}

/** Translate a thrown error into a user-readable string for the
 *  wizard's error banner. Only friendly text — never raw status
 *  codes or stack-trace strings. */
function friendlyQamfError(err: unknown, fallback: string): string {
  if (err instanceof QamfError) {
    if (err.status === 409) {
      return "That time slot was just taken or your previous hold is still active. Pick another time and try again.";
    }
    if (err.status === 401 || err.status === 403) {
      return "Your session expired. Please refresh and try again.";
    }
    if (err.status === 404) {
      return "We couldn't find that reservation any more. Pick your time again.";
    }
    if (err.status >= 500) {
      return "The reservation system hiccuped. Please try again in a moment.";
    }
    return fallback;
  }
  if (err instanceof Error && err.message && !/^QAMF\s/.test(err.message)) {
    return err.message;
  }
  return fallback;
}

async function qamf(path: string, options?: RequestInit): Promise<unknown> {
  const headers: Record<string, string> = {
    ...((options?.headers as Record<string, string>) || {}),
  };
  const token = getQamfSessionToken();
  if (token) headers["x-sessiontoken"] = token;

  const res = await fetch(`${QAMF_API}/${path}`, { ...options, headers });
  if (!res.ok) throw new QamfError(res.status);

  const tok = res.headers.get("x-sessiontoken");
  if (tok) setQamfSessionToken(tok);

  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── BMI add-ons (verbatim copy of bowling's BMI_ADDONS_BY_CENTER) ─────────
// Same productIds, qamfExtraIds, accent colors, and per-person flags as
// the bowling page so KBF and bowling share BMI infrastructure 1:1.
// Only laser tag + gel blaster surface in KBF (bowling also has shuffly).

const BLOB_BASE = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

interface BmiAddon {
  productId: string;
  name: string;
  shortName: string;
  desc: string;
  price: number;
  perPerson: boolean;
  qamfExtraId: number;
  image: string;
  accent: string;
  maxPerGroup?: number;
}

const BMI_ADDONS_FM: BmiAddon[] = [
  {
    productId: "43370936",
    name: "Nexus Gel Blaster",
    shortName: "Gel Blasters",
    desc: "High-tech blasters, glowing environments, and fast-paced team battles using eco-friendly Gellets.",
    price: 12,
    perPerson: true,
    qamfExtraId: 13751,
    image: `${BLOB_BASE}/images/addons/gelblaster-gtOdWfUsDWYEf72h2aBEytF5GCuZUs.jpg`,
    accent: "#39FF14",
  },
  {
    productId: "43370955",
    name: "Nexus Laser Tag Arena",
    shortName: "Laser Tag",
    desc: "Immersive team-based battles with advanced laser blasters and vests in a glowing arena.",
    price: 10,
    perPerson: true,
    qamfExtraId: 13678,
    image: `${BLOB_BASE}/images/addons/lasertag-uMlQDT8COLcGQVEfVyqgjgUOseIZjI.jpg`,
    accent: "#E41C1D",
  },
];

const BMI_ADDONS_NAP: BmiAddon[] = [
  {
    productId: "7565025",
    name: "Nexus Gel Blaster",
    shortName: "Gel Blasters",
    desc: "High-tech blasters, glowing environments, and fast-paced team battles using eco-friendly Gellets.",
    price: 12,
    perPerson: true,
    qamfExtraId: 23093,
    image: `${BLOB_BASE}/images/addons/gelblaster-gtOdWfUsDWYEf72h2aBEytF5GCuZUs.jpg`,
    accent: "#39FF14",
  },
  {
    productId: "7565567",
    name: "Nexus Laser Tag Arena",
    shortName: "Laser Tag",
    desc: "Immersive team-based battles with advanced laser blasters and vests in a glowing arena.",
    price: 10,
    perPerson: true,
    qamfExtraId: 23091,
    image: `${BLOB_BASE}/images/addons/lasertag-uMlQDT8COLcGQVEfVyqgjgUOseIZjI.jpg`,
    accent: "#E41C1D",
  },
];

const BMI_ADDONS_BY_CENTER: Record<string, { page: string; clientKey?: string; addons: BmiAddon[] }> = {
  "9172": { page: "43370985", clientKey: undefined, addons: BMI_ADDONS_FM },
  "3148": { page: "7583597", clientKey: "headpinznaples", addons: BMI_ADDONS_NAP },
};

interface BmiTimeSlot {
  start: string;
  stop: string;
  name: string;
  freeSpots: number;
  proposal: BmiProposal;
  block: { start: string; stop: string; name: string; freeSpots: number; resourceId: number };
}

interface BmiAddonSelection {
  productId: string;
  name: string;
  shortName: string;
  quantity: number;
  price: number;
  perPerson: boolean;
  selectedTime: string;
  block: BmiTimeSlot["block"] | null;
  proposal: BmiProposal | null;
  qamfExtraId: number;
}

// ── Center metadata ─────────────────────────────────────────────────────────

const CENTERS: { id: string; locationKey: "headpinz" | "naples"; name: string; address: string }[] = [
  {
    id: "9172",
    locationKey: "headpinz",
    name: "HeadPinz Fort Myers",
    address: "14513 Global Pkwy, Fort Myers",
  },
  {
    id: "3148",
    locationKey: "naples",
    name: "HeadPinz Naples",
    address: "8525 Radio Ln, Naples",
  },
];

// ── Types mirroring lib/kbf-prefs.ts ────────────────────────────────────────

interface MemberPref {
  shoeSizeId: number | null;
  shoeSizeLabel: string | null;
  wantShoes: boolean | null;
  wantBumpers: boolean | null;
  lastUsedCenter: string | null;
}
interface Member {
  id: number;
  passId: number;
  relation: "kid" | "family";
  slot: number;
  firstName: string;
  lastName: string;
  birthday: string;
  prefs: MemberPref | null;
}
interface PassWithMembers {
  id: number;
  email: string;
  centerName: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  preferred2fa: "sms" | "email";
  isTest: boolean;
  fpass: boolean;
  members: Member[];
}

// Each card the parent can toggle as a bowler
interface BowlerKey {
  /** "parent" | "kid:passId:slot" | "family:passId:slot" */
  key: string;
  passId: number; // 0 for parent
  memberSlot: number; // 0 for parent
  relation: "parent" | "kid" | "family";
  displayName: string;
  isParent: boolean;
}

interface BowlerSelection {
  selected: boolean;
  wantShoes: boolean;
  shoeSizeId: number | null;
  shoeSizeLabel: string | null;
  /** QAMF shoe-size category id (Adult M/F vs Kids M/F). Required
   *  on `Size: { Id, Name, CategoryId }` for PATCH /players. */
  shoeCategoryId: number | null;
  wantBumpers: boolean;
}

// ── QAMF response types (subset we touch) ──────────────────────────────────
// Each Item is a (tariff, slot) tuple — ItemId doubles as the
// WebOfferTariffId we send on book-for-later. Mirrors the bowling
// page's `interface OfferItem`.

interface QamfOfferItem {
  ItemId: number;
  Quantity: number;
  QuantityType: string;
  Time: string;          // "17:00" — HH:MM ET local
  Total: number;
  Remaining: number;
  Lanes: number;
}
interface QamfOffer {
  OfferId: number;
  Name: string;
  Description?: string;
  Items?: QamfOfferItem[];
}

/** QAMF /offers/extras response — laser tag, gel blasters, etc. */
interface QamfExtra {
  Id: number;
  Name: string;
  Price: number;
  Description?: string;
  ImageUrl?: string;
  ItemType?: string;
  PriceKeyId?: number;
}

// ── Step keys ───────────────────────────────────────────────────────────────

type Step = "lookup" | "verify" | "bowlers" | "datetime" | "offer" | "addons" | "review" | "details" | "submitting";

// ── Component ──────────────────────────────────────────────────────────────

export default function KidsBowlFreePage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Sync ?location=naples on mount so we can preselect the center.
  // KBF auto-detects the center — no UI step. Priority: ?location=
  // query param > sessionStorage from prior page > default Fort Myers.
  useEffect(() => {
    syncLocationFromUrl();
    const fromUrl = searchParams.get("location");
    let resolved: string | null = null;
    if (fromUrl === "naples") resolved = "3148";
    else if (fromUrl === "fortmyers" || fromUrl === "fort-myers") resolved = "9172";
    else {
      const stored = getBookingLocation();
      if (stored === "naples") resolved = "3148";
      else if (stored === "headpinz") resolved = "9172";
    }
    setCenterId(resolved ?? "9172"); // default Fort Myers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Top-level state ────────────────────────────────────────────
  const [step, setStep] = useState<Step>("lookup");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Lookup + verify
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [channel, setChannel] = useState<"email" | "sms" | null>(null);
  const [maskedDest, setMaskedDest] = useState<string>("");
  const [savePhoneOptIn, setSavePhoneOptIn] = useState(false);
  const [savePhoneValue, setSavePhoneValue] = useState("");

  // Tabbed sign-in (Phone | Email | New) — drives which form
  // LookupStep renders. Kept in the parent so a back-nav from the
  // verify step preserves the user's chosen tab.
  // Tabs: Email (default) | SMS | New. The "New" tab currently shows
  // an external kidsbowlfree.com/bowland CTA — in-app registration is
  // parked behind a feature flag, but /api/kbf/register and the
  // wizard's handleRegister stay wired up for when we re-enable it.
  const [lookupTab, setLookupTab] = useState<"phone" | "email" | "new">("email");
  const [phoneInput, setPhoneInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  // "New" tab — minimum viable KBF registration form. Optional
  // password fields the wizard sends through to /api/kbf/register so
  // the side-effect can also create the account on kidsbowlfree.com.
  const [newPerson, setNewPerson] = useState<{
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    password: string;
    address: string;
    city: string;
    state: string;
    zip: string;
  }>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    password: "",
    address: "",
    city: "",
    state: "FL",
    zip: "",
  });
  const [newKids, setNewKids] = useState<{ firstName: string; lastName: string; birthday: string }[]>([
    { firstName: "", lastName: "", birthday: "" },
  ]);

  // Family roster from /api/kbf/verify
  const [passes, setPasses] = useState<PassWithMembers[]>([]);
  const [bowlerSelections, setBowlerSelections] = useState<Record<string, BowlerSelection>>({});

  // Center + date + offer. `date` defaults to the first bookable
  // option (opening day during pre-launch, today otherwise) so the
  // wizard never lands on a blank date selector.
  const [centerId, setCenterId] = useState<string>("");
  const [date, setDate] = useState<string>(() => bookableDateRange()[0] ?? "");
  // QAMF reservation key returned by book-for-later. Held for ~10
  // minutes by QAMF; if the parent abandons it auto-releases.
  const [reservationKey, setReservationKey] = useState<string>("");
  // Tracks which (offerId, tariffId, time) the held key is for so
  // a re-click on the same selection doesn't fire book-for-later
  // again (which would 409 — QAMF already has a hold for this
  // session at that slot).
  const [heldFor, setHeldFor] = useState<{ offerId: number; tariffId: number; time: string } | null>(null);

  /**
   * Whenever we land on the lookup step (initial mount, back-nav,
   * refresh, sign-out), drop any leftover QAMF/BMI session state
   * so the next sign-in starts clean. Without this a held lane
   * from a previous flow can leak the x-sessiontoken into the
   * next book-for-later and trigger a 409.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (step !== "lookup") return;
    if (typeof window === "undefined") return;
    setReservationKey("");
    setHeldFor(null);
    bmiAddonOrderIdRef.current = null;
    bmiAddonLineIdsRef.current = {};
    sessionStorage.removeItem("qamf_session_token");
    sessionStorage.removeItem("qamf_reservation");
    sessionStorage.removeItem("qamf_confirm_data");
    sessionStorage.removeItem("qamf_bmi_addons");
  }, [step]);

  /**
   * Drop the QAMF session token + any in-flight reservation context.
   * Called when the parent back-navigates to the lookup screen or
   * changes their offer/time selection — without this the leftover
   * x-sessiontoken on the next book-for-later makes QAMF think
   * we're trying to create a second hold in the same session and it
   * answers 409 ("QAMF 409" was the raw leak the user reported).
   */
  const clearReservationState = useCallback(() => {
    setReservationKey("");
    setHeldFor(null);
    bmiAddonOrderIdRef.current = null;
    bmiAddonLineIdsRef.current = {};
    if (typeof window !== "undefined") {
      sessionStorage.removeItem("qamf_session_token");
      sessionStorage.removeItem("qamf_reservation");
      sessionStorage.removeItem("qamf_confirm_data");
      sessionStorage.removeItem("qamf_bmi_addons");
    }
  }, []);
  const [offers, setOffers] = useState<QamfOffer[]>([]);
  const [selectedOfferId, setSelectedOfferId] = useState<number | null>(null);
  const [selectedTariffId, setSelectedTariffId] = useState<number | null>(null);
  const [selectedTime, setSelectedTime] = useState<string>("");
  const [shoeCatalog, setShoeCatalog] = useState<{ id: number; label: string; categoryId: number | null; categoryName: string }[]>([]);

  // BMI add-ons (laser tag + gel blaster) — same data layer the
  // bowling page uses. bmiAddonOrderIdRef holds the shared BMI
  // order id so all add-ons share one bill (matches bowling).
  const [bmiAddonQty, setBmiAddonQty] = useState<Record<string, number>>({});
  const [bmiTimeSlots, setBmiTimeSlots] = useState<Record<string, BmiTimeSlot[]>>({});
  const [bmiSelectedTime, setBmiSelectedTime] = useState<Record<string, number>>({});
  const [bmiLoadingSlots, setBmiLoadingSlots] = useState<Record<string, boolean>>({});
  const bmiAddonOrderIdRef = useRef<string | null>(null);
  const bmiAddonLineIdsRef = useRef<Record<string, string>>({});
  // Paid-shoes state — kept in case we re-enable later, but the
  // wizard no longer surfaces a UI control for it. Always false.
  const [wantPaidShoes] = useState(false);
  const [paidShoeOption] = useState<{ priceKeyId: number; price: number; name: string } | null>(null);

  // Review
  const [clickwrapAccepted, setClickwrapAccepted] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");

  // ── Derived ────────────────────────────────────────────────────
  const preLaunch = useMemo(() => isKbfPreLaunchPeriod(), []);
  const dateOptions = useMemo(() => bookableDateRange(), []);

  // Does any pass have family-pass status? Drives whether the
  // account holder can put themselves on a lane — KBF Regular passes
  // only cover the registered kids; the parent only bowls free if
  // they upgraded to Families Bowl Free.
  const hasFamilyPass = useMemo(() => passes.some((p) => p.fpass), [passes]);

  // Always available so we can render the booking-guest header even
  // when the parent isn't a bowler.
  const accountHolderName = useMemo(() => {
    const primary = passes[0];
    if (!primary) return "";
    return `${primary.firstName} ${primary.lastName}`.trim();
  }, [passes]);

  // Build the bowler list from passes. The account holder is only
  // surfaced as a selectable bowler when they have Families Bowl Free;
  // otherwise the wizard renders them as the booking guest only.
  const bowlerKeys: BowlerKey[] = useMemo(() => {
    if (passes.length === 0) return [];
    const list: BowlerKey[] = [];
    const primary = passes[0];
    if (hasFamilyPass) {
      list.push({
        key: "parent",
        passId: 0,
        memberSlot: 0,
        relation: "parent",
        displayName: `${primary.firstName} ${primary.lastName}`.trim(),
        isParent: true,
      });
    }
    for (const p of passes) {
      for (const m of p.members) {
        list.push({
          key: `${m.relation}:${p.id}:${m.slot}`,
          passId: p.id,
          memberSlot: m.slot,
          relation: m.relation,
          displayName: `${m.firstName} ${m.lastName}`.trim(),
          isParent: false,
        });
      }
    }
    return list;
  }, [passes, hasFamilyPass]);

  // Initialize bowler selections when passes load. Defaults:
  //   selected: false (parent must opt themselves in)
  //   wantShoes: from saved pref OR true (auto-add all)
  //   wantBumpers: from saved pref OR true for kids, false for adults
  useEffect(() => {
    if (passes.length === 0) return;
    const init: Record<string, BowlerSelection> = {};
    const primary = passes[0];
    // Only seed a "parent" selection when they have Families Bowl Free.
    // Without it, the parent only appears as the booking guest.
    if (hasFamilyPass) {
      init["parent"] = {
        selected: false,
        wantShoes: true,
        shoeSizeId: null,
        shoeSizeLabel: null,
        shoeCategoryId: null,
        wantBumpers: false,
      };
    }
    for (const p of passes) {
      for (const m of p.members) {
        const key = `${m.relation}:${p.id}:${m.slot}`;
        const pref = m.prefs;
        init[key] = {
          selected: false,
          wantShoes: pref?.wantShoes ?? true,
          shoeSizeId: pref?.shoeSizeId ?? null,
          shoeSizeLabel: pref?.shoeSizeLabel ?? null,
          shoeCategoryId: null,
          wantBumpers: pref?.wantBumpers ?? (m.relation === "kid"),
        };
      }
    }
    setBowlerSelections(init);

    // Pre-fill guest info from the primary pass.
    setGuestName(`${primary.firstName} ${primary.lastName}`.trim());
    setGuestEmail(primary.email);
    setGuestPhone(primary.phone ?? "");
  }, [passes, hasFamilyPass]);

  const selectedBowlers = useMemo(
    () => bowlerKeys.filter((b) => bowlerSelections[b.key]?.selected),
    [bowlerKeys, bowlerSelections],
  );
  const playerCount = selectedBowlers.length;

  // ── Step transitions ───────────────────────────────────────────

  /**
   * Phone/Email tab → POST /api/kbf/lookup. Resolves the contact
   * value from whichever tab is active so the parent typing into
   * a tab's specific field doesn't have to be mirrored into a
   * shared `contact` state.
   */
  const handleLookup = useCallback(async () => {
    const tabContact =
      lookupTab === "phone" ? phoneInput.replace(/\D/g, "") : emailInput.trim();
    if (!tabContact) {
      setError(lookupTab === "phone" ? "Enter your phone" : "Enter your email");
      return;
    }
    if (lookupTab === "phone" && tabContact.length < 10) {
      setError("Enter a 10-digit phone");
      return;
    }
    if (lookupTab === "email" && !tabContact.includes("@")) {
      setError("Enter a valid email");
      return;
    }
    setContact(tabContact);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/kbf/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: tabContact }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        // SMS-first miss: KBF's CSV doesn't include parent phone
        // numbers, so a phone lookup will fail until the family has
        // booked at least once via Email and opted into SMS via the
        // "save phone for faster login" toggle on the verify step.
        // Surface that explanation + nudge them to Email rather than
        // the generic "no account found" message.
        if (lookupTab === "phone" && res.status === 404) {
          setError(
            "Kids Bowl Free doesn't share phone numbers with us by default, so SMS won't work for your first reservation. Use Email this time — you'll be able to save your phone for faster SMS login at the next step.",
          );
          setLookupTab("email");
          return;
        }
        setError(data.error || "Lookup failed");
        return;
      }
      // Test-account / opt-in bypass — skip OTP and proceed straight to bowlers.
      if (data.bypass) {
        setPasses(data.passes ?? []);
        setStep("bowlers");
        return;
      }
      setChannel(data.channel ?? "email");
      setMaskedDest(data.maskedDestination ?? "");
      setStep("verify");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  }, [emailInput, lookupTab, phoneInput]);

  /**
   * "New" tab → POST /api/kbf/register. On success the route returns
   * the same `passes` payload as /api/kbf/verify so we can drop into
   * the bowlers step without an OTP round-trip. Side-effect: also
   * creates the account on kidsbowlfree.com when password is set.
   */
  const handleRegister = useCallback(async () => {
    if (!newPerson.firstName.trim() || !newPerson.lastName.trim()) {
      setError("Parent name required");
      return;
    }
    if (!newPerson.email.includes("@")) {
      setError("Valid email required");
      return;
    }
    if (newPerson.phone.replace(/\D/g, "").length < 10) {
      setError("Valid 10-digit phone required");
      return;
    }
    const cleanKids = newKids.filter((k) => k.firstName.trim());
    if (cleanKids.length === 0) {
      setError("Add at least one kid");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/kbf/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          centerId: centerId || "9172",
          parent: newPerson,
          kids: cleanKids,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Registration failed");
        return;
      }
      setPasses(data.passes ?? []);
      setStep("bowlers");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }, [centerId, newKids, newPerson]);

  const handleVerify = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        contact: contact.trim(),
        code: code.trim(),
      };
      if (savePhoneOptIn && savePhoneValue) {
        body.savePhone = { phone: savePhoneValue.trim() };
      }
      const res = await fetch("/api/kbf/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.verified) {
        setError(data.error || "Incorrect code");
        return;
      }
      setPasses(data.passes ?? []);
      setStep("bowlers");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }, [contact, code, savePhoneOptIn, savePhoneValue]);

  // No center step — auto-resolve on mount. After the bowlers step we
  // jump straight into datetime (calendar + tariff cards + time grid).
  // Default date = first bookable date (which is opening day during
  // the pre-launch promo, then today + 0/1/2 once we're past launch).

  const loadOffers = useCallback(
    async (chosenCenterId: string, chosenDate: string, chosenTime?: string) => {
      setBusy(true);
      setError(null);
      try {
        const tParam = chosenTime ? `&time=${encodeURIComponent(chosenTime)}` : "";
        const url = `/api/kbf/offers?center=${chosenCenterId}&date=${encodeURIComponent(chosenDate)}&players=${playerCount || 1}${tParam}`;
        const res = await fetch(url, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Couldn't load offers");
          setOffers([]);
          return;
        }
        if (data.gateReason) {
          setError(data.gateReason);
          setOffers([]);
          return;
        }
        setOffers(Array.isArray(data.offers) ? data.offers : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load offers");
        setOffers([]);
      } finally {
        setBusy(false);
      }
    },
    [playerCount],
  );

  /**
   * Lazy-load the QAMF shoe-size catalog. Captures the QAMF
   * CategoryId on each size so the reserve route can send the
   * complete `Size: { Id, Name, CategoryId }` object QAMF expects on
   * PATCH /players (rather than the partial { Id, Name } that QAMF
   * may sometimes treat as a free-text size).
   *
   * Naples currently returns an empty CategoriesShoesSizes array
   * (verified by probing QAMF directly) — fall back to Fort Myers'
   * catalog when the chosen center is empty so the dropdown still
   * populates. Shoe size ids are universal across QAMF centers.
   */
  const loadShoeCatalog = useCallback(async (chosenCenterId: string) => {
    type ShoeRow = { id: number; label: string; categoryId: number | null; categoryName: string };
    const fetchCatalog = async (cid: string): Promise<ShoeRow[]> => {
      const res = await fetch(`/api/qamf/centers/${cid}/ShoesSize`, { cache: "no-store" });
      if (!res.ok) return [];
      const data = await res.json();
      const flat: ShoeRow[] = [];
      const cats: Array<{ Id?: number; DisplayName?: string; Active?: boolean; ShoesSize?: unknown }> =
        data?.CategoriesShoesSizes || [];
      for (const c of cats) {
        if (c.Active === false) continue;
        const sizes = Array.isArray(c.ShoesSize) ? c.ShoesSize : [];
        for (const s of sizes) {
          if (typeof s === "object" && s && "Id" in s && "Name" in s) {
            const obj = s as { Id?: number; Name?: string };
            if (typeof obj.Id === "number" && typeof obj.Name === "string") {
              flat.push({
                id: obj.Id,
                label: obj.Name,
                categoryId: typeof c.Id === "number" ? c.Id : null,
                categoryName: c.DisplayName ?? "",
              });
            }
          }
        }
      }
      return flat;
    };
    try {
      let list = await fetchCatalog(chosenCenterId);
      if (list.length === 0 && chosenCenterId !== "9172") {
        // Naples (or any future empty-catalog center) → fall back
        // to Fort Myers. Shoe size ids are universal in QAMF.
        list = await fetchCatalog("9172");
      }
      setShoeCatalog(list);
    } catch {
      // Non-fatal — shoe size remains a free-text label.
    }
  }, []);

  /**
   * Pre-fetch the shoe catalog the moment we hit the bowlers step
   * and we know the center. Before this effect, the catalog was only
   * loaded on bowlers-continue, which left the size dropdown empty
   * on first paint and only populated after navigating away + back.
   */
  useEffect(() => {
    if (step !== "bowlers") return;
    if (shoeCatalog.length > 0) return;
    if (!centerId) return;
    void loadShoeCatalog(centerId);
  }, [step, centerId, shoeCatalog.length, loadShoeCatalog]);

  /**
   * From bowlers → datetime. Auto-defaults the date to the first
   * bookable option (opening day during pre-launch, today otherwise)
   * and pulls the shoe catalog so the bowler-edit form on the
   * confirmation page can render saved sizes. Offers are NOT fetched
   * yet — that happens after the user picks a specific time, so QAMF
   * returns matching Items at that time (mirrors the bowling flow).
   */
  const handleBowlersContinue = useCallback(async () => {
    if (selectedBowlers.length === 0) {
      setError("Pick at least one bowler");
      return;
    }
    setError(null);
    const resolvedCenter = centerId || "9172";
    const resolvedDate = date || dateOptions[0] || "";
    if (!resolvedDate) {
      setError("No bookable dates right now. Check back tomorrow.");
      return;
    }
    setCenterId(resolvedCenter);
    setDate(resolvedDate);
    const center = CENTERS.find((c) => c.id === resolvedCenter);
    if (center) setBookingLocation(center.locationKey);
    await loadShoeCatalog(resolvedCenter);
    setStep("datetime");
  }, [centerId, date, dateOptions, loadShoeCatalog, selectedBowlers.length]);

  /**
   * From datetime → offer. Probes QAMF at the user-selected time so
   * it returns Items[] with the matching tariff slot. Goes to the
   * offer step where the parent picks Regular vs VIP.
   */
  const handleDatetimeContinue = useCallback(async () => {
    if (!date || !selectedTime) {
      setError("Pick a date and time");
      return;
    }
    setError(null);
    setSelectedOfferId(null);
    setSelectedTariffId(null);
    await loadOffers(centerId, date, selectedTime);
    setStep("offer");
  }, [centerId, date, loadOffers, selectedTime]);

  /**
   * From offer → addons. Now mirrors bowling's progressive flow:
   *   1. POST book-for-later to QAMF (lane is held immediately)
   *   2. Fetch extras + paid-shoe option for the addons step
   *
   * The reservationKey + sessionToken stick around in component +
   * sessionStorage state so subsequent steps reuse them and the
   * Confirm submit can fire PATCH players + guest/confirm against
   * the SAME held lane (no double-create).
   */
  const handleOfferContinue = useCallback(async () => {
    if (!selectedOfferId || !selectedTariffId || !selectedTime) {
      setError("Pick a package");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // ── 1. book-for-later — mirrors bowling's selectOffer call.
      // Skip the QAMF call entirely if we already hold a lane for
      // this exact (offer, tariff, time) — re-clicking Continue
      // shouldn't ask QAMF for a second hold (409 territory).
      const sameSelection =
        reservationKey &&
        heldFor &&
        heldFor.offerId === selectedOfferId &&
        heldFor.tariffId === selectedTariffId &&
        heldFor.time === selectedTime;
      if (!sameSelection) {
        const fireHold = async (): Promise<{ ReservationKey?: string } | null> => {
          return (await qamf(
            `centers/${centerId}/reservations/temporary-request/book-for-later`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                DateFrom: `${date}T${selectedTime}`,
                WebOfferId: selectedOfferId,
                WebOfferTariffId: selectedTariffId,
                PlayersList: [{ TypeId: 1, Number: playerCount || 1 }],
              }),
            },
          )) as { ReservationKey?: string } | null;
        };

        try {
          let reservation: { ReservationKey?: string } | null;
          try {
            reservation = await fireHold();
          } catch (err) {
            // 409 = QAMF still has the prior hold tied to our
            // x-sessiontoken from a previous successful pick. Drop
            // the token (fresh session) + retry once before giving
            // up. Any other status surfaces immediately.
            if (err instanceof QamfError && err.status === 409) {
              if (typeof window !== "undefined") {
                sessionStorage.removeItem("qamf_session_token");
              }
              setReservationKey("");
              setHeldFor(null);
              reservation = await fireHold();
            } else {
              throw err;
            }
          }
          if (!reservation?.ReservationKey) {
            throw new Error("Reservation key missing in QAMF response");
          }
          setReservationKey(reservation.ReservationKey);
          setHeldFor({
            offerId: selectedOfferId!,
            tariffId: selectedTariffId!,
            time: selectedTime,
          });
        } catch (err) {
          setError(friendlyQamfError(err, "Couldn't hold the lane"));
          setBusy(false);
          return;
        }
      }

      // Add-ons (laser tag, gel blasters) are now BMI products
      // fetched lazily from the AddonsStep itself when the parent
      // toggles a card on — see `fetchBmiTimeSlots` below. No
      // up-front prefetch.
      setStep("addons");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't continue");
      setStep("addons");
    } finally {
      setBusy(false);
    }
  }, [centerId, date, playerCount, selectedOfferId, selectedTariffId, selectedTime]);

  /**
   * From addons → review. Optional step — the parent can have zero
   * extras and still continue.
   */
  const handleAddonsContinue = useCallback(() => {
    setError(null);
    setStep("review");
  }, []);

  // ── BMI add-on helpers (verbatim port of bowling's pattern) ──────

  /**
   * Conflict-detect a candidate BMI slot against the bowling
   * reservation window. Mirrors bowling's check — bowling reserves
   * a 60-min window starting at the chosen tariff time, and any
   * BMI slot whose [start, stop] overlaps that window conflicts.
   */
  const conflictsWithBowling = useCallback(
    (bmiStart: string, bmiStop: string): boolean => {
      if (!date || !selectedTime) return false;
      const bowlMs = new Date(`${date}T${selectedTime}:00`).getTime();
      const bowlStop = bowlMs + 60 * 60 * 1000; // 60 min default
      const bs = Date.parse(bmiStart);
      const be = Date.parse(bmiStop);
      if (!Number.isFinite(bs) || !Number.isFinite(be)) return false;
      // overlap check
      return bs < bowlStop && be > bowlMs;
    },
    [date, selectedTime],
  );

  /**
   * Fetch BMI proposal time slots for a given add-on productId at
   * the wizard's selected date. Walks 6 sample probe times across
   * the day, dedupes by `block.start`, and filters out anything
   * that conflicts with the bowling window. Mirrors bowling's
   * `fetchBmiTimeSlots` verbatim.
   */
  const fetchBmiTimeSlots = useCallback(
    async (productId: string, qty: number) => {
      const ckCfg = BMI_ADDONS_BY_CENTER[centerId];
      if (!ckCfg || !date) return;
      setBmiLoadingSlots((p) => ({ ...p, [productId]: true }));
      try {
        const allSlots: BmiTimeSlot[] = [];
        const seen = new Set<string>();
        const searchHours = [11, 13, 15, 17, 19, 21];
        for (const hour of searchHours) {
          const h = String(hour).padStart(2, "0");
          const utcTime = `${date}T${h}:00:00.000Z`;
          try {
            const smsUrl = ckCfg.clientKey
              ? `/api/sms?endpoint=dayplanner%2Fdayplanner&clientKey=${ckCfg.clientKey}`
              : "/api/sms?endpoint=dayplanner%2Fdayplanner";
            const res = await fetch(smsUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                productId,
                pageId: ckCfg.page,
                quantity: qty,
                dynamicLines: null,
                date: utcTime,
              }),
            });
            if (!res.ok) continue;
            const data = (await res.json()) as { proposals?: unknown };
            const props = Array.isArray(data?.proposals) ? data.proposals : [];
            for (const rawP of props) {
              const p = rawP as BmiProposal;
              const block = p.blocks?.[0]?.block;
              if (!block) continue;
              if (seen.has(block.start)) continue;
              seen.add(block.start);
              if (conflictsWithBowling(block.start, block.stop)) continue;
              allSlots.push({
                start: block.start,
                stop: block.stop,
                name: block.name,
                freeSpots: block.freeSpots,
                proposal: p,
                block: {
                  start: block.start,
                  stop: block.stop,
                  name: block.name,
                  freeSpots: block.freeSpots,
                  resourceId: Number(block.resourceId) || -1,
                },
              });
            }
          } catch {
            // skip — try next probe
          }
        }
        allSlots.sort((a, b) => a.start.localeCompare(b.start));
        setBmiTimeSlots((p) => ({ ...p, [productId]: allSlots }));
      } catch {
        setBmiTimeSlots((p) => ({ ...p, [productId]: [] }));
      } finally {
        setBmiLoadingSlots((p) => ({ ...p, [productId]: false }));
      }
    },
    [centerId, conflictsWithBowling, date],
  );

  /**
   * Set the qty for a BMI add-on. Auto-fires the slot probe so the
   * time picker has data when the parent expands the card.
   */
  const setBmiQty = useCallback(
    (productId: string, qty: number) => {
      const clamped = Math.max(0, Math.min(20, qty));
      setBmiAddonQty((prev) => {
        const next = { ...prev };
        if (clamped <= 0) delete next[productId];
        else next[productId] = clamped;
        return next;
      });
      if (clamped > 0) void fetchBmiTimeSlots(productId, clamped);
      else {
        setBmiSelectedTime((p) => {
          const n = { ...p };
          delete n[productId];
          return n;
        });
      }
    },
    [fetchBmiTimeSlots],
  );

  /**
   * Hold a chosen time slot on BMI. Creates (or extends) the shared
   * BMI order id so all add-ons land on one bill, mirroring
   * bowling's holdAddonSlot exactly.
   */
  const holdAddonSlot = useCallback(
    async (productId: string, slotIdx: number) => {
      const slots = bmiTimeSlots[productId];
      if (!slots || !slots[slotIdx]) return;
      const slot = slots[slotIdx];
      const qty = bmiAddonQty[productId] || 1;
      const ck = BMI_ADDONS_BY_CENTER[centerId]?.clientKey;
      try {
        // If this addon already had a line, remove it first so
        // re-picking a time doesn't double-bill.
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
          productId,
          qty,
          slot.proposal,
          bmiAddonOrderIdRef.current,
          null,
          ck,
        );
        bmiAddonOrderIdRef.current = rawOrderId;
        if (billLineId) bmiAddonLineIdsRef.current[productId] = billLineId;
        setBmiSelectedTime((p) => ({ ...p, [productId]: slotIdx }));
      } catch (err) {
        console.error("[kbf] holdAddonSlot failed:", err);
      }
    },
    [bmiAddonQty, bmiTimeSlots, centerId],
  );

  /** Build the canonical add-on summary the bowling-confirmation page
   *  reads from sessionStorage to register the BMI bill on the
   *  reservation. Same shape bowling produces. */
  const getBmiAddons = useCallback((): BmiAddonSelection[] => {
    const list = BMI_ADDONS_BY_CENTER[centerId]?.addons ?? [];
    return list
      .filter((a) => (bmiAddonQty[a.productId] ?? 0) > 0)
      .map<BmiAddonSelection>((a) => {
        const slots = bmiTimeSlots[a.productId] ?? [];
        const idx = bmiSelectedTime[a.productId];
        const slot = typeof idx === "number" ? slots[idx] : undefined;
        return {
          productId: a.productId,
          name: a.name,
          shortName: a.shortName,
          quantity: bmiAddonQty[a.productId] || 0,
          price: a.price,
          perPerson: a.perPerson,
          selectedTime: slot?.start ?? "",
          block: slot?.block ?? null,
          proposal: slot?.proposal ?? null,
          qamfExtraId: a.qamfExtraId,
        };
      });
  }, [bmiAddonQty, bmiSelectedTime, bmiTimeSlots, centerId]);

  /**
   * Final submit — fires PATCH players + Cart/CreateSummary +
   * guest/confirm against the lane that was already held by
   * handleOfferContinue. All three calls go straight through
   * /api/qamf from the client (verbatim copy of bowling's pattern)
   * so QAMF sees the lifecycle progress live, not in one server-
   * side burst.
   */
  const submitReservation = useCallback(async () => {
    setBusy(true);
    setStep("submitting");
    setError(null);
    try {
      const offer = offers.find((o) => o.OfferId === selectedOfferId);
      const item = offer?.Items?.find(
        (i) => i.ItemId === selectedTariffId && i.Time === selectedTime,
      );
      if (!offer || !item) {
        setError("Couldn't resolve selected offer");
        setStep("review");
        return;
      }
      if (!reservationKey) {
        setError("Lane hold expired — go back and pick your time again");
        setStep("offer");
        return;
      }

      // Fire-and-forget clickwrap log (non-fatal).
      void fetch("/api/clickwrap/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ts: new Date().toISOString(),
          email: guestEmail,
          phone: guestPhone,
          firstName: guestName.split(" ")[0] || guestName,
          amountCents: 0,
          bookingType: "attractions",
          policyVersion: CURRENT_POLICY_VERSION,
        }),
      }).catch(() => {});

      const dt = `${date}T${selectedTime}`;

      // ── 2. PATCH /reservations/{key}/players ──────────────────
      const playersPayload = selectedBowlers.map((b) => {
        const sel = bowlerSelections[b.key];
        return {
          Name: b.displayName || null,
          ShoeSize: sel.wantShoes && sel.shoeSizeLabel ? sel.shoeSizeLabel : null,
          WantBumpers: sel.wantBumpers === true,
          Size:
            sel.wantShoes && sel.shoeSizeId && sel.shoeSizeLabel
              ? {
                  Id: sel.shoeSizeId,
                  Name: sel.shoeSizeLabel,
                  CategoryId: sel.shoeCategoryId ?? null,
                }
              : null,
        };
      });
      try {
        await qamf(
          `centers/${centerId}/reservations/${encodeURIComponent(reservationKey)}/players`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ Players: playersPayload }),
          },
        );
      } catch (err) {
        // Non-fatal — names/shoes/bumpers can still be edited on the
        // confirmation page. Continue to summary + confirm.
        console.error("[kbf] players PATCH failed (non-fatal):", err);
      }

      // ── 3. POST /Cart/CreateSummary ────────────────────────────
      const shoeQty = selectedBowlers.filter((b) => bowlerSelections[b.key]?.wantShoes).length;
      // BMI add-ons (laser tag / gel blaster) charge through QAMF
      // via their qamfExtraId line items — same pattern bowling
      // uses. The actual booking against BMI is held already by
      // holdAddonSlot; here we just bill QAMF for the extra.
      const bmiAddonsList = BMI_ADDONS_BY_CENTER[centerId]?.addons ?? [];
      const extraItems = bmiAddonsList
        .filter((a) => (bmiAddonQty[a.productId] ?? 0) > 0)
        .map((a) => ({
          PriceKeyId: a.qamfExtraId,
          Quantity: bmiAddonQty[a.productId] || 0,
          UnitPrice: a.price,
          Note: "",
        }));
      const shoesItems =
        shoeQty > 0 && wantPaidShoes && paidShoeOption
          ? [
              {
                PriceKeyId: paidShoeOption.priceKeyId,
                Quantity: shoeQty,
                UnitPrice: paidShoeOption.price,
                Note: "",
              },
            ]
          : [];
      let summary: { Total?: number; AddedTaxes?: number; TotalItems?: number; Fee?: number; AutoGratuity?: number; TotalWithoutTaxes?: number; Deposit?: number } = {};
      try {
        summary = (await qamf(`centers/${centerId}/Cart/CreateSummary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            Time: dt,
            Items: {
              Extra: extraItems,
              FoodAndBeverage: [],
              ShoesSocks: shoesItems,
              WebOffer: {
                Id: offer.OfferId,
                UnitPrice: item.Total,
                WebOfferTariffId: item.ItemId,
              },
            },
            Players: [{ TypeId: 1, Number: selectedBowlers.length || 1 }],
          }),
        })) as typeof summary;
      } catch {
        // Non-fatal — guest/confirm will reject if pricing is bad,
        // and we surface that error to the user.
      }

      // ── 4. POST /reservations/{key}/guest/confirm ──────────────
      const cartItems: Array<{
        Name: string;
        Type: string;
        PriceKeyId: number;
        Quantity: number;
        UnitPrice: number;
      }> = [
        {
          Name: offer.Name,
          Type: "WebOffer",
          PriceKeyId: offer.OfferId,
          Quantity: 1,
          UnitPrice: item.Total,
        },
      ];
      if (shoeQty > 0 && wantPaidShoes && paidShoeOption) {
        cartItems.push({
          Name: "Bowling Shoes",
          Type: "ShoesSocks",
          PriceKeyId: paidShoeOption.priceKeyId,
          Quantity: shoeQty,
          UnitPrice: paidShoeOption.price,
        });
      }
      for (const a of bmiAddonsList) {
        const q = bmiAddonQty[a.productId] ?? 0;
        if (q <= 0) continue;
        cartItems.push({
          Name: a.name,
          Type: "Extras",
          PriceKeyId: a.qamfExtraId,
          Quantity: q,
          UnitPrice: a.price,
        });
      }

      const returnUrl =
        typeof window !== "undefined"
          ? `${window.location.origin}/hp/book/bowling/confirmation?key=${encodeURIComponent(reservationKey)}&center=${centerId}`
          : "";

      const result = (await qamf(
        `centers/${centerId}/reservations/${encodeURIComponent(reservationKey)}/guest/confirm`,
        {
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
              Summary: {
                AddedTaxes: summary.AddedTaxes ?? 0,
                Deposit: summary.Deposit ?? 0,
                Fee: summary.Fee ?? 0,
                Total: summary.Total ?? 0,
                TotalItems: summary.TotalItems ?? 0,
                AutoGratuity: summary.AutoGratuity ?? 0,
                TotalWithoutTaxes: summary.TotalWithoutTaxes ?? 0,
              },
            },
          }),
        },
      )) as { NeedPayment?: boolean; ApprovePayment?: { Url?: string } | null; OperationId?: string | null } | null;

      // (sales_log + member-prefs persistence moves to a /api/kbf
      // server endpoint in a follow-up — booking succeeds without it.)

      // Stash BMI add-ons for the bowling-confirmation page's
      // createBmiBill() — same key + shape bowling itself sets so
      // the confirmation page registers the BMI bill against the
      // reservation, registers the contact, and confirms a
      // zero-balance payment via depositKind=0.
      if (typeof window !== "undefined") {
        const bmiAddons = getBmiAddons().filter((a) => a.selectedTime);
        if (bmiAddons.length > 0) {
          sessionStorage.setItem(
            "qamf_bmi_addons",
            JSON.stringify({
              addons: bmiAddons.map((a) => ({
                productId: a.productId,
                name: a.name,
                shortName: a.shortName,
                quantity: a.quantity,
                price: a.price,
                perPerson: a.perPerson,
                selectedTime: a.selectedTime,
                block: a.block,
                proposal: a.proposal,
              })),
              guest: {
                name: guestName,
                email: guestEmail,
                phone: guestPhone.replace(/\D/g, ""),
              },
              bmiOrderId: bmiAddonOrderIdRef.current,
            }),
          );
        } else {
          sessionStorage.removeItem("qamf_bmi_addons");
        }
      }

      // Stash reservation context for the bowling confirmation page —
      // it reads `qamf_reservation` for the headline summary and
      // `qamf_confirm_data` to know which reservation key to status-poll.
      if (typeof window !== "undefined") {
        const center = CENTERS.find((c) => c.id === centerId);
        sessionStorage.setItem(
          "qamf_reservation",
          JSON.stringify({
            key: reservationKey,
            centerId,
            centerName: center?.name ?? "",
            operationId: result?.OperationId ?? null,
            offer: offer.Name,
            date,
            time: selectedTime,
            players: selectedBowlers.length,
            tariffPrice: item.Total,
            shoes: wantPaidShoes,
            shoePrice: paidShoeOption?.price ?? 0,
            addons: getBmiAddons().map((a) => ({
              name: a.name,
              qty: a.quantity,
              price: a.price,
              time: a.selectedTime,
            })),
            guestName,
            guestEmail,
          }),
        );
        sessionStorage.setItem(
          "qamf_confirm_data",
          JSON.stringify({
            key: reservationKey,
            center: centerId,
            transactionId: "",
          }),
        );
      }

      // For paid bookings (BMI add-ons billed through QAMF Square),
      // pre-fill the Square hosted payment link with the parent's
      // contact info before redirecting. Mirrors bowling's exact
      // call to /api/square/update-redirect — without this the
      // Square page lands with empty buyer fields and the parent
      // has to retype email/phone they already gave us.
      let redirect: string;
      if (result?.NeedPayment && result.ApprovePayment?.Url) {
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
          // Prefill is best-effort — fall through to the raw URL.
        }
        redirect = paymentUrl;
      } else {
        redirect = `/hp/book/bowling/confirmation?key=${encodeURIComponent(reservationKey)}&center=${centerId}`;
      }

      if (typeof window !== "undefined") {
        window.location.href = redirect;
      } else {
        router.push(redirect);
      }
    } catch (err) {
      setError(friendlyQamfError(err, "Reservation failed"));
      setStep("details");
    } finally {
      setBusy(false);
    }
  }, [
    bmiAddonQty,
    bowlerSelections,
    centerId,
    date,
    getBmiAddons,
    guestEmail,
    guestName,
    guestPhone,
    offers,
    reservationKey,
    router,
    selectedBowlers,
    selectedOfferId,
    selectedTariffId,
    selectedTime,
  ]);

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div style={{ backgroundColor: BG }} className="min-h-screen">
      <HeadPinzNav />

      {/* Spacer for fixed nav, mirrors bowling */}
      <div className="pt-28 sm:pt-32" />

      {/* Sticky step nav — same shape + sticky behavior as bowling,
          but the step list is refactored for KBF's flow:
          Sign-in → Bowlers → When → Package → Extras → Review.
          Verify is collapsed under Sign-in (it's just an extension
          of the same step) and Submitting collapses under Review. */}
      <KbfStepBar
        step={step}
        onJump={(target) => {
          // Back to lookup = sign-out semantics. Drop everything
          // QAMF-side so the next sign-in starts clean and won't
          // 409 on book-for-later. Mirrors bowling's clearReservation
          // intent for the lane-held × button.
          if (target === "lookup") clearReservationState();
          setStep(target);
        }}
        reservationHeld={!!reservationKey}
        onClearHeld={clearReservationState}
      />

      <main className="pb-20 px-4 mt-4">
        <div className="max-w-4xl mx-auto">
          <Header step={step} preLaunch={preLaunch} />

          {error && (
            <div className="mb-4 rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}

          {step === "lookup" && (
            <LookupStep
              tab={lookupTab}
              setTab={setLookupTab}
              phoneInput={phoneInput}
              setPhoneInput={setPhoneInput}
              emailInput={emailInput}
              setEmailInput={setEmailInput}
              centerId={centerId}
              onSwitchCenter={() => {
                const other = CENTERS.find((c) => c.id !== centerId);
                if (!other) return;
                setCenterId(other.id);
                setBookingLocation(other.locationKey);
              }}
              busy={busy}
              onLookup={handleLookup}
            />
          )}

          {step === "verify" && (
            <VerifyStep
              channel={channel}
              maskedDest={maskedDest}
              code={code}
              setCode={setCode}
              busy={busy}
              onSubmit={handleVerify}
              onBack={() => setStep("lookup")}
              savePhoneOptIn={savePhoneOptIn}
              setSavePhoneOptIn={setSavePhoneOptIn}
              savePhoneValue={savePhoneValue}
              setSavePhoneValue={setSavePhoneValue}
            />
          )}

          {step === "bowlers" && (
            <BowlersStep
              bowlerKeys={bowlerKeys}
              selections={bowlerSelections}
              setSelections={setBowlerSelections}
              shoeCatalog={shoeCatalog}
              accountHolderName={accountHolderName}
              hasFamilyPass={hasFamilyPass}
              onContinue={handleBowlersContinue}
              onBack={() => setStep("verify")}
            />
          )}

          {step === "datetime" && (
            <DateTimeStep
              date={date}
              setDate={(ymd) => {
                setSelectedTime("");
                setDate(ymd);
              }}
              selectedTime={selectedTime}
              setSelectedTime={setSelectedTime}
              centerId={centerId}
              onContinue={handleDatetimeContinue}
              onBack={() => setStep("bowlers")}
              busy={busy}
            />
          )}

          {step === "offer" && (
            <OfferStep
              offers={offers}
              selectedOfferId={selectedOfferId}
              setSelectedOfferId={setSelectedOfferId}
              selectedTariffId={selectedTariffId}
              setSelectedTariffId={setSelectedTariffId}
              selectedTime={selectedTime}
              date={date}
              busy={busy}
              onContinue={handleOfferContinue}
              onBack={() => setStep("datetime")}
            />
          )}

          {step === "addons" && (
            <AddonsStep
              centerId={centerId}
              bmiAddonQty={bmiAddonQty}
              setBmiQty={setBmiQty}
              bmiTimeSlots={bmiTimeSlots}
              bmiSelectedTime={bmiSelectedTime}
              bmiLoadingSlots={bmiLoadingSlots}
              onPickSlot={holdAddonSlot}
              playerCount={playerCount}
              bowlingTime={selectedTime}
              busy={busy}
              onContinue={handleAddonsContinue}
              onBack={() => setStep("offer")}
            />
          )}

          {step === "review" && (
            <ReviewStep
              centerId={centerId}
              date={date}
              time={selectedTime}
              offerName={offers.find((o) => o.OfferId === selectedOfferId)?.Name ?? ""}
              offerPrice={(() => {
                const offer = offers.find((o) => o.OfferId === selectedOfferId);
                const item = offer?.Items?.find(
                  (i) => i.ItemId === selectedTariffId && i.Time === selectedTime,
                );
                return item?.Total ?? 0;
              })()}
              tariffName={(() => {
                const offer = offers.find((o) => o.OfferId === selectedOfferId);
                const item = offer?.Items?.find(
                  (i) => i.ItemId === selectedTariffId && i.Time === selectedTime,
                );
                return item ? `${item.Quantity} ${item.QuantityType}` : "";
              })()}
              bowlerCount={playerCount}
              bmiAddons={getBmiAddons()}
              shoeQty={selectedBowlers.filter((b) => bowlerSelections[b.key]?.wantShoes).length}
              onContinue={() => setStep("details")}
              onBack={() => setStep("addons")}
            />
          )}

          {step === "details" && (
            <DetailsStep
              dateLabel={
                date
                  ? new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })
                  : ""
              }
              timeLabel={
                selectedTime
                  ? new Date(`${date}T${selectedTime}:00`).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                    })
                  : ""
              }
              centerName={CENTERS.find((c) => c.id === centerId)?.name ?? ""}
              bowlerCount={playerCount}
              guestName={guestName}
              setGuestName={setGuestName}
              guestEmail={guestEmail}
              setGuestEmail={setGuestEmail}
              guestPhone={guestPhone}
              setGuestPhone={setGuestPhone}
              clickwrapAccepted={clickwrapAccepted}
              setClickwrapAccepted={setClickwrapAccepted}
              busy={busy}
              onSubmit={submitReservation}
              onBack={() => setStep("review")}
            />
          )}

          {step === "submitting" && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
              <div className="text-white/70">Reserving your lane…</div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ── Header ─────────────────────────────────────────────────────────────────

/**
 * Compact on/off pill — used inside the bowler-selection card for
 * "Need shoes" + "Bumpers" toggles. Matches the visual rhythm of the
 * tariff pills below (filled accent when on, faded outline when off).
 */
function PillToggle({
  label,
  on,
  onChange,
  accent,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  accent: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      className="rounded-full px-3 py-2 text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2"
      style={{
        // Inverted on-state — filled accent bg with dark navy text
        // is far more legible at a glance than the faint-tint vs
        // faint-tint distinction we had before. Off-state stays
        // outline-only so the contrast between the two is obvious.
        backgroundColor: on ? accent : "transparent",
        color: on ? "#0a1628" : "rgba(255,255,255,0.55)",
        border: on
          ? `1.5px solid ${accent}`
          : "1.5px solid rgba(255,255,255,0.18)",
      }}
    >
      {/* Checkbox-style glyph — empty square when off, filled
          square with a green checkmark when on. Bright green
          stays legible against the dark navy fill of the box. */}
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center w-4 h-4 rounded-[3px] shrink-0"
        style={{
          backgroundColor: on ? "#0a1628" : "transparent",
          border: on
            ? "1.5px solid #0a1628"
            : "1.5px solid rgba(255,255,255,0.45)",
          color: on ? "#22c55e" : "transparent",
        }}
      >
        <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none">
          <path
            d="M3 8.5L6.5 12L13 4"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span>{label}</span>
    </button>
  );
}

/**
 * Sticky step breadcrumb — same chrome as the /book/bowling step
 * bar (numbered pills, chevrons, sticky positioning under the
 * fixed nav, click-to-jump-back on completed steps).
 *
 * KBF flow has 6 visible steps:
 *   1 Sign-in · 2 Bowlers · 3 When · 4 Package · 5 Extras · 6 Review
 *
 * `verify` is treated as part of "Sign-in" (sub-state of the auth
 * step), and `submitting` is treated as part of "Review".
 */
function KbfStepBar({
  step,
  onJump,
  reservationHeld,
  onClearHeld,
}: {
  step: Step;
  onJump: (s: Step) => void;
  reservationHeld: boolean;
  onClearHeld: () => void;
}) {
  const visible: { key: Step; label: string }[] = [
    { key: "lookup", label: "Sign-in" },
    { key: "bowlers", label: "Bowlers" },
    { key: "datetime", label: "When" },
    { key: "offer", label: "Package" },
    { key: "addons", label: "Extras" },
    { key: "review", label: "Review" },
    { key: "details", label: "Confirm" },
  ];
  // Map sub-states to their parent step for the bar's "current" hit.
  const currentKey: Step =
    step === "verify" ? "lookup" : step === "submitting" ? "details" : step;
  const currentIdx = visible.findIndex((v) => v.key === currentKey);

  return (
    <div className="sticky top-[72px] sm:top-[80px] z-30">
      <div className="border-b border-white/8 bg-[#0a1628]">
        <div className="max-w-4xl mx-auto px-3 py-2.5 relative">
          <div className="flex items-center justify-center gap-0 flex-nowrap">
            {visible.map((s, i) => {
              const isPast = i < currentIdx;
              const isCurrent = i === currentIdx;
              const isFuture = i > currentIdx;
              return (
                <div key={s.key} className="flex items-center min-w-0">
                  <button
                    onClick={() => isPast && onJump(s.key)}
                    disabled={isFuture || isCurrent}
                    type="button"
                    className={`flex items-center gap-1 px-1 py-0.5 rounded text-[11px] font-body font-bold transition-all whitespace-nowrap ${
                      isCurrent
                        ? ""
                        : isPast
                          ? "text-white/60 hover:text-white/90 cursor-pointer"
                          : "text-white/25 cursor-not-allowed"
                    }`}
                    style={{ color: isCurrent ? CORAL : undefined }}
                  >
                    <span
                      className="w-4 h-4 rounded-full text-[10px] flex items-center justify-center font-bold shrink-0"
                      style={{
                        backgroundColor: isCurrent
                          ? CORAL
                          : isPast
                            ? "rgba(255,255,255,0.2)"
                            : "rgba(255,255,255,0.08)",
                        color: isCurrent
                          ? "#fff"
                          : isPast
                            ? "#fff"
                            : "rgba(255,255,255,0.3)",
                      }}
                    >
                      {isPast ? "✓" : i + 1}
                    </span>
                    <span className="hidden md:inline">{s.label}</span>
                  </button>
                  {i < visible.length - 1 && (
                    <span className="text-white/15 px-0.5 text-xs shrink-0">
                      &rsaquo;
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {/* Held-lane indicator with × to manually drop the QAMF
              hold + session token — mirrors bowling's clearReservation
              escape hatch on its sticky step bar. */}
          {reservationHeld && (
            <span
              className="hidden sm:inline-flex items-center gap-1 font-body text-[10px] px-2 py-0.5 rounded-full shrink-0 absolute right-3 top-1/2 -translate-y-1/2"
              style={{
                backgroundColor: "rgba(255,215,0,0.10)",
                color: GOLD,
                border: `1px solid ${GOLD}40`,
              }}
            >
              Lane held
              <button
                type="button"
                onClick={onClearHeld}
                aria-label="Drop the held lane"
                className="ml-0.5 text-white/40 hover:text-white"
              >
                ×
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Header({ step, preLaunch }: { step: Step; preLaunch: boolean }) {
  const stepLabels: Record<Step, string> = {
    lookup: "Sign in",
    verify: "Verify",
    bowlers: "Who's bowling?",
    datetime: "When do you want to bowl?",
    offer: "Choose a package",
    addons: "Level up your visit",
    review: "Order summary",
    details: "Your details",
    submitting: "Confirming…",
  };
  return (
    <div className="mb-6">
      <div
        className="uppercase font-bold mb-2"
        style={{ color: CORAL, fontSize: "11px", letterSpacing: "3px" }}
      >
        Kids Bowl Free
      </div>
      <h1
        className="font-heading font-black uppercase italic text-white"
        style={{
          fontSize: "clamp(28px, 5vw, 40px)",
          lineHeight: 1.05,
          letterSpacing: "-0.5px",
        }}
      >
        {stepLabels[step]}
      </h1>
      {preLaunch && step === "lookup" && (
        <div
          className="mt-3 rounded-xl px-4 py-3"
          style={{
            backgroundColor: "rgba(255,215,0,0.08)",
            border: "1.78px solid rgba(255,215,0,0.45)",
          }}
        >
          <p className="font-body text-white/85 text-xs sm:text-sm">
            <strong className="text-white">Special — Opening Week.</strong> Book{" "}
            <strong className="text-white">May 14th and 15th</strong> right now.
            Normally Kids Bowl Free reservations open 48 hours in advance.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Step: lookup ───────────────────────────────────────────────────────────

/**
 * Tabbed sign-in (Phone | Email | New) — mirrors the race-pack
 * lookup flow. The Phone/Email tabs both end up at /api/kbf/lookup
 * and route through the OTP verify step. The New tab takes a fresh
 * registration form and POSTs to /api/kbf/register, which writes to
 * Neon immediately (so the family can book today) and best-effort
 * mirrors the signup to kidsbowlfree.com when alley_id + password
 * are configured.
 */
interface NewPersonForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
  address: string;
  city: string;
  state: string;
  zip: string;
}
interface NewKidForm {
  firstName: string;
  lastName: string;
  birthday: string;
}

function LookupStep({
  tab,
  setTab,
  phoneInput,
  setPhoneInput,
  emailInput,
  setEmailInput,
  centerId,
  onSwitchCenter,
  busy,
  onLookup,
}: {
  tab: "phone" | "email" | "new";
  setTab: (t: "phone" | "email" | "new") => void;
  phoneInput: string;
  setPhoneInput: (s: string) => void;
  emailInput: string;
  setEmailInput: (s: string) => void;
  centerId: string;
  onSwitchCenter: () => void;
  busy: boolean;
  onLookup: () => void;
}) {
  const center = CENTERS.find((c) => c.id === centerId);
  const otherCenter = CENTERS.find((c) => c.id !== centerId);
  const formatPhoneDisplay = (raw: string): string => {
    const d = raw.replace(/\D/g, "").slice(0, 10);
    if (d.length < 4) return d;
    if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  };

  return (
    <div className="space-y-4">
      {/* Location confirmation card — same shape bowling shows on
          its first step. Confirms which center the parent is about
          to book at + offers a one-click switch to the other. */}
      {center && (
        <div className="text-center">
          <div
            className="rounded-lg p-5"
            style={{
              backgroundColor: "rgba(7,16,39,0.5)",
              border: `1.78px dashed ${GOLD}30`,
            }}
          >
            <p className="font-body text-white/50 text-xs uppercase tracking-wider mb-2">
              You&apos;re booking at
            </p>
            <h3
              className="font-heading uppercase text-white text-xl tracking-wider"
              style={{ textShadow: `0 0 20px ${GOLD}25` }}
            >
              {center.name}
            </h3>
            <p className="font-body text-white/40 text-sm mt-1">
              {center.address}
            </p>
            {otherCenter && (
              <button
                type="button"
                onClick={onSwitchCenter}
                className="mt-3 font-body text-white/40 text-xs cursor-pointer hover:text-white/70 transition-colors"
              >
                Switch to {otherCenter.name}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7 space-y-4">
      <p className="text-white/65 text-sm leading-relaxed">
        Kids Bowl Free — kids 15 and under bowl two free games per day,
        Mon–Thu open to close, Fri until 5 PM. Sign in below or register
        in under 30 seconds.
      </p>

      {/* Tabs — race-pack style (segmented, accent fill on active) */}
      <div className="flex gap-1 bg-white/5 rounded-lg p-1">
        {(["email", "phone", "new"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setTab(m)}
            className="flex-1 py-2 rounded-md text-xs font-semibold transition-colors uppercase tracking-wider"
            style={{
              backgroundColor: tab === m ? CORAL : "transparent",
              color: tab === m ? "#0a1628" : "rgba(255,255,255,0.45)",
              fontWeight: tab === m ? 800 : 600,
            }}
          >
            {m === "phone" ? "SMS" : m === "new" ? "New" : "Email"}
          </button>
        ))}
      </div>

      {/* Phone tab */}
      {tab === "phone" && (
        <div className="space-y-3">
          <input
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            value={phoneInput}
            onChange={(e) => setPhoneInput(formatPhoneDisplay(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && onLookup()}
            placeholder="(239) 555-1234"
            className="w-full rounded-xl bg-white/5 border border-white/15 px-4 py-3 text-white text-sm text-center tracking-wider placeholder:text-white/25 focus:outline-none focus:border-coral"
            style={{ borderColor: "rgba(253,91,86,0.30)" }}
          />
          <button
            type="button"
            onClick={onLookup}
            disabled={busy || phoneInput.replace(/\D/g, "").length !== 10}
            className="w-full py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-40"
            style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
          >
            {busy ? "Looking up…" : "Send verification code"}
          </button>
        </div>
      )}

      {/* Email tab */}
      {tab === "email" && (
        <div className="space-y-3">
          <input
            type="email"
            autoComplete="email"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onLookup()}
            placeholder="parent@example.com"
            className="w-full rounded-xl bg-white/5 border border-white/15 px-4 py-3 text-white text-sm placeholder:text-white/25 focus:outline-none"
          />
          <button
            type="button"
            onClick={onLookup}
            disabled={busy || !emailInput.includes("@")}
            className="w-full py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-40"
            style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
          >
            {busy ? "Looking up…" : "Send verification code"}
          </button>
        </div>
      )}

      {/* External sign-up CTA — only shown on the "New" tab so it
          doesn't visually attach itself to Email or SMS sign-in. */}
      {tab === "new" && (
        <div
          className="rounded-xl px-4 py-4"
          style={{
            backgroundColor: "rgba(253,91,86,0.05)",
            border: "1px solid rgba(253,91,86,0.20)",
          }}
        >
          <div
            className="font-heading uppercase text-[10px] tracking-[3px] mb-1"
            style={{ color: CORAL }}
          >
            New to Kids Bowl Free?
          </div>
          <p className="text-white/65 text-xs leading-relaxed mb-3">
            Sign up at{" "}
            <a
              href="https://www.kidsbowlfree.com/bowland"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white"
            >
              kidsbowlfree.com/bowland
            </a>{" "}
            — new accounts take about an hour to be reservable here. Once
            you&apos;re registered, come back and use the Email tab to
            sign in.
          </p>
          <a
            href="https://www.kidsbowlfree.com/bowland"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center w-full py-2.5 rounded-full font-body font-bold text-xs uppercase tracking-wider transition-all hover:scale-[1.01]"
            style={{
              backgroundColor: "rgba(253,91,86,0.20)",
              border: `1px solid ${CORAL}60`,
              color: CORAL,
            }}
          >
            Register at kidsbowlfree.com →
          </a>
        </div>
      )}
      </div>
    </div>
  );
}

// ── Step: verify ───────────────────────────────────────────────────────────

function VerifyStep({
  channel,
  maskedDest,
  code,
  setCode,
  busy,
  onSubmit,
  onBack,
  savePhoneOptIn,
  setSavePhoneOptIn,
  savePhoneValue,
  setSavePhoneValue,
}: {
  channel: "email" | "sms" | null;
  maskedDest: string;
  code: string;
  setCode: (s: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onBack: () => void;
  savePhoneOptIn: boolean;
  setSavePhoneOptIn: (b: boolean) => void;
  savePhoneValue: string;
  setSavePhoneValue: (s: string) => void;
}) {
  const channelLabel = channel === "sms" ? "phone" : "email";
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7">
      <p className="text-white/70 text-sm mb-4 leading-relaxed">
        We sent a 6-digit code to your {channelLabel}{" "}
        <strong className="text-white">{maskedDest}</strong>.
      </p>
      <label className="block mb-4">
        <span className="block text-xs uppercase tracking-wider text-white/55 mb-1.5">
          Verification code
        </span>
        <input
          type="text"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          placeholder="123456"
          className="w-full rounded-lg bg-white/[0.05] border border-white/10 px-3 py-3 text-white text-lg font-mono tracking-[0.4em] focus:outline-none focus:border-white/30"
        />
      </label>

      {channel === "email" && (
        <div className="mb-5 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <label className="flex items-start gap-2.5 text-sm text-white/80 cursor-pointer">
            <input
              type="checkbox"
              checked={savePhoneOptIn}
              onChange={(e) => setSavePhoneOptIn(e.target.checked)}
              className="mt-1 accent-coral"
            />
            <span>
              Save my phone for faster login next time (we&apos;ll text the code
              instead of email).
            </span>
          </label>
          {savePhoneOptIn && (
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={savePhoneValue}
              onChange={(e) => setSavePhoneValue(e.target.value)}
              placeholder="(239) 123-4567"
              className="mt-2 w-full rounded-lg bg-white/[0.05] border border-white/10 px-3 py-2 text-white text-sm focus:outline-none focus:border-white/30"
            />
          )}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || code.length !== 6}
          className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50"
          style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
        >
          {busy ? "Verifying…" : "Verify"}
        </button>
      </div>
    </div>
  );
}

// ── Step: bowlers ──────────────────────────────────────────────────────────

function BowlersStep({
  bowlerKeys,
  selections,
  setSelections,
  shoeCatalog,
  accountHolderName,
  hasFamilyPass,
  onContinue,
  onBack,
}: {
  bowlerKeys: BowlerKey[];
  selections: Record<string, BowlerSelection>;
  setSelections: (s: Record<string, BowlerSelection>) => void;
  shoeCatalog: { id: number; label: string; categoryName: string }[];
  accountHolderName: string;
  hasFamilyPass: boolean;
  onContinue: () => void;
  onBack: () => void;
}) {
  const update = (key: string, patch: Partial<BowlerSelection>) => {
    setSelections({ ...selections, [key]: { ...selections[key], ...patch } });
  };
  const selectedCount = bowlerKeys.filter((b) => selections[b.key]?.selected).length;

  // Initials for the avatar pip (e.g. "Ava Test" → "AT").
  const initialsOf = (name: string): string => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    const first = parts[0]?.[0] ?? "";
    const last = parts[parts.length - 1]?.[0] ?? "";
    return (first + last).toUpperCase();
  };

  // Single blue across every bowler card. Lighter shade than the
  // earlier #6b8ec7 so chip + pill text stays readable when sitting
  // on the blue tinted backgrounds — the previous shade blended too
  // much with the navy bg. Action buttons stay coral (page-level CTA).
  const KBF_BLUE = "#8fb3e5";
  const accentFor = (_rel: BowlerKey["relation"]): string => KBF_BLUE;

  // KBF rule: every booking needs at least one kid. Adults (parent
  // with Families Bowl Free + family-pass adults) only get a free
  // lane when they're chaperoning a registered kid. Reflect that in
  // the UI by greying out adult cards until a kid is selected.
  const anyKidSelected = bowlerKeys.some(
    (b) => b.relation === "kid" && selections[b.key]?.selected,
  );

  // Auto-deselect any adults if the user removes the last kid — keeps
  // submitted bowler list consistent with the gating rule above.
  useEffect(() => {
    if (anyKidSelected) return;
    const adults = bowlerKeys.filter(
      (b) => b.relation !== "kid" && selections[b.key]?.selected,
    );
    if (adults.length === 0) return;
    const next = { ...selections };
    for (const a of adults) {
      next[a.key] = { ...next[a.key], selected: false };
    }
    setSelections(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyKidSelected]);

  return (
    <div className="space-y-4">
      {/* Program eyebrow — Kids Bowl Free vs Families Bowl Free.
          Single blue across both tiers; the label tells the parent
          which program tier they're on without piling on chroma. */}
      <div
        className="rounded-2xl px-4 py-3 flex items-center gap-3"
        style={{
          backgroundColor: `${KBF_BLUE}14`,
          border: `1.78px solid ${KBF_BLUE}55`,
        }}
      >
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center font-heading font-black"
          style={{
            backgroundColor: `${KBF_BLUE}26`,
            color: KBF_BLUE,
          }}
        >
          ★
        </div>
        <div className="flex-1 min-w-0">
          <div
            className="font-heading uppercase tracking-[3px] text-[10px] mb-0.5"
            style={{ color: KBF_BLUE }}
          >
            {hasFamilyPass ? "Families Bowl Free" : "Kids Bowl Free"}
          </div>
          <div className="text-white/85 text-sm font-semibold truncate">
            {accountHolderName || "Booking guest"}
          </div>
        </div>
      </div>

      {/* Helper copy + family-pass upgrade nudge */}
      <p className="text-white/65 text-sm leading-relaxed">
        Check who&apos;s bowling. Shoe rental and bumpers default to on — uncheck
        as needed. Saved sizes auto-fill from your last visit.
      </p>
      {!hasFamilyPass && (
        <p className="text-white/45 text-xs leading-relaxed">
          Kids Bowl Free covers your registered kids. Add{" "}
          <a
            href="https://www.kidsbowlfree.com/family.php"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white"
          >
            Families Bowl Free
          </a>{" "}
          to put yourself on a lane too.
        </p>
      )}

      <div className="space-y-2">
        {bowlerKeys.map((b) => {
          const sel = selections[b.key];
          if (!sel) return null;
          const isOn = sel.selected;
          const accent = accentFor(b.relation);
          // Adults need an accompanying kid — KBF coupon covers the
          // kid; the parent / family-pass adult only gets the free
          // lane while chaperoning. Disable the card until at least
          // one kid is selected.
          const isAdult = b.relation !== "kid";
          const adultLocked = isAdult && !anyKidSelected;
          const relationLabel =
            b.relation === "parent"
              ? hasFamilyPass
                ? "Family Pass Adult"
                : "Account holder"
              : b.relation === "kid"
                ? "Kids Bowl Free"
                : "Family Pass Adult";
          return (
            <div
              key={b.key}
              className="rounded-2xl border bg-white/[0.02] transition-all"
              style={{
                borderColor: isOn ? `${accent}80` : "rgba(255,255,255,0.10)",
                backgroundColor: isOn
                  ? `${accent}12`
                  : "rgba(255,255,255,0.025)",
                boxShadow: isOn ? `0 0 22px ${accent}20` : undefined,
                opacity: adultLocked ? 0.45 : 1,
              }}
            >
              {/* Header row — clickable, big tappable area */}
              <button
                type="button"
                onClick={() => {
                  if (adultLocked) return;
                  update(b.key, { selected: !isOn });
                }}
                disabled={adultLocked}
                aria-label={`Toggle bowler ${b.displayName || "unnamed"}`}
                title={adultLocked ? "Add a kid first — adults need a registered kid bowling with them." : undefined}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left disabled:cursor-not-allowed"
              >
                {/* Avatar */}
                <div
                  className="w-11 h-11 rounded-full flex items-center justify-center font-heading font-black text-sm shrink-0"
                  style={{
                    backgroundColor: `${accent}22`,
                    color: accent,
                    border: `1.78px solid ${accent}55`,
                  }}
                >
                  {initialsOf(b.displayName)}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="text-white font-semibold text-sm truncate">
                    {b.displayName || "(no name on file)"}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <span
                      className="inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                      style={{
                        backgroundColor: `${accent}22`,
                        color: accent,
                      }}
                    >
                      {relationLabel}
                    </span>
                    {sel.shoeSizeLabel && (
                      <span className="inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-white/10 text-white/60">
                        Shoe {sel.shoeSizeLabel}
                      </span>
                    )}
                    {sel.wantBumpers && (
                      <span className="inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-white/10 text-white/60">
                        Bumpers
                      </span>
                    )}
                  </div>
                </div>

                {/* State pill — replaces the bare checkbox with a clearer
                    BOWLING / TAP TO ADD pill that mirrors the race-pack
                    "Select" affordance. */}
                <div
                  className="text-[10px] uppercase tracking-[2px] font-bold px-3 py-1.5 rounded-full shrink-0"
                  style={{
                    backgroundColor: isOn ? `${accent}26` : "rgba(255,255,255,0.06)",
                    color: isOn ? accent : "rgba(255,255,255,0.45)",
                    border: isOn
                      ? `1px solid ${accent}80`
                      : "1px solid rgba(255,255,255,0.10)",
                  }}
                >
                  {adultLocked ? "Kid required" : isOn ? "Bowling" : "Add"}
                </div>
              </button>

              {/* Expanded controls — only when selected. Tighter
                  visuals than before: shoe + bumpers as pill toggles
                  side by side; size selector below as a separate row. */}
              {isOn && (
                <div className="border-t border-white/10 px-4 py-3 space-y-2.5">
                  <div className="grid grid-cols-2 gap-2">
                    <PillToggle
                      label="Need shoes"
                      on={sel.wantShoes}
                      onChange={(v) => update(b.key, { wantShoes: v })}
                      accent={accent}
                    />
                    <PillToggle
                      label="Bumpers"
                      on={sel.wantBumpers}
                      onChange={(v) => update(b.key, { wantBumpers: v })}
                      accent={accent}
                    />
                  </div>

                  {sel.wantShoes && shoeCatalog.length > 0 && (
                    <label className="block">
                      <span className="flex items-center justify-between text-[10px] uppercase tracking-wider text-white/45 mb-1">
                        <span>Shoe size</span>
                        <span style={{ color: "#22c55e" }}>$5 + tax</span>
                      </span>
                      <select
                        value={sel.shoeSizeId ?? ""}
                        onChange={(e) => {
                          const id = parseInt(e.target.value, 10);
                          const found = shoeCatalog.find((s) => s.id === id);
                          update(b.key, {
                            shoeSizeId: Number.isFinite(id) ? id : null,
                            shoeSizeLabel: found ? found.label : null,
                          });
                        }}
                        style={{
                          backgroundColor: "#0a1628",
                          color: "#fff",
                          colorScheme: "dark",
                        }}
                        className="w-full rounded-md border border-white/15 px-2 py-1.5 text-sm focus:outline-none focus:border-white/35"
                      >
                        <option value="" style={{ backgroundColor: "#0a1628", color: "#fff" }}>
                          — pick a size —
                        </option>
                        {shoeCatalog.map((s) => (
                          <option
                            key={s.id}
                            value={s.id}
                            style={{ backgroundColor: "#0a1628", color: "#fff" }}
                          >
                            {s.categoryName ? `${s.categoryName}: ` : ""}
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Bowlers with "Need shoes" on but no shoe size picked —
          shoe rental REQUIRES a size on the BMI/QAMF call. List
          out the names so the parent knows who needs a size. */}
      {(() => {
        const missingSizes = bowlerKeys.filter(
          (b) =>
            selections[b.key]?.selected &&
            selections[b.key]?.wantShoes &&
            !selections[b.key]?.shoeSizeId,
        );
        if (missingSizes.length === 0) return null;
        return (
          <div
            className="rounded-xl border px-3 py-2.5 text-xs"
            style={{
              backgroundColor: "rgba(245,158,11,0.08)",
              borderColor: "rgba(245,158,11,0.35)",
              color: "rgba(252,211,77,0.95)",
            }}
          >
            Pick a shoe size for{" "}
            <strong>
              {missingSizes.map((b) => b.displayName || "(unnamed)").join(", ")}
            </strong>{" "}
            before continuing.
          </div>
        );
      })()}

      <div className="text-xs text-white/55 text-center">
        {selectedCount} bowler{selectedCount === 1 ? "" : "s"} selected
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={(() => {
            if (selectedCount === 0) return true;
            // Every selected bowler with shoe rental on must have
            // a size. Mirrors the bowling confirmation page's
            // PATCH /players requirement.
            for (const b of bowlerKeys) {
              const sel = selections[b.key];
              if (!sel?.selected) continue;
              if (sel.wantShoes && !sel.shoeSizeId) return true;
            }
            return false;
          })()}
          className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50"
          style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

// ── Step: datetime (calendar + tariff cards + time grid) ──────────────────

/**
 * Date pills + Center toggle + Regular/VIP cards + time grid in one
 * step. Mirrors the lane-type/offer/date pattern from /book/bowling.
 */
/**
 * Bowling-style calendar + hour drill-down + minute drill-down. Mirrors
 * `/hp/book/bowling`'s `date` step: full-month grid on the left
 * (bookable KBF days highlighted in coral, everything else disabled
 * + dimmed), and a time picker on the right that drills hour →
 * minute. After the parent picks a slot they tap "See available
 * packages" which probes QAMF for offers at that exact time.
 *
 * Hour grid is static — KBF rules are Mon–Thu open-to-close and Fri
 * before 5pm — so we render a static range and let QAMF on the
 * offers fetch tell us if the slot's actually bookable.
 */
function DateTimeStep({
  date,
  setDate,
  selectedTime,
  setSelectedTime,
  centerId,
  onContinue,
  onBack,
  busy,
}: {
  date: string;
  setDate: (s: string) => void;
  selectedTime: string;
  setSelectedTime: (s: string) => void;
  centerId: string;
  onContinue: () => void;
  onBack: () => void;
  busy: boolean;
}) {
  // Anchor the calendar on the program-start month if we haven't
  // picked a date yet, otherwise on the picked date's month.
  const initial = date ? new Date(`${date}T12:00:00`) : new Date(`${KBF_PROGRAM_START_YMD}T12:00:00`);
  const [calMonth, setCalMonth] = useState(initial.getMonth());
  const [calYear, setCalYear] = useState(initial.getFullYear());

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const monthName = new Date(calYear, calMonth).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  // Friday cuts off at 5pm; Mon–Thu run open to close (rendered to
  // 11 PM as a reasonable upper bound, matching bowling's grid).
  const dow = date ? new Date(`${date}T12:00:00`).getDay() : 4; // 0 = Sun
  const isFriday = dow === 5;
  const HOURS = Array.from({ length: 13 }, (_, i) => i + 11); // 11 → 23
  const filteredHours = isFriday ? HOURS.filter((h) => h < 17) : HOURS;
  const MINUTES = ["00", "15", "30", "45"];

  const selectedHour = selectedTime ? selectedTime.split(":")[0] : "";
  const selectedMinute = selectedTime ? selectedTime.split(":")[1] : "";

  const formatHour = (h: number): string => {
    const ampm = h >= 12 ? "PM" : "AM";
    const hr = h % 12 || 12;
    return `${hr} ${ampm}`;
  };

  const formatTime = (t: string): string => {
    if (!t) return "";
    const [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
  };

  const centerName = CENTERS.find((c) => c.id === centerId)?.name ?? "";

  return (
    <div className="space-y-6">
      {/* Header bar — center · date · time summary, mirroring bowling. */}
      <div className="flex flex-wrap items-center justify-center gap-3 text-xs uppercase tracking-wider text-white/55 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5">
        <span style={{ color: CORAL }}>📍 {centerName}</span>
        {date && (
          <>
            <span className="text-white/20">·</span>
            <span>
              📅{" "}
              {new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </span>
          </>
        )}
        {selectedTime && (
          <>
            <span className="text-white/20">·</span>
            <span style={{ color: GOLD }}>🕐 {formatTime(selectedTime)}</span>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* ── Left: Calendar ── */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="text-white/35 text-xs uppercase tracking-[3px] mb-3 text-center">
            Date
          </div>
          <div className="flex items-center justify-between mb-3">
            <button
              type="button"
              onClick={() => {
                if (calMonth === 0) {
                  setCalMonth(11);
                  setCalYear(calYear - 1);
                } else setCalMonth(calMonth - 1);
              }}
              className="text-white/50 hover:text-white p-2"
              aria-label="Previous month"
            >
              ←
            </button>
            <span className="font-body text-white font-bold text-sm">{monthName}</span>
            <button
              type="button"
              onClick={() => {
                if (calMonth === 11) {
                  setCalMonth(0);
                  setCalYear(calYear + 1);
                } else setCalMonth(calMonth + 1);
              }}
              className="text-white/50 hover:text-white p-2"
              aria-label="Next month"
            >
              →
            </button>
          </div>
          <div className="grid grid-cols-7 mb-1">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
              <div key={d} className="text-center text-[12px] text-white/30 py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: firstDay }).map((_, i) => (
              <div key={`pad-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const isBookable = isKbfBookableDate(dateStr);
              const isSelected = dateStr === date;
              return (
                <button
                  key={day}
                  type="button"
                  disabled={!isBookable}
                  onClick={() => {
                    setDate(dateStr);
                    setSelectedTime("");
                  }}
                  className="aspect-square rounded-lg text-sm font-medium transition-all duration-150"
                  style={{
                    backgroundColor: isSelected
                      ? CORAL
                      : isBookable
                        ? "rgba(253,91,86,0.15)"
                        : "transparent",
                    color: isSelected
                      ? "#0a1628"
                      : isBookable
                        ? CORAL
                        : "rgba(255,255,255,0.18)",
                    fontWeight: isSelected ? 800 : 500,
                    cursor: isBookable ? "pointer" : "not-allowed",
                    boxShadow: isSelected ? `0 0 14px ${CORAL}60` : undefined,
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Right: Time picker (hour drill-down → minute drill-down) ── */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          {!date ? (
            <div className="flex items-center justify-center h-full min-h-[200px]">
              <p className="font-body text-white/30 text-sm">Pick a date first</p>
            </div>
          ) : (
            <>
              <div className="text-white/35 text-xs uppercase tracking-[3px] mb-3 text-center">
                Hour
              </div>
              <div className="flex flex-wrap justify-center gap-2 mb-5">
                {filteredHours.map((h) => {
                  const isActive = String(h).padStart(2, "0") === selectedHour;
                  return (
                    <button
                      key={h}
                      type="button"
                      onClick={() => {
                        // Default to :00 when picking an hour; user
                        // can refine in the minute row below.
                        setSelectedTime(`${String(h).padStart(2, "0")}:00`);
                      }}
                      className="rounded-lg px-3 py-2 text-sm font-medium transition-all"
                      style={{
                        backgroundColor: isActive ? GOLD : "rgba(255,215,0,0.10)",
                        color: isActive ? "#0a1628" : GOLD,
                        fontWeight: isActive ? 800 : 500,
                        minWidth: "60px",
                      }}
                    >
                      {formatHour(h)}
                    </button>
                  );
                })}
              </div>

              {selectedHour && (
                <>
                  <div className="text-white/35 text-xs uppercase tracking-[3px] mb-3 text-center">
                    Minutes
                  </div>
                  <div className="flex justify-center gap-2 mb-5">
                    {MINUTES.map((m) => {
                      const isActive = m === selectedMinute;
                      // Friday cap: 16:45 is the latest minute slot.
                      const wouldExceed =
                        isFriday &&
                        selectedHour === "16" &&
                        false; // 16:45 still allowed (under 17:00)
                      const disabled = wouldExceed;
                      return (
                        <button
                          key={m}
                          type="button"
                          disabled={disabled}
                          onClick={() => setSelectedTime(`${selectedHour}:${m}`)}
                          className="rounded-lg px-4 py-2 text-sm font-medium transition-all disabled:opacity-30"
                          style={{
                            backgroundColor: isActive ? GOLD : "rgba(255,215,0,0.10)",
                            color: isActive ? "#0a1628" : GOLD,
                            fontWeight: isActive ? 800 : 500,
                          }}
                        >
                          :{m}
                        </button>
                      );
                    })}
                  </div>

                  {selectedTime && (
                    <div
                      className="text-center text-2xl font-heading font-black"
                      style={{ color: GOLD }}
                    >
                      {formatTime(selectedTime)}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={busy || !date || !selectedTime}
          className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50"
          style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
        >
          {busy ? "Loading…" : "See available packages"}
        </button>
      </div>
    </div>
  );
}

/**
 * Offer step — fetched after the parent picks date+time. Shows
 * Regular vs VIP cards (with media + FREE badge) and a continue CTA.
 * Keeps the existing OfferTimeStepBody logic for time-slot rendering
 * but auto-selects the time we already know about.
 */
function OfferStep({
  offers,
  selectedOfferId,
  setSelectedOfferId,
  selectedTariffId,
  setSelectedTariffId,
  selectedTime,
  date,
  busy,
  onContinue,
  onBack,
}: {
  offers: QamfOffer[];
  selectedOfferId: number | null;
  setSelectedOfferId: (n: number | null) => void;
  selectedTariffId: number | null;
  setSelectedTariffId: (n: number | null) => void;
  selectedTime: string;
  date: string;
  busy: boolean;
  onContinue: () => void;
  onBack: () => void;
}) {
  // Set selectedTariffId on first render once an offer auto-selects.
  // The OfferTimeStepBody handles the visual selection & the time
  // grid (compatibility — keeps existing tariff-card UI).
  return (
    <div className="space-y-6">
      <p className="text-center text-white/45 text-xs">
        Showing packages near {selectedTime ? formatTimeLabel(selectedTime) : ""} on{" "}
        {date
          ? new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })
          : ""}
      </p>

      <OfferTimeStepBody
        offers={offers}
        selectedOfferId={selectedOfferId}
        setSelectedOfferId={setSelectedOfferId}
        selectedTariffId={selectedTariffId}
        setSelectedTariffId={setSelectedTariffId}
        selectedTime={selectedTime}
        setSelectedTime={() => { /* time fixed by datetime step */ }}
        busy={busy}
        date={date}
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={busy || !selectedOfferId || !selectedTariffId}
          className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50"
          style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

/** Format an ISO BMI start timestamp ("2026-05-14T17:00:00") as a
 *  short locale time string ("5:00 PM"). */
function formatBmiTimeLabel(iso: string): string {
  try {
    const clean = iso.replace(/Z$/, "");
    const [datePart, timePart] = clean.split("T");
    if (!timePart) return iso;
    const [y, m, d] = datePart.split("-").map(Number);
    const [h, min] = timePart.split(":").map(Number);
    return new Date(y, m - 1, d, h, min).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function formatTimeLabel(t: string): string {
  if (!/^\d{2}:\d{2}$/.test(t)) return t;
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// ── Tariff cards + time grid (extracted for reuse from DateTimeStep) ───────

/**
 * Tariff/time picker — mirrors the visual treatment of the bowling
 * page's `lane-type` step. Two big horizontal cards (Regular / VIP),
 * each showing what's included, a "FREE" badge on Regular, and a
 * time-slot grid that filters to the selected tariff.
 */
function OfferTimeStepBody({
  offers,
  selectedOfferId,
  setSelectedOfferId,
  selectedTariffId,
  setSelectedTariffId,
  selectedTime,
  setSelectedTime,
  busy,
  date,
}: {
  offers: QamfOffer[];
  selectedOfferId: number | null;
  setSelectedOfferId: (n: number | null) => void;
  selectedTariffId: number | null;
  setSelectedTariffId: (n: number | null) => void;
  selectedTime: string;
  setSelectedTime: (s: string) => void;
  busy: boolean;
  date: string;
}) {
  // Pin Regular first, VIP second by inferring from the offer name.
  const ordered = [...offers].sort((a, b) => {
    const av = /vip/i.test(a.Name) ? 1 : 0;
    const bv = /vip/i.test(b.Name) ? 1 : 0;
    return av - bv;
  });

  const selectedOffer = offers.find((o) => o.OfferId === selectedOfferId);

  return (
    <div className="space-y-6">
      {offers.length === 0 && !busy && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center">
          <p className="text-white/55 text-sm">
            No Kids Bowl Free times available for that date.
          </p>
        </div>
      )}

      {/* Two big cards — Regular / VIP. Mirrors the bowling lane-type step. */}
      <div className="space-y-3">
        {ordered.map((o) => {
          const on = selectedOfferId === o.OfferId;
          const isVip = /vip/i.test(o.Name);
          const accent = isVip ? GOLD : CORAL;
          const firstItem = o.Items?.[0];
          const isFree = !!firstItem && firstItem.Total === 0;
          const slotCount = o.Items?.length ?? 0;
          const features = isVip
            ? [
                "VIP lounge & dedicated lanes",
                "NeoVerse video walls",
                "Priority check-in",
                "Up to 6 bowlers per lane",
              ]
            : [
                "Standard HeadPinz lanes",
                "Up to 6 bowlers per lane",
                "Glow lighting in the evenings",
                "Bring your KBF coupon to check in",
              ];
          // Mirror /book/bowling lane-type media — both tariffs get
          // autoplay videos (Regular = bowling lanes, VIP = NeoVerse).
          // Same CDN assets the bowling page uses verbatim.
          const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";
          const mediaUrl = isVip
            ? `${BLOB}/videos/headpinz-neoverse-v2.mp4`
            : `${BLOB}/videos/headpinz-bowling.mp4`;
          return (
            <button
              key={o.OfferId}
              type="button"
              onClick={() => {
                setSelectedOfferId(o.OfferId);
                // Clamp selectedTime + tariffId to the FIRST Item's
                // actual bookable slot. The user's pre-pick from the
                // datetime step might not match QAMF's offered slot
                // (Naples KBF only opens at 11 AM even if the user
                // probed at 5 PM); using the Item's Time prevents
                // book-for-later 409 / "QResourceNotAvailable".
                if (firstItem) {
                  setSelectedTariffId(firstItem.ItemId);
                  setSelectedTime(firstItem.Time);
                } else {
                  setSelectedTariffId(null);
                  setSelectedTime("");
                }
              }}
              // 1:1 visual mirror of the bowling lane-type card —
              // dashed accent border, slate bg, image/video on the
              // left, content on the right with title text-shadow,
              // small dot bullets, and a filled action pill at the
              // bottom that reflects state (selected vs sold out
              // vs CTA).
              className={`w-full rounded-lg overflow-hidden text-left transition-all ${slotCount === 0 ? "opacity-50" : "hover:scale-[1.01]"}`}
              style={{
                backgroundColor: "rgba(7,16,39,0.5)",
                border: `1.78px dashed ${slotCount === 0 ? "rgba(253,91,86,0.3)" : on ? accent + "AA" : accent + "35"}`,
                boxShadow: on ? `0 0 24px ${accent}25` : undefined,
              }}
            >
              <div className="flex flex-col sm:flex-row">
                {/* Media side — autoplay video on both tariffs.
                    Regular: HeadPinz bowling lanes. VIP: NeoVerse. */}
                <div className="relative w-full sm:w-56 h-36 sm:h-auto shrink-0 overflow-hidden">
                  <video
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    className="absolute inset-0 w-full h-full object-cover"
                    key={mediaUrl}
                  >
                    <source src={mediaUrl} type="video/mp4" />
                  </video>
                  {/* Gradient fade — matches the bowling card seam. */}
                  <div className="absolute inset-0 bg-gradient-to-b sm:bg-gradient-to-r from-transparent to-[#071027]/70 pointer-events-none" />
                </div>

                {/* Content side */}
                <div className="flex-1 p-5">
                  <div className="flex items-center gap-2 mb-1">
                    <h3
                      className="font-heading uppercase text-white text-base tracking-wider"
                      style={{ textShadow: `0 0 15px ${accent}25` }}
                    >
                      {isVip ? "Kids Bowl Free VIP" : "Kids Bowl Free Regular"}
                    </h3>
                    {isFree && (
                      <span
                        className="font-body text-xs uppercase tracking-wider px-2 py-0.5 rounded-full font-bold"
                        style={{
                          backgroundColor: "rgba(34,197,94,0.18)",
                          color: "#4ade80",
                          border: "1px solid rgba(74,222,128,0.4)",
                        }}
                      >
                        Free
                      </span>
                    )}
                    {!isFree && firstItem && (
                      <span
                        className="font-body text-xs uppercase tracking-wider px-2 py-0.5 rounded-full font-bold"
                        style={{
                          backgroundColor: `${accent}26`,
                          color: accent,
                          border: `1px solid ${accent}55`,
                        }}
                      >
                        ${firstItem.Total.toFixed(2)} / lane
                      </span>
                    )}
                    {slotCount === 0 && (
                      <span
                        className="font-body text-xs uppercase tracking-wider px-2 py-0.5 rounded-full font-bold"
                        style={{
                          backgroundColor: "rgba(253,91,86,0.2)",
                          color: CORAL,
                          border: `1px solid ${CORAL}40`,
                        }}
                      >
                        Sold Out
                      </span>
                    )}
                  </div>
                  <p className="font-body text-white/60 text-sm mb-3">
                    {isVip
                      ? "Upgrade your free bowling to the VIP suite — same coupon, premium lanes with NeoVerse + HyperBowling."
                      : "Two free games per kid per day on participating weekdays. Bring your KBF coupon to the front desk."}
                  </p>
                  {features.length > 0 && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
                      {features.map((f) => (
                        <span key={f} className="flex items-center gap-1.5">
                          <span
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ backgroundColor: accent }}
                          />
                          <span className="font-body text-white/40 text-xs">{f}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {/* Filled action pill — matches bowling's "{count}
                      packages available →" CTA when bookable, "Sold
                      Out" tone when not. */}
                  {slotCount > 0 ? (
                    <span
                      className="inline-flex items-center font-body text-sm font-bold uppercase tracking-wider px-5 py-2.5 rounded-full"
                      style={{
                        backgroundColor: on ? accent : `${accent}26`,
                        color: on ? "#0a1628" : accent,
                        border: on ? "none" : `1px solid ${accent}55`,
                      }}
                    >
                      {on ? "Selected ✓" : isVip ? "Pick VIP →" : "Pick Regular →"}
                    </span>
                  ) : (
                    <span
                      className="font-body text-xs font-bold uppercase tracking-wider"
                      style={{ color: CORAL }}
                    >
                      Not available at this time
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* (Time grid removed — the parent already picked a time on
          the previous datetime step. The card click handler below
          auto-binds selectedTariffId to the matching Item for the
          chosen time, so there's nothing left to pick here.) */}

      {date && (
        <div className="text-[11px] text-white/35 text-center">
          {new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </div>
      )}
    </div>
  );
}

// ── Step: review ───────────────────────────────────────────────────────────

// ── Step: addons (laser tag, gel blasters, paid shoes) ───────────────────

/**
 * Optional add-ons step. Mirrors the bowling extras layout: tariff
 * summary at the top, a paid-shoes toggle (if QAMF surfaced one), and
 * a card grid for each Extra (laser tag, gel blasters, etc.) with
 * +/- quantity controls. Skipping is fine — the parent can continue
 * straight to review without picking anything.
 */
/**
 * Add-ons step — bowling-style BMI add-ons with proposal-based time
 * pickers. Each card (laser tag / gel blaster) shows the add-on
 * image with a colored ribbon, per-person price, +/- quantity
 * controls, and a time-slot grid that fetches BMI proposals for
 * the chosen date. Picking a slot fires holdAddonSlot which
 * pre-creates a BMI hold sharing one bmiAddonOrderId across all
 * add-ons. The bowling-confirmation page consumes
 * `qamf_bmi_addons` sessionStorage to register the contact + run
 * payment confirm with depositKind=0 (zero-balance).
 */
function AddonsStep({
  centerId,
  bmiAddonQty,
  setBmiQty,
  bmiTimeSlots,
  bmiSelectedTime,
  bmiLoadingSlots,
  onPickSlot,
  playerCount,
  bowlingTime,
  busy,
  onContinue,
  onBack,
}: {
  centerId: string;
  bmiAddonQty: Record<string, number>;
  setBmiQty: (productId: string, qty: number) => void;
  bmiTimeSlots: Record<string, BmiTimeSlot[]>;
  bmiSelectedTime: Record<string, number>;
  bmiLoadingSlots: Record<string, boolean>;
  onPickSlot: (productId: string, slotIdx: number) => Promise<void>;
  playerCount: number;
  bowlingTime: string;
  busy: boolean;
  onContinue: () => void;
  onBack: () => void;
}) {
  const addons = BMI_ADDONS_BY_CENTER[centerId]?.addons ?? [];

  const totalSelected = addons.reduce(
    (s, a) => s + (bmiAddonQty[a.productId] ?? 0),
    0,
  );

  const formatBmiTime = (iso: string): string => {
    try {
      const clean = iso.replace(/Z$/, "");
      const [datePart, timePart] = clean.split("T");
      if (!timePart) return iso;
      const [y, m, d] = datePart.split("-").map(Number);
      const [h, min] = timePart.split(":").map(Number);
      return new Date(y, m - 1, d, h, min).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    } catch {
      return iso;
    }
  };
  const formatBowlingTime = (t: string): string => {
    if (!t) return "";
    const [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
  };

  return (
    <div className="space-y-5">
      <p className="text-center text-white/45 text-xs">
        Pair your bowling slot with NEXUS Laser Tag or Gel Blasters.
        Times are limited to slots that don&apos;t conflict with your
        bowling reservation. Skip and continue if you don&apos;t need
        anything.
      </p>

      {addons.length === 0 ? (
        <div
          className="rounded-lg p-6 text-center"
          style={{
            backgroundColor: "rgba(7,16,39,0.5)",
            border: "1.78px dashed rgba(255,255,255,0.10)",
          }}
        >
          <p className="font-body text-white/40 text-xs uppercase tracking-[0.2em]">
            No add-ons available at this center
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {addons.map((addon) => {
            const qty = bmiAddonQty[addon.productId] || 0;
            const isSelected = qty > 0;
            const slots = bmiTimeSlots[addon.productId] || [];
            const selectedIdx = bmiSelectedTime[addon.productId];
            const isLoading = bmiLoadingSlots[addon.productId];
            return (
              <div
                key={addon.productId}
                className="rounded-lg overflow-hidden transition-all"
                style={{
                  backgroundColor: isSelected
                    ? `${addon.accent}08`
                    : "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${
                    isSelected ? `${addon.accent}50` : "rgba(255,255,255,0.10)"
                  }`,
                }}
              >
                <div className="flex flex-col sm:flex-row">
                  <div className="relative w-full sm:w-36 h-28 sm:h-auto shrink-0 overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={addon.image}
                      alt={addon.shortName}
                      className="w-full h-full object-cover"
                    />
                    <span
                      className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-xs font-bold text-white"
                      style={{ backgroundColor: addon.accent }}
                    >
                      {addon.shortName}
                    </span>
                  </div>

                  <div className="flex-1 p-4">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <h3 className="font-body text-white font-bold text-sm">
                        {addon.name}
                      </h3>
                      <span
                        className="font-body text-sm font-bold shrink-0"
                        style={{ color: addon.accent }}
                      >
                        ${addon.price}/person
                      </span>
                    </div>
                    <p className="font-body text-white/45 text-xs mb-3">
                      {addon.desc}
                    </p>

                    {qty === 0 ? (
                      <button
                        type="button"
                        onClick={() => setBmiQty(addon.productId, playerCount || 1)}
                        className="w-full py-2.5 rounded-lg text-xs font-bold font-body transition-colors uppercase tracking-wider"
                        style={{
                          backgroundColor: `${addon.accent}15`,
                          color: addon.accent,
                          border: `1px solid ${addon.accent}30`,
                        }}
                      >
                        Add for all {playerCount || 1} bowler
                        {(playerCount || 1) === 1 ? "" : "s"} — $
                        {(addon.price * (playerCount || 1)).toFixed(2)}
                      </button>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setBmiQty(addon.productId, qty - 1)}
                            className="w-7 h-7 rounded border border-white/20 text-white/60 hover:text-white text-sm flex items-center justify-center"
                            aria-label="Decrease quantity"
                          >
                            −
                          </button>
                          <span className="w-6 text-center text-white font-bold text-xs">
                            {qty}
                          </span>
                          <button
                            type="button"
                            onClick={() => setBmiQty(addon.productId, qty + 1)}
                            className="w-7 h-7 rounded border border-white/20 text-white/60 hover:text-white text-sm flex items-center justify-center"
                            aria-label="Increase quantity"
                          >
                            +
                          </button>
                          <span className="font-body text-white/35 text-xs">
                            {qty} {qty === 1 ? "person" : "people"}
                          </span>
                        </div>
                        <span
                          className="font-body text-sm font-bold"
                          style={{ color: addon.accent }}
                        >
                          ${(addon.price * qty).toFixed(2)}
                        </span>
                      </div>
                    )}

                    {/* Time picker — only when this add-on has a qty selected. */}
                    {isSelected && (
                      <div className="mt-3 pt-3 border-t border-white/10">
                        {isLoading ? (
                          <div className="flex items-center gap-2 font-body text-white/40 text-xs">
                            <div className="w-3 h-3 border border-white/30 border-t-white/80 rounded-full animate-spin" />
                            Loading times…
                          </div>
                        ) : slots.length === 0 ? (
                          <p className="font-body text-amber-400/70 text-xs">
                            No times available on this date that don&apos;t
                            conflict with your bowling slot.
                          </p>
                        ) : (
                          <div>
                            <p className="font-body text-white/50 text-xs uppercase tracking-wider mb-2">
                              Select a time
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              <span
                                className="px-3 py-1.5 rounded-lg text-xs font-bold font-body"
                                style={{
                                  backgroundColor: `${CORAL}20`,
                                  color: CORAL,
                                  border: `1px solid ${CORAL}40`,
                                }}
                              >
                                {formatBowlingTime(bowlingTime)} Bowling
                              </span>
                              {slots.map((slot, idx) => {
                                const on = selectedIdx === idx;
                                return (
                                  <button
                                    key={slot.start}
                                    type="button"
                                    onClick={() => void onPickSlot(addon.productId, idx)}
                                    className="px-3 py-1.5 rounded-lg text-xs font-bold font-body transition-all"
                                    style={{
                                      backgroundColor: on
                                        ? addon.accent
                                        : "rgba(7,16,39,0.5)",
                                      color: on
                                        ? "#0a1628"
                                        : "rgba(255,255,255,0.6)",
                                      border: `1px solid ${
                                        on ? addon.accent : "rgba(255,255,255,0.10)"
                                      }`,
                                    }}
                                  >
                                    {formatBmiTime(slot.start)}
                                  </button>
                                );
                              })}
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

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={busy}
          className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50"
          style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
        >
          {totalSelected > 0 ? "Continue with add-ons" : "Skip add-ons"}
        </button>
      </div>
    </div>
  );
}

/**
 * Order Summary card — mirrors the bowling page's review step:
 * dashed gold border, slate bg, line items (offer, paid shoes,
 * extras), subtotal/tax/fee/total breakdown, and a coral
 * "Continue to Payment" CTA that advances to the Details step.
 */
function ReviewStep({
  centerId,
  date,
  time,
  offerName,
  offerPrice,
  tariffName,
  bowlerCount,
  bmiAddons,
  shoeQty,
  onContinue,
  onBack,
}: {
  centerId: string;
  date: string;
  time: string;
  offerName: string;
  offerPrice: number;
  tariffName: string;
  bowlerCount: number;
  bmiAddons: BmiAddonSelection[];
  shoeQty: number;
  onContinue: () => void;
  onBack: () => void;
}) {
  const center = CENTERS.find((c) => c.id === centerId);
  const dateLabel = date
    ? new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : "";
  const timeLabel = time
    ? new Date(`${date}T${time}:00`).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  // Bowling shoes are FREE on KBF; we surface the line as a $0
  // savings indicator rather than charging for them.
  const shoesTotal = 0;
  const extrasLines = bmiAddons.map((a) => ({
    name: a.name,
    qty: a.quantity,
    lineTotal: a.price * a.quantity,
    selectedTime: a.selectedTime,
  }));
  const extrasTotal = extrasLines.reduce((s, l) => s + l.lineTotal, 0);
  const subtotal = offerPrice + shoesTotal + extrasTotal;
  // KBF doesn't run our cart through Square — most bookings are
  // free, so we show the line items + a $0/total breakdown
  // client-side. QAMF does its own tax math at confirm time; we
  // surface that on the bowling-confirmation page after submit.
  const total = subtotal;

  return (
    <div>
      <h2 className="font-heading uppercase text-white text-lg tracking-wider mb-4 text-center">
        Order Summary
      </h2>
      <div
        className="rounded-lg p-5 mb-6"
        style={{
          backgroundColor: "rgba(7,16,39,0.5)",
          border: `1.78px dashed ${GOLD}30`,
        }}
      >
        {/* Header line: offer + price */}
        <div className="space-y-2 mb-4 pb-4 border-b border-white/10">
          <div className="flex justify-between">
            <span className="font-body text-white text-sm">{offerName}</span>
            <span className="font-body text-white text-sm">
              {offerPrice === 0 ? "FREE" : `$${offerPrice.toFixed(2)}`}
            </span>
          </div>
          <p className="font-body text-white/50 text-xs">
            {dateLabel} at {timeLabel} · {bowlerCount} bowler
            {bowlerCount === 1 ? "" : "s"} · {center?.name ?? ""}
          </p>
          {tariffName && (
            <p className="font-body text-white/35 text-[11px]">{tariffName}</p>
          )}
          {shoeQty > 0 && (
            <div className="flex justify-between mt-1">
              <span className="font-body text-white/70 text-sm">
                Bowling Shoes ×{shoeQty}
              </span>
              <span className="font-body text-sm" style={{ color: GOLD }}>
                FREE
              </span>
            </div>
          )}
        </div>

        {/* BMI add-ons (laser tag, gel blasters) — show held time */}
        {extrasLines.length > 0 && (
          <div className="space-y-1 mb-4 pb-4 border-b border-white/10">
            <p className="font-body text-white/40 text-xs uppercase tracking-wider mb-2">
              Add-On Activities
            </p>
            {extrasLines.map((l) => (
              <div key={l.name} className="flex justify-between">
                <span className="font-body text-white/70 text-sm">
                  {l.name} {l.selectedTime ? `at ${formatBmiTimeLabel(l.selectedTime)}` : ""} ×{l.qty}
                </span>
                <span className="font-body text-white text-sm">
                  ${l.lineTotal.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Subtotal block */}
        <div className="space-y-1 mb-4 pb-4 border-b border-white/10">
          <div className="flex justify-between">
            <span className="font-body text-white/60 text-sm">Subtotal</span>
            <span className="font-body text-white text-sm">
              ${subtotal.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="font-body text-white/60 text-sm">Tax</span>
            <span className="font-body text-white/40 text-xs">
              calculated at confirm
            </span>
          </div>
        </div>

        <div className="flex justify-between">
          <span className="font-body text-white font-bold">Total Due</span>
          <span className="font-heading text-xl" style={{ color: GOLD }}>
            {total === 0 ? "FREE" : `$${total.toFixed(2)}`}
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={onContinue}
        className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
        style={{ backgroundColor: CORAL, boxShadow: `0 0 16px ${CORAL}30` }}
      >
        Continue to Confirm
      </button>
      <button
        type="button"
        onClick={onBack}
        className="mt-4 font-body text-white/40 text-sm cursor-pointer block mx-auto"
      >
        ← Back
      </button>
    </div>
  );
}

/**
 * Details step — bowling's "Your Details" page. Guest contact
 * fields, clickwrap, and the Pay & Confirm CTA. Triggers the
 * date-confirm modal before actually submitting.
 */
function DetailsStep({
  dateLabel,
  timeLabel,
  centerName,
  bowlerCount,
  guestName,
  setGuestName,
  guestEmail,
  setGuestEmail,
  guestPhone,
  setGuestPhone,
  clickwrapAccepted,
  setClickwrapAccepted,
  busy,
  onSubmit,
  onBack,
}: {
  dateLabel: string;
  timeLabel: string;
  centerName: string;
  bowlerCount: number;
  guestName: string;
  setGuestName: (s: string) => void;
  guestEmail: string;
  setGuestEmail: (s: string) => void;
  guestPhone: string;
  setGuestPhone: (s: string) => void;
  clickwrapAccepted: boolean;
  setClickwrapAccepted: (b: boolean) => void;
  busy: boolean;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <div>
      <h2 className="font-heading uppercase text-white text-lg tracking-wider mb-4 text-center">
        Your Details
      </h2>

      {confirmOpen && (
        <DateConfirmModal
          dateLabel={dateLabel}
          timeLabel={timeLabel}
          centerName={centerName}
          bowlerCount={bowlerCount}
          busy={busy}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            onSubmit();
          }}
        />
      )}

      <div className="space-y-3 mb-6">
        <input
          type="text"
          placeholder="Full Name"
          autoComplete="name"
          value={guestName}
          onChange={(e) => setGuestName(e.target.value)}
          className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-body text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors"
        />
        <input
          type="email"
          placeholder="Email"
          autoComplete="email"
          value={guestEmail}
          onChange={(e) => setGuestEmail(e.target.value)}
          className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-body text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors"
        />
        <input
          type="tel"
          placeholder="Phone Number"
          autoComplete="tel"
          value={guestPhone}
          onChange={(e) => setGuestPhone(e.target.value)}
          className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-body text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors"
        />
      </div>

      <div className="mb-4">
        <ClickwrapCheckbox
          checked={clickwrapAccepted}
          onChange={setClickwrapAccepted}
          cancellationHours={1}
        />
      </div>

      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={busy || !clickwrapAccepted || !guestName || !guestEmail || !guestPhone}
        title={!clickwrapAccepted ? "Please agree to the cancellation policy above" : undefined}
        className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-[#0a1628] cursor-pointer transition-all hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ backgroundColor: GOLD, boxShadow: `0 0 16px ${GOLD}30` }}
      >
        {busy ? "Processing…" : "Confirm Reservation"}
      </button>
      <button
        type="button"
        onClick={onBack}
        className="mt-4 font-body text-white/40 text-sm cursor-pointer block mx-auto"
      >
        ← Back
      </button>
    </div>
  );
}

/**
 * Final confirmation modal — explicitly puts the chosen date and
 * time front-and-center so the parent can't accidentally book the
 * wrong day. Triggered when they click "Confirm reservation" on the
 * review step.
 */
function DateConfirmModal({
  dateLabel,
  timeLabel,
  centerName,
  bowlerCount,
  busy,
  onCancel,
  onConfirm,
}: {
  dateLabel: string;
  timeLabel: string;
  centerName: string;
  bowlerCount: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-2xl p-6 sm:p-7"
        style={{ backgroundColor: "#0f1d36", border: `1.78px solid ${CORAL}55` }}
      >
        <div
          className="uppercase font-bold mb-2"
          style={{ color: CORAL, fontSize: "11px", letterSpacing: "2.5px" }}
        >
          Just to be sure
        </div>
        <h3
          className="font-heading font-black uppercase italic text-white mb-4"
          style={{ fontSize: "22px", lineHeight: 1.15, letterSpacing: "-0.3px" }}
        >
          Confirm your reservation
        </h3>

        <div
          className="rounded-xl p-4 mb-4"
          style={{
            backgroundColor: "rgba(253,91,86,0.08)",
            border: "1.5px solid rgba(253,91,86,0.30)",
          }}
        >
          <div className="text-white/55 uppercase tracking-[2px] text-[10px] mb-1">
            Date
          </div>
          <div className="text-white font-bold text-lg leading-tight">{dateLabel}</div>
          <div className="text-white/85 text-base font-semibold mt-0.5">
            at {timeLabel}
          </div>
          <div className="text-white/55 text-xs mt-2">
            {centerName} · {bowlerCount} bowler{bowlerCount === 1 ? "" : "s"}
          </div>
        </div>

        <p className="text-white/65 text-xs leading-relaxed mb-5">
          Please double-check the date — once confirmed, your lane is
          held until 5 minutes after start time. Cancellations need to
          be called in at least 1 hour before.
        </p>

        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex-1 py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors disabled:opacity-50"
          >
            Go back
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-transform hover:scale-[1.02] disabled:opacity-60 disabled:scale-100"
            style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
          >
            {busy ? "Booking…" : "Yes, book it"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-white/80">
      <span className="text-white/50">{label}</span>
      <span className="text-white text-right">{value}</span>
    </div>
  );
}
