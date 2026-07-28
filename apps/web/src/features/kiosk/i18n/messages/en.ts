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
  "attract.letsBowl": "Let’s bowl.",
  "attract.letsRace": "Let’s race.",
  "attract.letsParty": "Let’s party.",
  // Headline layout only: the "Let's …" line is driven by the AD SLIDE, so it
  // needs one phrase per slide rather than the free-running welcome rotation.
  // Rendered at 150px and measured down to one line — a long translation
  // shrinks rather than wrapping (see fitOneLine in AttractHeadline).
  "attract.letsBlast": "Let’s blast.",
  "attract.letsGoMega": "Let’s go Mega.",
  // Replaces the "Touch to get started" pill. The whole screen is the tap
  // target, so this labels the gesture instead of faking a control.
  "attract.touchAnywhereToStart": "Touch anywhere to start",
  // Bank billboard (AttractBillboard) — \n is a hard line break on the big
  // neon word (rendered whitespace-pre-line).
  "attract.billboard.bowling": "Bowling",
  "attract.billboard.gel": "Gel\nblasters",
  "attract.billboard.duckpin": "Duckpin",
  "attract.billboard.laser": "Laser\ntag",
  "attract.billboard.gameZone": "Game\nZone",
  "attract.billboard.andMore": "…and\nmore",
  "attract.billboard.allRightHere": "All right\nhere.",
  "attract.subtitle.racing":
    "Book racing, bowling & attractions right here — takes about a minute.",
  "attract.subtitle.bowling":
    "Book bowling, blasters & laser tag right here — takes about a minute.",
  "attract.touchToStart": "Touch to get started",
  "attract.startingUp": "Starting up…",
  "attract.touchAnywhere": "Touch anywhere",
  "attract.vipExperience": "VIP Experience",
  "attract.racePacks": "Race packs — from {price}",
  "attract.waiver": "Online & Group Waiver",
  "attract.checkin": "Checking in? Start here",
  "attract.raceGrid": "View race grid",
  "attract.raceGridSub": "Check upcoming race times",
  "attract.raceReservation": "Race Reservation",
  "attract.raceReservationSub": "Check into race reservation",

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

  // --- Rewards on checkout (KioskRewardsSection) ---
  // The program name ("HeadPinz Rewards" / "FastTrax Rewards") is a brand proper
  // noun and stays as-is. `{unit}` is the points unit: "Pinz" (HeadPinz, a brand
  // term, untranslated) or the translated word below (FastTrax). Reward tier
  // names come from Square (server data) and stay as returned.
  "rewards.pointsUnit": "points",
  "rewards.addMobile": "Add your mobile number above to check your {unit}.",
  "rewards.checking": "Checking your {program}…",
  "rewards.enrollBlurbPlain": "Earn 10 {unit} per $1 spent. Free to join.",
  "rewards.enrollBlurbPreview":
    "Earn 10 {unit} per $1 spent — that’s ~{earn} on today’s order. Free to join.",
  "rewards.enrollError": "Couldn’t create a rewards account — you can sign up at the front desk.",
  "rewards.signingUp": "Signing up…",
  "rewards.joinFree": "Join free",
  "rewards.collapsed.applied": "{name} applied — tap to change",
  "rewards.collapsed.spend": "Tap to spend {unit} on this order",
  "rewards.collapsed.verifySpend": "Tap to verify & spend your {unit}",
  "rewards.earnMore": "You’ll earn ~{n} more {unit} on today’s order.",
  "rewards.verified": "Verified",
  "rewards.member": "Member",
  "rewards.verifyPrompt": "Verify it’s your account to spend {unit} on this order.",
  "rewards.sending": "Sending…",
  "rewards.textCode": "Text me a code",
  "rewards.enterCode": "Enter the 6-digit code we texted to your phone.",
  "rewards.submit": "Submit",
  "rewards.sendError": "Couldn’t send the code — try again.",
  "rewards.codeMismatch": "That code didn’t match — try again.",
  "rewards.verifyFailed": "Verification failed — try again.",
  "rewards.spendHeading": "Spend {unit} on this order",
  "rewards.tierPoints": "{points} {unit}",
  "rewards.notEnough": "Not enough {unit} for a reward yet — keep earning!",

  // --- Mobile-join new-guest form (join/phone/NewGuestForm) ---
  // The DOB placeholder "MM/DD/YYYY" and the phone example stay as-is — they are
  // input format tokens the parser enforces, not translatable prose.
  "join.firstName": "First name",
  "join.lastName": "Last name",
  "join.birthday": "Birthday",
  "join.mobilePhone": "Mobile phone",
  "join.email": "Email",
  "join.optional": "(optional)",
  "join.settingUp": "Setting you up…",
  "join.continueToWaiver": "Continue to waiver",
  "join.back": "Back",
  "join.err.name": "Enter your first and last name.",
  "join.err.dob": "Enter your birthday as MM/DD/YYYY.",
  "join.err.phone": "Enter your mobile phone number.",
  "join.err.email": "That email doesn’t look right — or leave it blank.",

  // --- Mobile-join phone flow (join/phone/JoinPhoneFlow) ---
  "joinFlow.finding": "Finding your group…",
  "joinFlow.joinGroup": "Join your group",
  "joinFlow.race": "Go-Kart Racing",
  "joinFlow.activity": "Activity check-in",
  "joinFlow.locationLine": "at {venue} — {kind}",
  "joinFlow.onePayment":
    "One group, one payment. Split payment isn’t available here — your whole group pays together at the kiosk.",
  "joinFlow.adultsOnly":
    "Adults 18+ only. Anyone under 18 gets added at the kiosk, where an adult can sign for them.",
  "joinFlow.beenBefore": "I’ve been here before",
  "joinFlow.imNew": "I’m new — set me up",
  "joinFlow.takesMinute": "Takes about a minute. Your group can keep going at the kiosk.",
  "joinFlow.lookupIntro": "Find your account — we’ll text or email you a code",
  "joinFlow.switchToNew": "Actually, I’m new here →",
  "joinFlow.back": "Back",
  "joinFlow.setYourself": "Set yourself up",
  "joinFlow.signingFor": "Signing for:",
  "joinFlow.waiver.race": "Racing Waiver",
  "joinFlow.waiver.activity": "Activity Waiver",
  "joinFlow.waiver.subheading": "Sign once — it covers your whole visit today.",
  "joinFlow.addingToGroup": "Adding you to the group…",
  "joinFlow.onList": "You’re on the kiosk list!",
  "joinFlow.addedHeadBack":
    "{name} has been added. Head back to your group — the kiosk shows you’re in.",
  "joinFlow.reminderPay":
    "Reminder: your group pays together at the kiosk — split payment isn’t available.",
  "joinFlow.addAnother": "Add another person",
  "joinFlow.batchHeading":
    "{count, plural, one {You’re on the kiosk list!} other {# people added!}}",
  "joinFlow.batchAddedTail":
    "{count, plural, one { has} other { have}} been added. Head back to your group — the kiosk shows you’re in.",
  "joinFlow.batchSkipped":
    "{names} {count, plural, one {is} other {are}} under 18 — an adult can add {count, plural, one {them} other {each of them}} at the kiosk.",
  "joinFlow.addMore": "Add more people",
  "joinFlow.minorTitle": "Under 18? Head to the kiosk.",
  "joinFlow.minorBody":
    "Players under 18 are added at the kiosk so a parent or guardian can sign their waiver. Everyone 18+ can join right here.",
  "joinFlow.addSomeoneElse": "Add someone else instead",
  "joinFlow.tryAgain": "Try again",
  "joinFlow.startOver": "Start over",
  "joinFlow.reconnecting": "Reconnecting…",
  "joinFlow.confirmBirthday": "Confirm your birthday",
  "joinFlow.hiNeedOnce": "Hi {firstName} — we need it once for your waiver.",
  "joinFlow.dobAria": "Birthday",
  "joinFlow.continue": "Continue",
  "joinFlow.err.setup": "We couldn’t finish setting you up. Try again — or see the front desk.",
  "joinFlow.err.full": "This group’s list is full — see the front desk to be added.",
  "joinFlow.err.rateLimit": "One moment — try again in a few seconds.",
  "joinFlow.err.addFail": "Something hiccuped adding you to the list. Try again.",
  "joinFlow.err.connection": "Connection hiccup — check your signal and try again.",
  "joinFlow.ended.movedOn.title": "The group moved on.",
  "joinFlow.ended.movedOn.body":
    "The kiosk finished adding players before you were done. Flag your group down — they can add you right at the kiosk, or see the front desk.",
  "joinFlow.ended.cancelled.title": "This session was cancelled at the kiosk.",
  "joinFlow.ended.cancelled.body": "Ask your group to start again, then scan the new QR code.",
  "joinFlow.ended.expired.title": "This QR code expired.",
  "joinFlow.ended.expired.body": "Scan the code on the kiosk screen again to join.",
  "joinFlow.ended.invalid.title": "This link isn’t valid.",
  "joinFlow.ended.invalid.body": "Scan the QR code on the kiosk to join your group.",

  // --- Self-service check-in (checkin/KioskCheckinFlow) ---
  // Reservation labels, activity titles, and lane labels come from the server
  // and stay as returned. The `formatPhoneMask` "your number" fallback is a
  // module helper (no hook) and stays English.
  "checkin.loading": "Loading…",
  "checkin.oneMoment": "One moment…",
  "checkin.home": "Home",
  "checkin.back": "Back",
  "checkin.eyebrow": "Check in",
  "checkin.doneTitle": "You’re checked in",
  "checkin.welcomeBack": "Welcome back, {name}!",
  "checkin.friend": "friend",
  "checkin.findReservation": "Find your reservation",
  "checkin.matches.prompt": "We found more than one reservation — tap the one you’re here for.",
  "checkin.browse.prompt":
    "Today’s reservations at this location. Tap your booking — we’ll text a code to the number on the reservation to confirm it’s you.",
  "checkin.browse.emptyTitle": "Nothing else today",
  "checkin.browse.emptyBody": "Use your phone number above, or see the front desk.",
  "checkin.addGroup.eyebrow": "Add your group",
  "checkin.addGroup.body":
    "Add anyone with you who still needs an account or a waiver — or have them scan the QR to sign in on their own phone.",
  "checkin.checkingIn": "Checking you in…",
  "checkin.checkEveryone": "Check everyone in",
  "checkin.finishAddingFirst":
    "Finish adding everyone above first — each person needs an account and a signed waiver.",
  "checkin.err.cancelled": "That reservation was cancelled — please see the front desk.",
  "checkin.err.openFail":
    "We couldn’t open that reservation. Please try again or see the front desk.",
  "checkin.err.addFail": "We couldn’t add your group — please see the front desk.",
  "checkin.err.finishing": "One moment — finishing up. Tap again.",
  "checkin.err.checkinFail": "We couldn’t check you in — please see the front desk.",
  "checkin.err.noPhone": "No phone on that booking — please see the front desk.",
  "checkin.err.codeJustSent": "A code was just sent — check your texts, or wait a moment.",
  "checkin.err.sendCodeFail": "We couldn’t send a code. Please see the front desk.",
  "checkin.err.codeNotFound":
    "We couldn’t find that code. Try your phone number, or see the front desk.",
  "checkin.err.enterMobile": "Enter your 10-digit mobile number.",
  "checkin.err.textFail": "We couldn’t text that number. Please check it and try again.",
  "checkin.err.incorrectTries":
    "Incorrect code — {count, plural, one {# try} other {# tries}} left.",
  "checkin.err.codeFailNew": "That code didn’t work. Request a new one.",
  "checkin.err.noReservations":
    "No reservations found for today under that number. See the front desk.",
  "checkin.err.incorrectLeft": "Incorrect code — {count} left.",
  "checkin.err.codeFailBack": "That code didn’t work. Go back and try again.",
  "checkin.otpMaskFallback": "your number on file",
  "checkin.find.usePhone": "Use your phone number",
  "checkin.find.phoneBlurb": "Works for every booking. We’ll text you a quick code.",
  "checkin.find.phoneAria": "Mobile phone number",
  "checkin.find.textCode": "Text me a code",
  "checkin.find.scanNow": "Scan now…",
  "checkin.find.scanMyCode": "Scan my code",
  "checkin.find.scanSub": "Email QR or W-number",
  "checkin.find.findBooking": "Find my booking",
  "checkin.find.findSub": "Pick from today’s list",
  "checkin.otp.verify": "Verify it’s you",
  "checkin.otp.textedTo": "We texted a code to {mask}",
  "checkin.otp.enterCode": "Enter the 6-digit code from your texts.",
  "checkin.otp.aria": "6-digit verification code",
  "checkin.otp.openDay": "Open my day",
  "checkin.itin.firstStop": "Start here · First stop",
  "checkin.itin.arriveBy": "Arrive by {label}",
  "checkin.itin.dueAtDesk": "{amount} due at the front desk — nothing is charged here.",
  "checkin.itin.alreadyOn": "Already on this reservation",
  "checkin.itin.someoneNotOn": "Someone with you who isn’t on this booking?",
  "checkin.itin.startNew": "Start a new booking ›",
  "checkin.done.allCheckedIn": "You’re all checked in.",
  "checkin.done.racersAdded":
    "{count, plural, one {# racer} other {# racers}} added to your race — head over when your heat is called.",
  "checkin.done.frontDeskKnows": "The front desk knows you’re here.",
  "checkin.done.needHand": "{names} may need a hand at the desk — a team member has been notified.",
  "checkin.done.finish": "Done",
  "checkin.lane.idle": "Your lane opens about 30 minutes before your time — we’ll get it ready.",
  "checkin.lane.open": "{lane} is open — shoes are on the way. Have fun!",
  "checkin.lane.failed":
    "We couldn’t open {lane} — please see the front desk and they’ll get you started.",
  "checkin.lane.ready": "{lane} is ready",
  "checkin.lane.readyBody": "Open it now and head over to bowl.",
  "checkin.lane.opening": "Opening your lane…",
  "checkin.lane.openNow": "Open {lane} now",
  "checkin.chip.laneOpens": "Lane opens about 30 minutes before your time",
  "checkin.chip.racersReady": "{ready} of {total} racers ready",
  "checkin.chip.waiversSigned": "{ready} of {total} waivers signed",

  // --- Racing/attraction people step (KioskPeopleStep) — VALIDATION + errors ---
  // The age-gate LOGIC (age < 7 / < 18 branches) is untouched; only display text
  // is keyed. "Duckpin" is a locked glossary noun. The visible add-people /
  // guardian / waiver UI copy in this ~2,255-line file is NOT yet keyed — see the
  // TODO(i18n) in the component and tasks/kiosk-i18n-spanish-plan.md.
  "people.thisRacer": "This racer",
  "people.err.name": "Enter a first and last name.",
  "people.err.dob": "Enter the birthday as MM/DD/YYYY.",
  "people.err.tooYoung":
    "{name} is under 7 — too young to race. Kids under 7 are welcome trackside, or check out Duckpin bowling.",
  "people.err.phone": "Enter a mobile phone number.",
  "people.err.email": "The main person needs an email for the confirmation.",
  "people.err.setupFailMsg": "Couldn’t set that person up: {msg}",
  "people.err.setupFail": "Couldn’t set that person up. Please try again or see the front desk.",
  "people.err.finishFailMsg": "Couldn’t finish setup: {msg}",
  "people.err.finishFail": "Couldn’t finish setup. Please try again or see the front desk.",
  "people.err.licenseMismatch":
    "That license doesn’t look like {name}’s — enter their birthday instead.",

  // --- Flow step-header titles (KioskFlow renders currentStep.title; module-
  // scope StepDef titles are mapped to these keys at the render site) ---
  "stepTitle.lanes": "Lanes",
  "stepTitle.time": "Time",
  "stepTitle.bowlers": "Bowlers",
  "stepTitle.package": "Package",
  "stepTitle.whosBowling": "Who’s bowling?",
  "stepTitle.whosPlaying": "Who’s playing?",
  "stepTitle.whosRacing": "Who’s racing?",

  // --- Bottom utility strip (KioskFlow) ---
  "util.startOver": "Start over",
  "util.mainMenu": "Main menu",
  "util.guestAssistance": "Guest assistance",
  "util.cart": "Cart",
} as const;

/** Keys in this core catalog. The full `MessageKey` (core + per-screen fragment
 *  files) is composed in ./index.ts so parallel screen work never edits this file. */
export type CoreKey = keyof typeof en;
