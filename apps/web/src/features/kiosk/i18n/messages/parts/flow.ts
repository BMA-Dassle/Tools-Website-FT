/** The wizard SHELL itself (KioskFlow) — everything the flow chrome renders
 *  around a step: the activity name in the header, the step counter, Back /
 *  Continue, the signed-in banner, the exit-confirm sheet ("Remove it & go to
 *  main page"), the unracered + phone-sign-in sheets, the guest-assistance
 *  overlay, and the vendor-call loaders. Also the reused-web-step titles and
 *  `canAdvance` hint lines the shell renders on the step's behalf, and the
 *  height/age safety confirm the shell puts up before the race time picker.
 *
 *  Keys live under `flow.*` (plus `stepTitle.*` / `stepReason.*` for the two
 *  English→key lookup maps in KioskFlow — the core catalog owns the bowling
 *  step titles it converted first; these are the remainder). Mirror every key
 *  in es.
 *
 *  es values are a first-pass AI translation pending native-Spanish review.
 *  Locked glossary — NEVER translated: FastTrax, HeadPinz, Game Zone, Podium,
 *  Pit Crew, Duckpin, Gel Blaster, Laser Tag, Shuffly, Kids Bowl Free. */
export const flowEn = {
  // --- Activity names (wizard header + exit-confirm copy) ---
  // Product/brand nouns stay English per the glossary; only the descriptive
  // ones ("Racing", "Bowling", "Attraction") localize.
  "flow.activity.racing": "Racing",
  "flow.activity.bowling": "Bowling",
  "flow.activity.kbf": "Kids Bowl Free",
  "flow.activity.racesim": "Race Sims",
  "flow.activity.gelBlaster": "Gel Blaster",
  "flow.activity.laserTag": "Laser Tag",
  "flow.activity.duckpin": "Duckpin",
  "flow.activity.shuffleboard": "Shuffleboard",
  "flow.activity.generic": "Attraction",
  /** Mid-sentence fallback when there is no active item — reads inside the
   *  exit-confirm copy ("Your activity isn’t finished"), so it stays lowercase. */
  "flow.activity.fallback": "activity",

  // --- Header / action zone ---
  "flow.stepOf": "Step {current} of {total}",
  "flow.back": "Back",
  "flow.continue": "Continue",
  "flow.addToVisit": "Add to my visit",

  // --- Session banner (who’s signed in · what’s in the cart) ---
  // The guest's first name renders bolded between `signedIn` and `plusGuests`,
  // so the strip is keyed as its own pieces rather than one rich-text string
  // (the express-badge lesson: inline bold made the sentence untranslatable).
  "flow.banner.signedIn": "Signed in ·",
  "flow.banner.plusGuests": "{count, plural, one {+ # guest} other {+ # guests}}",
  "flow.banner.visitInProgress": "Visit in progress",
  "flow.banner.gameCards": "Game cards",
  "flow.banner.viewCart": "View cart ›",

  // --- Exit-confirm sheet: Start over / Main menu / cart with a live flow ---
  // `{activity}` is the activity name above (or a combo's product name, which
  // comes from data and stays as returned).
  "flow.exit.eyebrow.startOver": "Start over?",
  "flow.exit.eyebrow.cart": "Go to your cart?",
  "flow.exit.eyebrow.home": "Back to the main page?",
  "flow.exit.title.startOver": "This clears your whole visit",
  "flow.exit.title.booked": "Your {activity} is booked — it stays in your cart",
  "flow.exit.title.unfinished": "Your {activity} isn’t finished",
  "flow.exit.body.startOver":
    "We’ll clear everyone’s names, empty your cart, release any held times, and sign you out of this kiosk.",
  "flow.exit.body.booked":
    "Your reserved times stay held and everything you’ve set up is kept — open the {activity} from the cart any time before you pay.",
  "flow.exit.body.bookedCards":
    "Your reserved times stay held and everything you’ve set up is kept — open the {activity} from the cart any time before you pay. (Removing it instead would also remove the Game Zone cards riding with it.)",
  "flow.exit.body.unfinished":
    "We’ll remove the unfinished {activity} from your cart. Everything else in your cart stays, and your group stays signed in.",
  "flow.exit.body.unfinishedCards":
    "We’ll remove the unfinished {activity} from your cart (and the Game Zone cards riding with it). Everything else in your cart stays, and your group stays signed in.",
  "flow.exit.keepAndCart": "Keep my {activity} & view cart",
  "flow.exit.keepAndHome": "Keep my {activity} & go to main page",
  "flow.exit.keepVisit": "Keep my visit",
  "flow.exit.stayHere": "Stay here",
  "flow.exit.keepWorking": "Keep working on it",
  "flow.exit.yesStartOver": "Yes — start over",
  "flow.exit.cancelBooked": "Cancel my {activity} & remove it from the cart",
  "flow.exit.removeAndCart": "Remove it & view cart",
  "flow.exit.removeAndHome": "Remove it & go to main page",

  // --- Mixed-tier guard: someone in the party has no race yet ---
  // `{names}` is a "&"-joined list of typed first names (data); `{package}` is a
  // race package product name (data).
  "flow.unracered.title":
    "{names} {count, plural, one {isn’t in a race yet} other {aren’t in a race yet}}",
  "flow.unracered.bodyPackage":
    "They weren’t included in the {package}. Add them to the same heats, or continue without racing them.",
  "flow.unracered.body":
    "This race is above their level or they weren’t added to a heat. Add a race that fits them — your picked heats are saved — or continue without racing them.",
  "flow.unracered.addToPackage": "Add {names} to the {package}",
  "flow.unracered.addRace": "Add a race for {names}",
  "flow.unracered.notRacing": "Not racing today — continue",

  // --- Phone sign-in still running when Continue is tapped ---
  "flow.mobileJoin.eyebrow": "Phone sign-in in progress",
  "flow.mobileJoin.title":
    "{count, plural, one {Someone’s still signing in on their phone} other {# people are still signing in on their phones}}",
  "flow.mobileJoin.body":
    "{count, plural, one {Continuing now cancels that sign-in — they’d need to be added here at the kiosk instead.} other {Continuing now cancels those sign-ins — they’d need to be added here at the kiosk instead.}} Anyone who already finished is on your list.",
  "flow.mobileJoin.wait": "Wait for them to finish",
  "flow.mobileJoin.continueAnyway": "Continue anyway — cancel phone sign-in",
  "flow.mobileJoin.done.eyebrow": "All set",
  "flow.mobileJoin.done.title": "They finished — everyone’s on your list",
  "flow.mobileJoin.done.body":
    "The phone sign-in wrapped up while you waited. You’re good to continue.",
  "flow.mobileJoin.done.continue": "Continue",
  "flow.mobileJoin.done.stay": "Stay on this step",

  // --- Guest-assistance overlay (help button / card-dispenser failure) ---
  "flow.assist.cardError.title": "Card error",
  "flow.assist.cardError.body":
    "There’s a problem with the card dispenser — a team member will be right with you. Stay right here.",
  "flow.assist.help.title": "Help is on the way",
  "flow.assist.help.body":
    "Stay right here — a team member is coming to assist you. Your booking is held exactly where you left it.",
  "flow.assist.clear": "All set — clear",

  // --- Height & age safety confirm (HeightAgeConfirmModal) ---
  // Shared with the web wizard, which supplies its own date-flow wording via the
  // `subheading` / `confirmLabel` props; the kiosk passes the *Kiosk keys below
  // (walk-up = always today, so it says "pick a time", not "pick a date").
  //
  // The requirement CLAUSES are one whole sentence per plural branch rather than
  // a stem plus a spliced verb — Spanish has to agree across "tiene/tienen" and
  // "mide/miden", which a shared stem can't express. The inch figures are the
  // enforced rule and stay; the Spanish adds a metric restatement in the
  // parenthetical the way the English restates 59" as 4'11".
  "heightAge.aria": "Height and age confirmation",
  "heightAge.title": "Confirm Height & Age",
  "heightAge.subheading": "Please confirm each requirement below before picking a date.",
  "heightAge.confirmDate": "Confirm & Pick a Date →",
  "heightAge.subheadingKiosk":
    "Quick safety check — confirm each requirement, then pick your race time.",
  "heightAge.confirmContinue": "Confirm & continue →",
  "heightAge.adults":
    "{count, plural, one {I have 1 adult racer who is at least 13 years old and at least 59″ tall (4′11″)} other {I have # adult racers who are each at least 13 years old and at least 59″ tall (4′11″)}}",
  "heightAge.juniors":
    "{count, plural, one {I have 1 junior racer who is between ages 7–13 and between 49″ and 70″ tall} other {I have # junior racers who are each between ages 7–13 and between 49″ and 70″ tall}}",
  "heightAge.notPermitted":
    "I understand that racers who do not meet height or age requirements will not be permitted to race",
  "heightAge.strictRules":
    "FastTrax has strict age and height requirements, some enforceable by state regulations. Misrepresenting age may result in removal from the facility.",
  "heightAge.checkAll": "Please check all boxes above to continue",
  "heightAge.changeParty": "Change Party Size",

  // --- Tier-expectation warnings (race-warnings.ts) ---
  //
  // Shown when a guest is about to book a race that is slower than they expect.
  // The registry decides WHEN; these decide what it says. Keys are per-warning
  // (`raceWarning.<id>.*`) so adding a warning for another category or tier is
  // a data change plus its own copy block — see race-warnings.ts.
  //
  // "Junior Starter", "Ultimate Qualifier" and "Intermediate" are product
  // names and stay English in both locales.
  "raceWarning.checkAll": "Please tick every box to continue",
  "raceWarning.goBack": "Go back",

  "raceWarning.juniorStarter.title": "Before You Book Junior Starter",
  "raceWarning.juniorStarter.body":
    "Junior Starter runs at our slowest kart speed — every junior racer starts here, no matter how much driving experience they already have. If your child already drives go-karts or anything similar, we strongly recommend the Ultimate Qualifier instead: two races, one at Starter speed to qualify and a second at Intermediate speed once they level up.",
  "raceWarning.juniorStarter.permanent":
    "Levelling up is not optional, and it is permanent on your child’s racing account.",
  "raceWarning.juniorStarter.ack.slow":
    "I understand Junior Starter runs at our slowest speed, and that every junior racer starts here regardless of experience.",
  "raceWarning.juniorStarter.ack.permanent":
    "I understand that if my child qualifies, the level-up is automatic — not optional — and stays on their account permanently.",
  "raceWarning.juniorStarter.ack.declined":
    "I was offered the Ultimate Qualifier and I choose to book Junior Starter only.",
  "raceWarning.juniorStarter.continue": "Continue with Junior Starter",
  "raceWarning.juniorStarter.upsell": "Book Ultimate Qualifier instead",

  // --- Heat grid: what the times on the cards MEAN (kiosk only) -------------
  //
  // The grid is the first place a guest ever sees one of these times, so getting
  // the model right here saves every later surface from undoing it.
  //
  // KIOSK ONLY, deliberately. At pick time we do not know whether the party will
  // be Express Lane, and a standard guest checks in at GUEST SERVICES on the 2nd
  // floor half an hour earlier — so naming the karting desk on the web could send
  // them to the wrong floor (owner 2026-08-17). On a kiosk the guest is already in
  // the building at the karting end, and the karting desk is the only check-in the
  // screen can mean.
  //
  // The English here mirrors lib/karting-checkin-copy.ts, which stays the source
  // of truth for every non-kiosk surface. The place is spelled out rather than
  // interpolated from that module so the Spanish can translate it.
  "race.heat.kartingCheckIn": "Karting Check In",
  // "Est." is load-bearing (owner 2026-08-17: "make sure we put est.") — the
  // number moves through the night and must never read as a promise.
  "race.heat.racingBy": "Est. racing by {time}",
  "race.heat.bannerTitle": "These are karting check-in times",
  "race.heat.bannerBody":
    "Not your race time. Be at the Karting Desk — 1st Floor, by the Red Track — by the time you pick.",
  "race.heat.bannerAllowance":
    "Racing starts after your safety briefing · allow up to {mins} min after check-in (est.)",

  // --- Package disclaimers (PackageDefinition.disclaimers, lib/packages.ts) ---
  //
  // Shown when a guest picks a bundle whose second heat is CONDITIONAL on
  // qualifying. Keyed rather than kept as literals in the registry because this
  // modal renders on the kiosk: a Spanish-speaking parent was otherwise being
  // asked to tick three English boxes accepting a no-cash-refund term.
  //
  // The 75% figure is the house qualification rate and is stated in both
  // locales. "Starter" / "Intermediate" / "Ultimate Qualifier" / "FastTrax" are
  // product names and stay English.
  "packageDisclaimer.continue": "I Accept · Continue",

  "packageDisclaimer.uq.title": "Heads Up — Ultimate Qualifier",
  "packageDisclaimer.uq.body":
    "Your Intermediate race in this package is reserved on the assumption you qualify in your Starter heat. About 75% of new racers level up on their first try. If you don’t qualify, no problem — but please read carefully before continuing:",
  "packageDisclaimer.uq.ack.conditional":
    "I understand the Intermediate race is reserved only if I qualify (level up) in my Starter race",
  "packageDisclaimer.uq.ack.noRefund":
    "If I don’t qualify, FastTrax will offer me another Starter race (if available) OR race credit toward a future visit — no cash refunds for this package",
  "packageDisclaimer.uq.ack.accept": "I have read and accept these terms",

  "packageDisclaimer.bogo.title": "Heads Up — BOGO Races",
  "packageDisclaimer.bogo.body":
    "Your second race in this deal is an Intermediate heat, reserved on the assumption you qualify in your Starter race. About 75% of new racers level up on their first try. If you don’t, you’ll have paid the regular price of a single race — nothing extra — and we’ll make it right. Please read before continuing:",
  "packageDisclaimer.bogo.ack.conditional":
    "I understand the second (Intermediate) race is reserved only if I qualify (level up) in my Starter race",
  "packageDisclaimer.bogo.ack.noRefund":
    "If I don’t qualify, FastTrax will offer me another Starter race (if available) OR race credit toward a future visit — no cash refunds for this deal",
  "packageDisclaimer.bogo.ack.noExtras":
    "I understand this deal does NOT include the FastTrax license, POV video, or appetizer",
  "packageDisclaimer.bogo.ack.accept": "I have read and accept these terms",

  // --- Live progress under a vendor call ---
  "flow.progress.reservingHeats": "Reserving your heats…",
  "flow.progress.checkingInfo": "Checking everyone’s latest info…",
  "flow.progress.reservingSlot": "Reserving your slot…",

  // --- Guest-facing flow errors ---
  // `{msg}` is the vendor's / browser's own error text and stays as returned
  // (same convention as the camera errors in misc.ts).
  "flow.err.comboIncludesRacing":
    "Your VIP Experience already includes racing — it’s all in one price.",
  "flow.err.comboIncludesVipLane":
    "Your VIP Experience includes a VIP lane. To add a separate lane for extra guests, finish this checkout first, then book bowling as its own order — takes under a minute.",
  "flow.err.finishBeforePremium":
    "Finish or remove your current activities before starting a premium racing experience.",
  "flow.err.finishBeforeBundle":
    "Finish or remove your current activities before adding a bundled experience.",
  "flow.err.heatsFailedMsg": "Couldn’t reserve those heats: {msg}",
  "flow.err.heatsFailed": "Couldn’t reserve those heats. Please try again.",
  "flow.err.timeFailedMsg": "Couldn’t reserve that time: {msg}",
  "flow.err.timeFailed": "Couldn’t reserve that time. Please try again.",
  "flow.err.waiverInvalid":
    "{names} {count, plural, one {needs} other {need}} a new waiver — the one on file is no longer valid.",

  // --- Loaders over real vendor calls ---
  "flow.loader.warmingUp": "Warming up…",
  "flow.loader.clearing": "Clearing this session…",
  "flow.loader.comboBooking": "Booking your experience",
  "flow.loader.comboBookingSub": "Reserving your races and holding your lane…",
  "flow.loader.lockingRaces": "Locking in your races",
  "flow.loader.reservingTime": "Reserving your time",
  "flow.loader.oneMoment": "One moment…",

  // --- Hold expired (ReservationExpiredModal — shared with the web wizard) ---
  "flow.expired.aria": "Reservation expired",
  "flow.expired.title": "Reservation Expired",
  "flow.expired.body":
    "Your 10-minute hold has ended. Extend your time to keep your selected heats, or start a new booking.",
  "flow.expired.error": "Could not extend your reservation. Please try again or start over.",
  "flow.expired.startOver": "Start Over",
  "flow.expired.extend": "Extend Time",
  "flow.expired.extending": "Extending…",

  // --- Reused-web-step titles (STEP_TITLE_KEYS) ---
  // The bowling/people titles the first i18n pass converted live in the core
  // catalog; these are the steps the attraction flow adds.
  "stepTitle.yourInfo": "Your Info",
  "stepTitle.activity": "Activity",

  // --- `canAdvance` hint lines (STEP_REASON_KEYS) ---
  // Rendered by the flow shell under the step when Continue is blocked. Keyed by
  // the step's English reason string — module-scope canAdvance can't reach useT.
  "stepReason.contact": "Enter your contact info to continue.",
  "stepReason.attractionProduct": "Choose an activity to continue.",
  "stepReason.attractionDate": "Pick a date to continue.",
  "stepReason.attractionSlot": "Pick a time slot to continue.",
  "stepReason.kioskSlot": "Pick a time to continue.",
  "stepReason.addPlayer": "Add at least one player — everyone needs an account and waiver.",
  "stepReason.addBowler": "Add at least one bowler first.",
  "stepReason.reserveLane": "Reserve a lane time",
  "stepReason.pickClassicOrVip": "Pick Classic or VIP.",
  "stepReason.pickRegularOrVip": "Choose Regular or VIP",
  "stepReason.pickDate": "Pick a date",
  "stepReason.pickTime": "Pick a time",
  "stepReason.pickPackage": "Pick a package",
  "stepReason.selectTimeSlot": "Select a time slot",
  "stepReason.selectBowler": "Select at least 1 bowler",
  "stepReason.selectBowlerKbf": "Select at least one bowler",
  "stepReason.holdLane": "Tap a time to hold your lane",
  "stepReason.verifyKbf": "Verify your KBF pass first",
  "stepReason.worldCupMatch": "Pick your match to hold a VIP lane",
  "stepReason.comboStart": "Pick a start time",
  "stepReason.raceEntryMode": "Choose new or returning racer to continue.",
  "stepReason.addRacer": "Add at least one racer to continue.",
  "stepReason.racerFirstName": "Every party member needs a first name.",
  "stepReason.raceDay": "Pick a race day to continue.",
  "stepReason.megaTuesday": "Mega Tuesdays run Junior Pro races only.",
  "stepReason.racePackAdded": "Race pack added — now pick which race to run today.",
  "stepReason.pickAdultRace": "Pick an adult race to continue.",
  "stepReason.pickJuniorRace": "Pick a junior race to continue.",
} as const;

