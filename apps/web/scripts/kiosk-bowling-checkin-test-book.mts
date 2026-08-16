/**
 * $0 TEST bowling reservation for the kiosk bowling check-in smoke — NO payment,
 * no Square order, no gift card, nothing to refund. Books the REAL rails the
 * same way the admin KBF book-lane route does (QAMF BookForLater reservation →
 * customer + Confirmed → Neon row + players + short link), so the kiosk can
 * find it every way a guest would:
 *
 *   - PHONE lookup: --phone is stored as guest_phone (the check-in OTP texts
 *     THIS number — use your own)
 *   - SCAN: prints the headpinz.com/s/{code} link (make a QR of it, or arm
 *     "Scan my code" and type the bare code on the kiosk keyboard)
 *   - BROWSE: bookingSource "admin" rows list in "Find my booking"
 *
 * A $0 addon_shoe line (qty = players) is attached so shoePairsAllowed equals
 * the player count and the kiosk's shoe picker actually renders — without it a
 * plain open-bowling row with no purchased shoe add-on shows no shoe UI.
 *
 * DRY RUN by default — prints the plan and books nothing. APPLY=1 executes.
 *
 *   npx tsx scripts/kiosk-bowling-checkin-test-book.mts --center hpfm --players 2 --phone 2395551234
 *   APPLY=1 npx tsx scripts/kiosk-bowling-checkin-test-book.mts --center hpfm --players 2 --phone 2395551234
 *   APPLY=1 npx tsx scripts/kiosk-bowling-checkin-test-book.mts --center hpn --at 19:30 --players 3 --phone 2395551234
 *
 * Cleanup when done (deletes the QAMF reservation + marks Neon cancelled):
 *
 *   APPLY=1 npx tsx scripts/kiosk-bowling-checkin-test-book.mts --cancel <neonId>
 *
 * NOTE: this is a REAL QAMF reservation on a real lane slot — book a time you
 * actually intend to test, and cancel it afterward so the desk isn't holding a
 * ghost lane. Opening the lane from the kiosk done screen turns the lane on.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const {
  getBowlingExperiences,
  getBowlingSquareProducts,
  getBowlingReservation,
  insertBowlingReservation,
  insertReservationPlayers,
  updateBowlingReservationShortCode,
  updateBowlingReservationStatus,
} = await import("@/lib/bowling-db");
const {
  createReservation,
  deleteReservation,
  setReservationCustomer,
  setReservationStatus,
} = await import("@/lib/qamf-bowling");
const { shortenUrl } = await import("@/lib/short-url");
const {
  HEADPINZ_FM_CENTER_CODE,
  HEADPINZ_NAPLES_CENTER_CODE,
  CENTER_CODE_TO_QAMF_ID,
} = await import("@/lib/qamf-centers");
type NewReservationInput = import("@/lib/qamf-bowling").NewReservationInput;

const APPLY = process.env.APPLY === "1";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ── cancel mode ──────────────────────────────────────────────────────────────
const cancelId = arg("cancel");
if (cancelId) {
  const neonId = Number(cancelId);
  const r = await getBowlingReservation(neonId);
  if (!r) throw new Error(`No bowling reservation with id ${neonId}`);
  console.log(
    `Cancelling test reservation #${neonId} (${r.guestName}, ${r.centerCode}, QAMF ${r.qamfReservationId ?? "—"}, status ${r.status})`,
  );
  if (!/KIOSK BOWLING CHECK-IN TEST/.test(r.notes ?? "")) {
    throw new Error(
      "Refusing: that row's notes don't carry the KIOSK BOWLING CHECK-IN TEST marker — this script only cancels its own bookings.",
    );
  }
  if (!APPLY) {
    console.log("DRY RUN — set APPLY=1 to cancel.");
    process.exit(0);
  }
  const centerId = CENTER_CODE_TO_QAMF_ID[r.centerCode];
  if (centerId && r.qamfReservationId) {
    try {
      await deleteReservation(centerId, r.qamfReservationId);
      console.log(`QAMF ${r.qamfReservationId} deleted.`);
    } catch (err) {
      console.warn(
        `QAMF delete failed (${err instanceof Error ? err.message : err}) — delete it in Conqueror; marking Neon cancelled anyway.`,
      );
    }
  }
  await updateBowlingReservationStatus(neonId, "cancelled");
  console.log(`Neon #${neonId} marked cancelled. Done.`);
  process.exit(0);
}

// ── book mode ────────────────────────────────────────────────────────────────
const centerArg = (arg("center") ?? "hpfm").toLowerCase();
const centerCode =
  centerArg === "hpn" || centerArg === "naples" ? HEADPINZ_NAPLES_CENTER_CODE : HEADPINZ_FM_CENTER_CODE;
const centerId = CENTER_CODE_TO_QAMF_ID[centerCode];
const players = Math.max(1, Math.min(12, Number(arg("players") ?? 2)));
const guestName = arg("name") ?? "Kiosk Checkin Test";
const guestEmail = arg("email") ?? "kiosk-test@headpinz.com";
const guestPhone = arg("phone");
if (!guestPhone || guestPhone.replace(/\D/g, "").length < 10) {
  throw new Error(
    "--phone is required (10 digits): it becomes the booking contact the kiosk's phone lookup and OTP use — use your own.",
  );
}

// When: --at HH:MM (ET, today) or --in <minutes> (default 30), rounded to 5.
function bookedAtIso(): string {
  const at = arg("at");
  let target: Date;
  if (at) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(at);
    if (!m) throw new Error(`--at must be HH:MM (24h ET), got "${at}"`);
    // Find today's ET date, then the UTC instant whose ET wall-clock matches.
    // Try both possible ET offsets; formatting back in ET decides the right one.
    const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const candidates = ["-04:00", "-05:00"].map(
      (off) => new Date(`${todayEt}T${m[1].padStart(2, "0")}:${m[2]}:00${off}`),
    );
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    target =
      candidates.find((c) => fmt.format(c) === `${m[1].padStart(2, "0")}:${m[2]}`) ?? candidates[0];
  } else {
    target = new Date(Date.now() + Number(arg("in") ?? 30) * 60_000);
  }
  target.setMinutes(Math.floor(target.getMinutes() / 5) * 5, 0, 0);
  return target.toISOString().replace(/\.\d{3}Z$/, "Z");
}
const bookedAt = bookedAtIso();
const bookedAtEt = new Date(bookedAt).toLocaleString("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  day: "numeric",
});

// Open-bowling experience → QAMF web offer (same rows the wizard books).
const experiences = await getBowlingExperiences(centerCode, "open");
const exp = experiences.find((e) => !e.isVip && e.qamfWebOfferId && e.qamfOptionId);
if (!exp) throw new Error(`No bookable non-VIP open experience configured for ${centerCode}`);

// $0 shoe line so shoePairsAllowed = players and the kiosk shoe picker renders.
const shoeProducts = await getBowlingSquareProducts(centerCode, "addon_shoe");
const shoeProduct = shoeProducts[0] ?? null;
if (!shoeProduct) console.warn("No addon_shoe product for this center — shoe UI will stay dark.");

console.log(`Center:      ${centerCode} (QAMF ${centerId})`);
console.log(`Experience:  ${exp.slug} (offer ${exp.qamfWebOfferId}, ${exp.qamfOptionType} option ${exp.qamfOptionId})`);
console.log(`When:        ${bookedAtEt} ET (${bookedAt})`);
console.log(`Players:     ${players}   Contact: ${guestName} / ${guestPhone} / ${guestEmail}`);
console.log(`Shoe line:   ${shoeProduct ? `${shoeProduct.label} ×${players} @ $0` : "NONE"}`);
if (!APPLY) {
  console.log("\nDRY RUN — set APPLY=1 to book.");
  process.exit(0);
}

// 1. Temporary QAMF reservation (BookForLater — 10-min expiry until confirmed).
const optionsBlock: NewReservationInput["WebOffer"]["Options"] =
  exp.qamfOptionType === "Game"
    ? { Game: [{ Id: exp.qamfOptionId! }] }
    : exp.qamfOptionType === "Unlimited"
      ? { Unlimited: [{ Id: exp.qamfOptionId! }] }
      : { Time: [{ Id: exp.qamfOptionId! }] };
const qamfRes = await createReservation(centerId, {
  BookedAt: bookedAt,
  Title: `${guestName} (${players}p)`,
  Notes: "KIOSK BOWLING CHECK-IN TEST — $0, no payment. Cancel after testing.",
  Customer: { Guest: { Name: guestName, PhoneNumber: guestPhone, Email: guestEmail } },
  WebOffer: { Id: exp.qamfWebOfferId, Options: optionsBlock, Services: ["BookForLater"] },
  TotalPlayers: players,
});
console.log(`QAMF reservation ${qamfRes.Id} created.`);

// 2. Confirm it (customer + status), exactly like admin book-lane.
await setReservationCustomer(centerId, qamfRes.Id, {
  Guest: { Name: guestName, PhoneNumber: guestPhone, Email: guestEmail },
});
await setReservationStatus(centerId, qamfRes.Id, "Confirmed");
console.log("QAMF confirmed.");

// 3. Neon row — $0 end to end, admin-sourced (kiosk browse lists admin rows;
//    it skips only kiosk-booked ones).
const reservation = await insertBowlingReservation(
  {
    centerCode,
    productKind: "open",
    qamfReservationId: qamfRes.Id,
    bmiBillId: undefined,
    bmiReservationNumber: undefined,
    squareDepositOrderId: undefined,
    squareDepositPaymentId: undefined,
    squareDayofOrderId: undefined,
    squareGiftCardId: undefined,
    squareGiftCardGan: undefined,
    bookedAt,
    depositCents: 0,
    totalCents: 0,
    status: "confirmed",
    playerCount: players,
    guestName,
    guestEmail,
    guestPhone,
    notes: "KIOSK BOWLING CHECK-IN TEST — $0, no payment. Cancel after testing.",
    bookingSource: "admin",
    squareCustomerId: undefined,
    squareLoyaltyRewardId: undefined,
    loyaltyAction: undefined,
    shortCode: undefined,
    dayofOrderSentAt: undefined,
    dayofOrderLane: undefined,
    dayofPaymentId: undefined,
    dayofOrderError: undefined,
    dayofOrderSource: undefined,
    preArrivalSentAt: undefined,
    laneReadySentAt: undefined,
  },
  shoeProduct
    ? [{ squareProductId: shoeProduct.id, label: shoeProduct.label, quantity: players, unitPriceCents: 0 }]
    : [],
);
const neonId = reservation.id;

// 4. Placeholder players — the kiosk (like the web) shows "Bowler N" as empty.
await insertReservationPlayers(
  neonId,
  Array.from({ length: players }, (_, i) => ({ slot: i + 1, name: `Bowler ${i + 1}` })),
);

// 5. Short link, same two-step mint as the reserve route.
const confirmBase = "/hp/book/bowling/confirmation";
const shortCode = await shortenUrl(`${confirmBase}?code=_TMP_`);
await shortenUrl(`${confirmBase}?code=${shortCode}`, shortCode);
await updateBowlingReservationShortCode(neonId, shortCode);

console.log(`
BOOKED — Neon #${neonId}, QAMF ${qamfRes.Id}, ${bookedAtEt} ET, ${players} players, $0.

Test it at the kiosk (HPFM/HPN, or any fort-myers kiosk for the HPFM one):
  - Phone:  "Text me a code" with ${guestPhone}
  - Scan:   make a QR of  https://headpinz.com/s/${shortCode}
            (or arm "Scan my code" and type: ${shortCode})
  - Browse: "Find my booking" → "${guestName}" (last-4 ${guestPhone.replace(/\D/g, "").slice(-4)} → OTP to that phone)

Clean up when done:
  APPLY=1 npx tsx scripts/kiosk-bowling-checkin-test-book.mts --cancel ${neonId}
`);
