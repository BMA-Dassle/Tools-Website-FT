/**
 * English message catalog — the SOURCE OF TRUTH.
 *
 * Keys are dot-namespaced by screen (`attract.*`, `categories.*`, …). Values are
 * ICU MessageFormat strings: `{name}` interpolates, `{n, plural, …}` pluralizes.
 * Every other locale (es.ts) is typed to `MessageKey` so a missing/extra key is
 * a compile error, and falls back to English at runtime.
 *
 * SCOPE: guest-facing kiosk copy only. Staff/admin, device, and legal-waiver
 * body text are intentionally NOT keyed here (they stay English). See
 * tasks/kiosk-i18n-spanish-plan.md.
 *
 * Locked glossary — NEVER translate these proper nouns in any locale:
 * FastTrax, HeadPinz, Game Zone, Podium, Pit Crew, Duckpin.
 */
export const en = {
  // --- Attract screen (Phase 0 spike) ---
  "attract.letsPlay": "Let’s play.",
  "attract.subtitle.racing":
    "Book racing, bowling & attractions right here — takes about a minute.",
  "attract.subtitle.bowling":
    "Book bowling, blasters & laser tag right here — takes about a minute.",
  "attract.touchToStart": "Touch to get started",

  // --- Category chooser (KioskCategories) ---
  "categories.heading.addAnything": "Add anything else?",
  "categories.heading.whatToday": "What are we doing today?",
  "categories.exp.title": "Experiences",
  "categories.exp.eyebrowFallback": "Bundled experiences",
  "categories.exp.blurb": "Multiple attractions combined into one easy price",
  "categories.attr.title": "Attractions",
  "categories.attr.eyebrow": "{count, plural, one {# attraction} other {# attractions}}",
  "categories.attr.blurb.naples": "Bowling, gel blasters, laser tag & more — pick a time and go",
  "categories.attr.blurb.default": "Racing, bowling, blasters & more — pick a time and go",
  "categories.gameZone.eyebrow.reload": "Reload · check balance",
  "categories.gameZone.eyebrow.full": "Reload · buy · 1 to 10 cards",
  "categories.gameZone.blurb.reload": "Reload your arcade card or check its balance — no waiting",
  "categories.gameZone.blurb.full": "Buy or reload arcade tokens — no waiting",
  "categories.disabled.experience":
    "Not available right now — please check back or ask an attendant.",
  "categories.disabled.attraction":
    "Nothing left to book today — the front desk can help with walk-ins.",
  "categories.backToCategories": "All categories",
  "categories.pick.experience": "Pick your experience",
  "categories.pick.attraction": "Pick an attraction",
  "categories.eyebrow.mostPopular": "Most popular",
  "categories.eyebrow.premiumRacing": "Premium racing",
  "categories.combo.priceLine": "{weekday}/person Mon–Thu · {weekend}/person Fri–Sun",
  "categories.qualifier.blurb":
    "Qualify on a Starter, then level up — POV video, free appetizer & license included.",
  "categories.qualifier.fromWeekday": "From {price}/person Mon–Thu",
  "categories.qualifier.fromWeekend": "From {price}/person Fri–Sun",
  "categories.qualifier.disabled":
    "Not enough time left today to fit both races — please check back or ask an attendant.",
  "categories.emptyShelf": "No bundled experiences are running at this location today.",
  "categories.gameZone.unavailable.title": "Game Zone cards not available on this kiosk",
  "categories.gameZone.unavailable.note": "Please use another kiosk or see Guest Services",
  "categories.tile.unavailable": "Unavailable",
  "categories.tile.atVenue": "At {venue}",
  "categories.exp.nextAvailable": "Next available · {time}",
  "categories.exp.nextAvailableSlots":
    "Next available · {time} · {count, plural, one {# slot} other {# slots}}",
  "categories.tile.nextLane": "Next lane · {time}",
  "categories.tile.countTables": "{count, plural, one {# table} other {# tables}} · {time}",
  "categories.tile.countPlayers": "{count, plural, one {# player} other {# players}} · {time}",

  // --- Confirmation (KioskConfirmation) ---
  // NOTE: several confirmation strings carry inline <strong> emphasis (the
  // racing "what's next" paragraph, race-pack outcome lines, the POV caption,
  // and the RACE_CHECKIN_STEPS bodies). The current formatMessage engine returns
  // plain strings only — it can't render ICU rich-text tags — so those stay
  // English with a TODO(i18n) in the component until the engine gains rich-text
  // support (or a native reviewer splits them safely). Only plain copy is keyed.
  "confirmation.booked": "You’re booked.",
  "confirmation.receiptNote":
    "Your confirmation and check-in links were just texted and emailed to you — that’s your ticket, nothing to print.",
  "confirmation.racing.eyebrow": "Racing — what’s next",
  "confirmation.racing.howButton": "How does race check-in work?",
  "confirmation.lane.readyTitle": "{lane} is ready",
  "confirmation.lane.readyTitleGeneric": "Your lane is ready",
  "confirmation.lane.readyPrompt":
    "Would you like us to open your lane now so you can start bowling?",
  "confirmation.lane.opening": "Opening…",
  "confirmation.lane.openButton": "Open my lane",
  "confirmation.lane.later": "I’ll check in later",
  "confirmation.lane.openTitle": "{lane} is open",
  "confirmation.lane.openTitleGeneric": "Your lane is open",
  "confirmation.lane.openBody.fasttrax": "Head on over — your lane is ready.",
  "confirmation.lane.openBody.headpinz":
    "Head on over — your shoes will be delivered right to your lane.",
  "confirmation.lane.failedTitle": "We couldn’t open your lane",
  "confirmation.lane.failedBody":
    "Please see the front desk and they’ll get you bowling right away.",
  "confirmation.racePacks.eyebrow": "Race packs",
  "confirmation.qr.alt": "Check-in code",
  "confirmation.bookingCode": "Booking code",
  "confirmation.done": "Done — start over",
  "confirmation.dispensing": "Dispensing your cards…",
  "confirmation.dispensingHint": "Grab each card as it comes out — we’ll finish up automatically.",
  "confirmation.returningIn": "Returning to start in {seconds}s — touch anywhere to stay",
  "confirmation.raceCheckin.eyebrow": "Race check-in",
  "confirmation.raceCheckin.title": "What to expect",
  "confirmation.raceCheckin.gotIt": "Got it",

  // --- Bowling tier step (KioskBowlingTierStep) ---
  "bowlingTier.loading": "Loading lanes…",
  "bowlingTier.intro": "Standard lanes or the VIP suite with lounge service — pick your time next.",
  "bowlingTier.upgrade": "Upgrade",
  "bowlingTier.perLaneHour": "/lane per hour",
  "bowlingTier.classic.title": "Classic Lanes",
  "bowlingTier.classic.sub": "The house favorite — up to 8 per lane",
  "bowlingTier.vip.title": "VIP Suites",
  "bowlingTier.vip.sub": "Private suite seating, lounge service to your lane",

  // --- Bowling time step (KioskBowlingTimeStep) ---
  "bowlingTime.busy.racing": "You’re racing",
  "bowlingTime.busy.booked": "You’re booked",
  "bowlingTime.busy.bowling": "You’re bowling",
  "bowlingTime.heroEyebrow": "Next open lanes · today at {center}",
  "bowlingTime.heroSelected": "Locked in — continue to pick your lane package",
  "bowlingTime.heroUnselected": "Tap to bowl as soon as you’re ready",
  "bowlingTime.noneToday":
    "No more lane times today — the front desk can help with walk-in availability.",
  "bowlingTime.orPickAnother": "Or pick another time today",
  "bowlingTime.conflictNote":
    "Crossed-out times overlap something you’ve already booked this visit.",
  "bowlingTime.availabilityNote":
    "Exact lane availability is confirmed on the next step — if a time just filled, we’ll offer the closest open one.",

  // --- Attraction slot step (KioskSlotStep) ---
  "slot.finding": "Finding your next available time…",
  "slot.nextAvailable": "Next available · today",
  "slot.holding": "Holding your spot…",
  "slot.held": "Held for you — continue to keep going",
  "slot.spotsOpen": "{count, plural, one {# spot} other {# spots}} open — tap to grab it",
  "slot.hold.filled": "That time just filled — pick another below.",
  "slot.error": "Couldn’t check today’s times — pick from the list below.",
  "slot.noneSoon":
    "Nothing bookable for your group in the next few hours — today’s remaining times are below, or ask the front desk about walk-ins.",
  "slot.orPickAnother": "Or pick another time today",

  // --- Bowler roster / details (KioskBowlingDetailsStep) ---
  // NOTE: this step's StepDef `title` and its `canAdvance` validation reasons
  // run at module scope (outside React), so they can't reach useT() — they stay
  // English with a TODO(i18n) in the component until validation copy is threaded
  // through the locale (a broader change tracked in the plan).
  "bowlingDetails.intro.shoes":
    "Names, shoes and bumpers — so your lane is ready the moment you are.",
  "bowlingDetails.intro.noShoes": "Names and bumpers — so your lane is ready the moment you are.",
  "bowlingDetails.readyCount": "{ready} of {total} ready",
  "bowlingDetails.bowlerN": "Bowler {num}",
  "bowlingDetails.ready": "Ready",
  "bowlingDetails.name": "Name",
  "bowlingDetails.shoeSize": "Shoe size",
  "bowlingDetails.shoeRentalNote": "rental {price}/pair · own shoes free",
  "bowlingDetails.ownShoes": "Own shoes",
  "bowlingDetails.cat.toddler": "Toddler",
  "bowlingDetails.cat.mens": "Men’s",
  "bowlingDetails.cat.womens": "Women’s",
  "bowlingDetails.bumpers": "Bumpers",
  "bowlingDetails.yes": "Yes",
  "bowlingDetails.no": "No",
  "bowlingDetails.rentalSummary":
    "{count, plural, one {# shoe rental} other {# shoe rentals}} · {price}/pair",

  // --- Bowling package / offer step (KioskBowlingOfferStep) ---
  // Note: `error` shown on this step is a server/hook message (dynamic English)
  // and is not keyed; formatBookedTime/formatHourLabel produce locale-neutral
  // clock strings. "HyperBowling" is a product name — left untranslated.
  "offer.loading": "Checking lane availability…",
  "offer.nearClosing": "Only 1 hour available this close to closing.",
  "offer.howLong": "How long?",
  "offer.perLane": "/lane",
  "offer.perPerson": "/person",
  "offer.perLaneHour": "/lane per hour",
  "offer.pastClosing": "Past closing",
  "offer.startTime": "Start time",
  "offer.noLanesAtTime": "No lanes open at this time — go back and pick another time.",
  "offer.pickDurationFirst": "Pick a duration first.",
  "offer.summary.lanes": "{count, plural, one {# lane} other {# lanes}}",
  "offer.summary.bowlers": "{count, plural, one {# bowler} other {# bowlers}}",
  "offer.cta.holding": "Holding your lanes…",
  "offer.cta.reservedFor": "Reserved for {time}",
  "offer.cta.reserve": "Reserve {time}",
  "offer.cta.noTimes": "No times available",
  "offer.heldNote": "Lanes held — hit Continue below to keep going.",
  "offer.free": "Free",
  "offer.perPersonVipLane": "/person · VIP lane",
  "offer.openAt": "Open at {time}",
  "offer.intro.widened": "Nothing open at {time} — the next open times are below.",
  "offer.intro.around":
    "Around {time} · {players, plural, one {# bowler} other {# bowlers}} on {lanes, plural, one {# lane} other {# lanes}}.",
  "offer.intro.setup": "Set up your lanes.",
  "offer.widenedNote":
    "Your picked time just filled up. Choosing one of the times below changes your start time.",
  "offer.makeVip": "Make it VIP",
  "offer.vip.kbf": "HyperBowling glow lanes · +{price}/person",
  "offer.vip.delta": "Private suite seating, lounge service · +{price} /lane per hour",
  "offer.vip.noDelta": "Private suite seating, lounge service to your lane",
  "offer.seeVip": "See VIP",
  "offer.noLanesToday":
    "No lanes open around this time today — go back and pick another time, or the front desk can help with walk-ins.",

  // --- "Who's bowling?" people step (KioskBowlingPeopleStep) ---
  "bowlingPeople.signedInIntro":
    "Your group is signed in — tap who’s bowling. Anyone else can join without an account.",
  "bowlingPeople.walkupIntro":
    "Add everyone bowling, and tap one person as the main contact for the reservation.",
  "bowlingPeople.minor": "Minor",
  "bowlingPeople.main": "Main",
  "bowlingPeople.remove": "Remove",
  "bowlingPeople.addAnother": "Add another bowler",
  "bowlingPeople.firstName": "First name",
  "bowlingPeople.lastName": "Last name",
  "bowlingPeople.lastNameOptional": "Last name (optional)",
  "bowlingPeople.mainFirstName": "Main person first name",
  "bowlingPeople.mainLastName": "Main person last name",
  "bowlingPeople.emailPlaceholder": "Email (for your confirmation)",
  "bowlingPeople.phonePlaceholder": "Mobile phone",
  "bowlingPeople.confirmationGoesTo": "Confirmation goes to {name}",
  "bowlingPeople.scanHint": "Or scan a driver’s license / state ID at the scanner to add a bowler.",
  "bowlingPeople.aria.removeFromBowling": "Remove {name} from bowling",
  "bowlingPeople.aria.addToBowling": "Add {name} to bowling",
  "bowlingPeople.aria.extraFirst": "Extra bowler {num} first name",
  "bowlingPeople.aria.extraLast": "Extra bowler {num} last name",
  "bowlingPeople.aria.removeExtra": "Remove extra bowler {num}",
  "bowlingPeople.aria.bowlerFirst": "Bowler {num} first name",
  "bowlingPeople.aria.bowlerLast": "Bowler {num} last name",
  "bowlingPeople.aria.removeBowler": "Remove bowler {num}",
  "bowlingPeople.aria.mainEmail": "Main person email",
  "bowlingPeople.aria.mainPhone": "Main person mobile phone",

  // --- Merged cart + checkout screen (KioskCheckoutScreen) ---
  // The reused CartView blocks (combo banner, item cards) are shared WEB
  // components and stay English in this pass — only kiosk-native chrome is keyed.
  "checkout.eyebrow": "Checkout",
  "checkout.title": "Review your order",
  "checkout.empty": "Your cart is empty — head back to pick an activity.",
  "checkout.finishFirst": "Finish setting up each activity (tap Edit) before paying.",
  "checkout.estTotal": "Est. total",
  "checkout.plusTax": "+ tax",
  "checkout.allActivities": "All activities",
  "checkout.reviewAndPay": "Review & Pay",

  // --- Checkout upsell (KioskCheckoutUpsell) — "Game Zone" stays untranslated ---
  "upsell.eyebrow": "One more thing…",
  "upsell.title": "Add Game Zone tokens?",
  "upsell.cardLabel": "Game Zone token card",
  "upsell.tokens": "{count} tokens",
  "upsell.pctOff": "{pct}% off today",
  "upsell.ridesPayment":
    "Rides your booking payment — the {count, plural, one {card prints} other {cards print}} right here when you’re done.",
  "upsell.activation":
    "{count, plural, one {Card activation (one-time)} other {Card activation × # (one-time)}}",
  "upsell.howMany": "How many cards?",
  "upsell.onePerPlayer": "One per player (up to {max})",
  "upsell.aria.fewer": "Fewer cards",
  "upsell.aria.more": "More cards",
  "upsell.cta": "{count, plural, one {Add to order} other {Add # cards}} — {price}",
  "upsell.skip": "No thanks, continue",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