export const flowEs: Record<keyof typeof flowEn, string> = {
  // --- Activity names ---
  "flow.activity.racing": "Carreras",
  "flow.activity.bowling": "Boliche",
  "flow.activity.kbf": "Kids Bowl Free",
  "flow.activity.racesim": "Race Sims",
  "flow.activity.gelBlaster": "Gel Blaster",
  "flow.activity.laserTag": "Laser Tag",
  "flow.activity.duckpin": "Duckpin",
  "flow.activity.shuffleboard": "Shuffleboard",
  "flow.activity.generic": "Atracción",
  "flow.activity.fallback": "actividad",

  // --- Header / action zone ---
  "flow.stepOf": "Paso {current} de {total}",
  "flow.back": "Atrás",
  "flow.continue": "Continuar",
  "flow.addToVisit": "Agregar a mi visita",

  // --- Session banner ---
  "flow.banner.signedIn": "Sesión iniciada ·",
  "flow.banner.plusGuests": "{count, plural, one {+ # invitado} other {+ # invitados}}",
  "flow.banner.visitInProgress": "Visita en curso",
  "flow.banner.gameCards": "Tarjetas de juego",
  "flow.banner.viewCart": "Ver carrito ›",

  // --- Exit-confirm sheet ---
  "flow.exit.eyebrow.startOver": "¿Empezar de nuevo?",
  "flow.exit.eyebrow.cart": "¿Ir a tu carrito?",
  "flow.exit.eyebrow.home": "¿Volver a la página principal?",
  "flow.exit.title.startOver": "Esto borra toda tu visita",
  "flow.exit.title.booked": "Tu {activity} ya está reservado — se queda en tu carrito",
  "flow.exit.title.unfinished": "Tu {activity} no está terminado",
  "flow.exit.body.startOver":
    "Borraremos los nombres de todos, vaciaremos tu carrito, liberaremos las horas apartadas y cerraremos tu sesión en este kiosco.",
  "flow.exit.body.booked":
    "Tus horas reservadas siguen apartadas y todo lo que configuraste se guarda — abre {activity} desde el carrito en cualquier momento antes de pagar.",
  "flow.exit.body.bookedCards":
    "Tus horas reservadas siguen apartadas y todo lo que configuraste se guarda — abre {activity} desde el carrito en cualquier momento antes de pagar. (Si en vez de eso lo quitas, también se quitarán las tarjetas de Game Zone que van con él).",
  "flow.exit.body.unfinished":
    "Quitaremos {activity} sin terminar de tu carrito. Todo lo demás en tu carrito se queda, y tu grupo sigue con la sesión iniciada.",
  "flow.exit.body.unfinishedCards":
    "Quitaremos {activity} sin terminar de tu carrito (y las tarjetas de Game Zone que van con él). Todo lo demás en tu carrito se queda, y tu grupo sigue con la sesión iniciada.",
  "flow.exit.keepAndCart": "Conservar mi {activity} y ver el carrito",
  "flow.exit.keepAndHome": "Conservar mi {activity} e ir a la página principal",
  "flow.exit.keepVisit": "Conservar mi visita",
  "flow.exit.stayHere": "Quedarme aquí",
  "flow.exit.keepWorking": "Seguir con esto",
  "flow.exit.yesStartOver": "Sí — empezar de nuevo",
  "flow.exit.cancelBooked": "Cancelar mi {activity} y quitarlo del carrito",
  "flow.exit.removeAndCart": "Quitarlo y ver el carrito",
  "flow.exit.removeAndHome": "Quitarlo e ir a la página principal",

  // --- Mixed-tier guard ---
  "flow.unracered.title":
    "{names} {count, plural, one {todavía no está en una carrera} other {todavía no están en una carrera}}",
  "flow.unracered.bodyPackage":
    "No se incluyeron en {package}. Agrégalos a las mismas mangas, o continúa sin que corran.",
  "flow.unracered.body":
    "Esta carrera está por encima de su nivel o no se agregaron a una manga. Agrega una carrera que les quede — tus mangas elegidas se guardan — o continúa sin que corran.",
  "flow.unracered.addToPackage": "Agregar a {names} a {package}",
  "flow.unracered.addRace": "Agregar una carrera para {names}",
  "flow.unracered.notRacing": "Hoy no corren — continuar",

  // --- Phone sign-in in progress ---
  "flow.mobileJoin.eyebrow": "Inicio de sesión por teléfono en curso",
  "flow.mobileJoin.title":
    "{count, plural, one {Alguien todavía está iniciando sesión en su teléfono} other {# personas todavía están iniciando sesión en sus teléfonos}}",
  "flow.mobileJoin.body":
    "{count, plural, one {Continuar ahora cancela ese inicio de sesión — habría que agregarlo aquí en el kiosco.} other {Continuar ahora cancela esos inicios de sesión — habría que agregarlos aquí en el kiosco.}} Quien ya terminó está en tu lista.",
  "flow.mobileJoin.wait": "Esperar a que terminen",
  "flow.mobileJoin.continueAnyway":
    "Continuar de todos modos — cancelar el inicio de sesión por teléfono",
  "flow.mobileJoin.done.eyebrow": "Todo listo",
  "flow.mobileJoin.done.title": "Terminaron — todos están en tu lista",
  "flow.mobileJoin.done.body":
    "El inicio de sesión por teléfono terminó mientras esperabas. Puedes continuar.",
  "flow.mobileJoin.done.continue": "Continuar",
  "flow.mobileJoin.done.stay": "Quedarme en este paso",

  // --- Guest-assistance overlay ---
  "flow.assist.cardError.title": "Error de tarjeta",
  "flow.assist.cardError.body":
    "Hay un problema con el dispensador de tarjetas — un miembro del equipo estará contigo enseguida. Quédate aquí.",
  "flow.assist.help.title": "La ayuda va en camino",
  "flow.assist.help.body":
    "Quédate aquí — un miembro del equipo viene a ayudarte. Tu reservación queda exactamente donde la dejaste.",
  "flow.assist.clear": "Todo listo — cerrar",

  // --- Height & age safety confirm ---
  "heightAge.aria": "Confirmación de estatura y edad",
  "heightAge.title": "Confirma estatura y edad",
  "heightAge.subheading": "Confirma cada requisito de abajo antes de elegir una fecha.",
  "heightAge.confirmDate": "Confirmar y elegir una fecha →",
  "heightAge.subheadingKiosk":
    "Chequeo rápido de seguridad — confirma cada requisito y luego elige tu hora de carrera.",
  "heightAge.confirmContinue": "Confirmar y continuar →",
  "heightAge.adults":
    "{count, plural, one {Tengo 1 corredor adulto que tiene al menos 13 años y mide al menos 59 pulgadas (1.50 m)} other {Tengo # corredores adultos que tienen al menos 13 años y miden al menos 59 pulgadas (1.50 m)}}",
  "heightAge.juniors":
    "{count, plural, one {Tengo 1 corredor junior que tiene entre 7 y 13 años y mide entre 49 y 70 pulgadas (1.24 m y 1.78 m)} other {Tengo # corredores junior que tienen entre 7 y 13 años y miden entre 49 y 70 pulgadas (1.24 m y 1.78 m)}}",
  "heightAge.notPermitted":
    "Entiendo que los corredores que no cumplan con los requisitos de estatura o edad no podrán correr",
  "heightAge.strictRules":
    "FastTrax tiene requisitos estrictos de edad y estatura, algunos exigidos por regulaciones estatales. Declarar una edad falsa puede resultar en la expulsión de las instalaciones.",
  "heightAge.checkAll": "Marca todas las casillas de arriba para continuar",
  "heightAge.changeParty": "Cambiar el tamaño del grupo",

  // --- Avisos de nivel de carrera ---
  // "tu corredor" rather than "tu hijo/a": the racer is who the sentence is
  // about, it avoids gendering a child the booking never asked us to gender,
  // and it matches the vernacular the rest of the kiosk already uses.
  "raceWarning.checkAll": "Marca todas las casillas para continuar",
  "raceWarning.goBack": "Regresar",

  "raceWarning.juniorStarter.title": "Antes de reservar Junior Starter",
  "raceWarning.juniorStarter.body":
    "Junior Starter es nuestra carrera más lenta — todos los corredores juveniles empiezan aquí, sin importar cuánta experiencia tengan manejando. Si tu corredor ya maneja go-karts o algo parecido, te recomendamos el Ultimate Qualifier: dos carreras, una a velocidad Starter para calificar y otra a velocidad Intermediate cuando suba de nivel.",
  "raceWarning.juniorStarter.permanent":
    "Subir de nivel no es opcional y queda permanente en la cuenta de tu corredor.",
  "raceWarning.juniorStarter.ack.slow":
    "Entiendo que Junior Starter es nuestra carrera más lenta y que todos los corredores juveniles empiezan aquí, sin importar su experiencia.",
  "raceWarning.juniorStarter.ack.permanent":
    "Entiendo que si mi corredor califica, subir de nivel es automático — no opcional — y queda permanente en su cuenta.",
  "raceWarning.juniorStarter.ack.declined":
    "Me ofrecieron el Ultimate Qualifier y elijo reservar solo Junior Starter.",
  "raceWarning.juniorStarter.continue": "Continuar con Junior Starter",
  "raceWarning.juniorStarter.upsell": "Mejor reservar Ultimate Qualifier",

  // --- Heat grid: what the times on the cards MEAN (kiosk only) -------------
  // "Karting" stays English (brand/product noun, same rule as FastTrax and Game
  // Zone). "Registro" is the catalog's established noun for check-in, and
  // "Mostrador" is the counter a guest walks up to — what someone navigating the
  // building is actually looking for.
  "race.heat.kartingCheckIn": "Registro de Karting",
  // "aprox." carries the same warning as the English "Est."
  "race.heat.racingBy": "En pista aprox. {time}",
  "race.heat.bannerTitle": "Estos son los horarios de registro de Karting",
  "race.heat.bannerBody":
    "No es la hora de tu carrera. Preséntate en el Mostrador de Karting — 1er piso, junto a la pista Red — a la hora que elijas.",
  "race.heat.bannerAllowance":
    "La carrera empieza después de tu charla de seguridad · calcula hasta {mins} min desde el registro (aprox.)",

  // --- Avisos de paquetes con carrera condicionada ---
  "packageDisclaimer.continue": "Acepto · Continuar",

  "packageDisclaimer.uq.title": "Atención — Ultimate Qualifier",
  "packageDisclaimer.uq.body":
    "La carrera Intermediate de este paquete se reserva asumiendo que califiques en tu carrera Starter. Cerca del 75% de los corredores nuevos suben de nivel en su primer intento. Si no calificas, no hay problema — pero lee esto con atención antes de continuar:",
  "packageDisclaimer.uq.ack.conditional":
    "Entiendo que la carrera Intermediate se reserva solo si califico (subo de nivel) en mi carrera Starter",
  "packageDisclaimer.uq.ack.noRefund":
    "Si no califico, FastTrax me ofrecerá otra carrera Starter (si hay disponible) O crédito para una próxima visita — no hay reembolsos en efectivo por este paquete",
  "packageDisclaimer.uq.ack.accept": "He leído y acepto estos términos",

  "packageDisclaimer.bogo.title": "Atención — Carreras BOGO",
  "packageDisclaimer.bogo.body":
    "Tu segunda carrera en esta oferta es una manga Intermediate, reservada asumiendo que califiques en tu carrera Starter. Cerca del 75% de los corredores nuevos suben de nivel en su primer intento. Si no lo logras, habrás pagado el precio normal de una sola carrera — nada extra — y lo compensaremos. Lee esto antes de continuar:",
  "packageDisclaimer.bogo.ack.conditional":
    "Entiendo que la segunda carrera (Intermediate) se reserva solo si califico (subo de nivel) en mi carrera Starter",
  "packageDisclaimer.bogo.ack.noRefund":
    "Si no califico, FastTrax me ofrecerá otra carrera Starter (si hay disponible) O crédito para una próxima visita — no hay reembolsos en efectivo por esta oferta",
  "packageDisclaimer.bogo.ack.noExtras":
    "Entiendo que esta oferta NO incluye la licencia FastTrax, el video POV ni el aperitivo",
  "packageDisclaimer.bogo.ack.accept": "He leído y acepto estos términos",

  // --- Live progress under a vendor call ---
  "flow.progress.reservingHeats": "Reservando tus mangas…",
  "flow.progress.checkingInfo": "Revisando la información más reciente de todos…",
  "flow.progress.reservingSlot": "Reservando tu horario…",

  // --- Guest-facing flow errors ---
  "flow.err.comboIncludesRacing":
    "Tu Experiencia VIP ya incluye carreras — todo va en un solo precio.",
  "flow.err.comboIncludesVipLane":
    "Tu Experiencia VIP incluye una pista VIP. Para agregar una pista aparte para invitados adicionales, primero termina este pago y luego reserva el boliche como una orden aparte — toma menos de un minuto.",
  "flow.err.finishBeforePremium":
    "Termina o quita tus actividades actuales antes de empezar una experiencia de carreras premium.",
  "flow.err.finishBeforeBundle":
    "Termina o quita tus actividades actuales antes de agregar una experiencia combinada.",
  "flow.err.heatsFailedMsg": "No se pudieron reservar esas mangas: {msg}",
  "flow.err.heatsFailed": "No se pudieron reservar esas mangas. Inténtalo de nuevo.",
  "flow.err.timeFailedMsg": "No se pudo reservar esa hora: {msg}",
  "flow.err.timeFailed": "No se pudo reservar esa hora. Inténtalo de nuevo.",
  "flow.err.waiverInvalid":
    "{names} {count, plural, one {necesita} other {necesitan}} una exención nueva — la que hay en el archivo ya no es válida.",

  // --- Loaders ---
  "flow.loader.warmingUp": "Preparando…",
  "flow.loader.clearing": "Borrando esta sesión…",
  "flow.loader.comboBooking": "Reservando tu experiencia",
  "flow.loader.comboBookingSub": "Reservando tus carreras y apartando tu pista…",
  "flow.loader.lockingRaces": "Confirmando tus carreras",
  "flow.loader.reservingTime": "Reservando tu hora",
  "flow.loader.oneMoment": "Un momento…",

  // --- Hold expired ---
  "flow.expired.aria": "Reservación vencida",
  "flow.expired.title": "Reservación vencida",
  "flow.expired.body":
    "Tu apartado de 10 minutos terminó. Extiende tu tiempo para conservar las mangas que elegiste, o empieza una reservación nueva.",
  "flow.expired.error":
    "No se pudo extender tu reservación. Inténtalo de nuevo o empieza de nuevo.",
  "flow.expired.startOver": "Empezar de nuevo",
  "flow.expired.extend": "Extender tiempo",
  "flow.expired.extending": "Extendiendo…",

  // --- Reused-web-step titles ---
  "stepTitle.yourInfo": "Tus datos",
  "stepTitle.activity": "Actividad",

  // --- `canAdvance` hint lines ---
  "stepReason.contact": "Ingresa tus datos de contacto para continuar.",
  "stepReason.attractionProduct": "Elige una actividad para continuar.",
  "stepReason.attractionDate": "Elige una fecha para continuar.",
  "stepReason.attractionSlot": "Elige un horario para continuar.",
  "stepReason.kioskSlot": "Elige una hora para continuar.",
  "stepReason.addPlayer": "Agrega al menos un jugador — todos necesitan una cuenta y una exención.",
  "stepReason.addBowler": "Agrega primero al menos un jugador.",
  "stepReason.reserveLane": "Reserva una hora de pista",
  "stepReason.pickClassicOrVip": "Elige Classic o VIP.",
  "stepReason.pickRegularOrVip": "Elige Regular o VIP",
  "stepReason.pickDate": "Elige una fecha",
  "stepReason.pickTime": "Elige una hora",
  "stepReason.pickPackage": "Elige un paquete",
  "stepReason.selectTimeSlot": "Selecciona un horario",
  "stepReason.selectBowler": "Selecciona al menos 1 jugador",
  "stepReason.selectBowlerKbf": "Selecciona al menos un jugador",
  "stepReason.holdLane": "Toca una hora para apartar tu pista",
  "stepReason.verifyKbf": "Primero verifica tu pase de KBF",
  "stepReason.worldCupMatch": "Elige tu partido para apartar una pista VIP",
  "stepReason.comboStart": "Elige una hora de inicio",
  "stepReason.raceEntryMode": "Elige corredor nuevo o que regresa para continuar.",
  "stepReason.addRacer": "Agrega al menos un corredor para continuar.",
  "stepReason.racerFirstName": "Cada integrante del grupo necesita un nombre.",
  "stepReason.raceDay": "Elige un día de carreras para continuar.",
  "stepReason.megaTuesday": "Los Mega Tuesdays solo tienen carreras Junior Pro.",
  "stepReason.racePackAdded": "Paquete de carreras agregado — ahora elige qué carrera correr hoy.",
  "stepReason.pickAdultRace": "Elige una carrera de adultos para continuar.",
  "stepReason.pickJuniorRace": "Elige una carrera junior para continuar.",
};
