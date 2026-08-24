/** Race-pack i18n fragment — the standalone purchase flow (KioskRacePackFlow),
 *  the in-booking teaser (RacePackTeaser) and the shared picker/assignment list
 *  (RacePackPicker). Add `"racePack.*"` keys; mirror every key in es.
 *  "Race pack"/"Pit Crew" glossary.
 *
 *  es values are a first-pass AI translation pending native-Spanish review. Per
 *  the locked glossary, the product noun "Race pack"/"pack" and FastTrax stay
 *  untranslated. {amount}/{price} are pre-formatted "$X.XX" strings built in the
 *  component (server-authoritative totals are never touched by translation);
 *  {count}/{names} interpolate. */
export const racepackEn = {
  "racePack.eyebrow": "Race packs",

  // --- DONE screen ---
  "racePack.done.title": "You’re loaded up.",
  "racePack.done.racesBold": "{count, plural, one {# race} other {# races}}",
  "racePack.done.onAccount": "on their account — never expire",
  "racePack.done.creditsLoading": "Credits are loading — ready in a few minutes",
  "racePack.done.licenseAddedBold": "FastTrax License added",
  "racePack.done.licenseAddedRest":
    "for {names} — good for a year, helmets & safety gear included. You’re cleared to race.",
  "racePack.done.licenseSettingUp":
    "Your license is being set up — please check in at the front desk so we can finish it (no need to pay again).",
  "racePack.done.checkInAnyVisit":
    "Check in with their phone number any visit — the credits pay for races at checkout.",
  "racePack.done.raceToday": "Race today — use one now",
  "racePack.done.done": "Done",

  // --- ERROR (post-payment) ---
  "racePack.error.title": "Almost there",
  "racePack.error.body":
    "We received your payment but couldn’t finish — please see the front desk (do not pay again).",
  "racePack.error.backToStart": "Back to start",

  // --- PAY / finalizing ---
  "racePack.finalizing.title": "Loading the credits…",
  "racePack.finalizing.body": "Payment received — putting the races on the account.",
  "racePack.err.startReaderPayment": "Couldn’t start the reader payment.",

  // --- BUILD: who + packs ---
  "racePack.build.title": "Prepay races — bank them on an account.",
  "racePack.build.subtitle":
    "Sign in or set up each racer, then pick their pack. Credits never expire and pay for races at checkout — today or any visit.",
  "racePack.build.pickPacks": "Pick their packs",
  "racePack.build.finishSetup": "finish their setup above first",
  "racePack.build.racesWord": "races",
  "racePack.build.monThu": "Mon–Thu",
  "racePack.build.anyDay": "Any day",
  "racePack.build.perRace": "{price}/race",
  "racePack.build.licenseRequired": "FastTrax License required",
  "racePack.build.licenseLead":
    "{count, plural, one {First-time racer needs a FastTrax Racing License to get on track —} other {First-time racers need a FastTrax Racing License to get on track —}}",
  "racePack.build.licensePriceEach": "{price} each",
  "racePack.build.licenseTail":
    "{count, plural, one {, good for a full year and includes use of our helmets & safety gear. We’ll add it now so they’re ready to race.} other {, good for a full year and includes use of our helmets & safety gear. We’ll add it now so they’re all ready to race.}}",
  "racePack.build.licenseFor": "License for: {names}",
  "racePack.build.fineprint": "One pack per racer · non-transferable · credits never expire.",
  "racePack.build.readerUnavailable":
    "The card reader isn’t available on this kiosk — please see the front desk to buy a race pack.",
  "racePack.build.payButton": "Pay {amount} + tax on the reader",
  "racePack.build.pickToContinue": "Pick a pack to continue",
  "racePack.build.back": "Back",

  // --- TEASER (race product step) — {sizes} is a digit list ("3 · 5 · 10")
  // built from the packs on sale today, so no size is written into the copy ---
  "racePack.teaser.name": "Race Packs",
  "racePack.teaser.badge": "{sizes} RACES",
  "racePack.teaser.from": "from {price}",
  "racePack.teaser.blurb":
    "Prepay your races at a discount — race today, the rest bank on your account and never expire.",
  "racePack.teaser.saveUpTo": "Save up to {amount}",
  "racePack.teaser.choose": "Choose your pack",
  "racePack.teaser.fineprint":
    "Credits load right after payment and never expire. One pack per racer · non-transferable · savings vs the {price} single race.",

  // --- PICKER (tiles + who's-this-for panel + assignment rows) ---
  "racePack.picker.racesWord": "RACES",
  "racePack.picker.save": "Save {amount}",
  // Limited-time SKU ribbon + tier marker. The registry's `badge` string is an
  // ENGLISH marker for the code to branch on — it is never printed, so a
  // Spanish kiosk always reads these.
  //
  // The ribbon names WHEN the current limited-time offer runs, so it changes
  // with the offer: it read "Flash Sale" for the two-day 8/12–8/13 BOGO and
  // reads "Wednesdays" now that BOGO is weekly (owner 2026-08-19). The key name
  // is historical — only one limited-time SKU family carries a `badge` at a
  // time, and whoever introduces the next one re-words this pair.
  "racePack.picker.flashSale": "Wednesdays",
  "racePack.picker.juniorTier": "Junior",
  "racePack.picker.dayNoteWeekday": "Cheapest — good on Mon–Thu visits",
  "racePack.picker.dayNoteAny": "Use them any day of the week",
  "racePack.picker.whoFor": "Who’s this pack for?",
  "racePack.picker.whoForHint": "— select everyone who gets one",
  "racePack.picker.everyone": "Everyone",
  "racePack.picker.cancel": "Cancel",
  "racePack.picker.addPacks": "{count, plural, one {Add # pack} other {Add # packs}} · {amount}",
  "racePack.picker.removePack": "Remove pack",
  "racePack.picker.selectRacers": "Select racers",
  "racePack.picker.assignment": "{count, plural, one {# race} other {# races}} · {day} · {price}",
  "racePack.picker.removeAria": "Remove {name}’s race pack",
  "racePack.picker.returningOnly":
    "Race packs load onto a racer's account — {names} can join after signing in as a returning racer.",
  "racePack.picker.firstCredit":
    "First credit covers today’s race at checkout — the rest bank to their account.",

  // --- CART block (the race card's editable "Race packs" section) ---
  "racePack.cart.eyebrow": "Race packs",
  "racePack.cart.done": "Done",
  "racePack.cart.addEdit": "Add / edit",
  "racePack.cart.add": "+ Add race pack",
  "racePack.cart.missingLead":
    "{names} {count, plural, one {doesn’t} other {don’t}} have a pack yet — tap",
  "racePack.cart.missingTail": "to add one.",
  "racePack.cart.blurb":
    "Prepay your races at a discount — today’s race is covered, the rest bank to their account and never expire.",

  // --- PAY-MODE step (page 1: what you're buying, before which heat) ---
  // {sizes} = the pack sizes on sale today ("3, 5, 10"); {list} = the bundle's
  // own inclusions, built from its registry flags.
  "payMode.title.first": "Everyone starts on a Starter race",
  "payMode.title.today": "How much racing today?",
  "payMode.sub.first": "Even if you’ve raced elsewhere — one Starter run unlocks the faster karts.",
  "payMode.sub.today": "Prepay and save, or just pay for today. You’ll pick the race next.",
  "payMode.recommended": "★ FastTrax recommended",
  // Replaces the recommended pill while a limited-time bundle holds the hero card.
  // Names the promo's DAYS, not a countdown — BOGO is weekly now (owner
  // 2026-08-19), so the old "AUG 12–13 ONLY" would go stale every week.
  "payMode.flashSale": "★ BOGO — EVERY WEDNESDAY",
  "payMode.selected": "✓ Selected",
  "payMode.bogo.title": "2 Races for the Price of 1",
  // Says BOTH days on purpose: the promo runs on Wednesday races, but the free
  // credit lands on the Mon–Thu deposit kind and really is good on any of those
  // days (packs.ts explains why it is not narrowed to Wednesdays). Naming only
  // "Wednesday" here would understate the credit; naming only "Mon–Thu" would
  // read as though the deal itself ran all week.
  "payMode.bogo.sub":
    "Buy one race on a Wednesday, get one free — the second banks to your account for any Mon–Thu visit.",
  "payMode.raceWord": "{count, plural, one {race} other {races}}",
  "payMode.incl.prefix": "incl. {list}",
  "payMode.incl.license": "license",
  "payMode.license.plus": "+ {price} license for {names}",
  "payMode.incl.video": "video",
  // Dormant since 2026-08-12 — no package carries an appetizerCode, so this
  // chip never renders. Kept so re-enabling the offer is a registry edit only.
  "payMode.incl.appetizer": "appetizer",
  "payMode.say.qualifier":
    "Starter now, then your Intermediate spot saved for later — faster karts, same visit.",
  "payMode.say.rookie": "One Starter race with the in-kart video of it.",
  "payMode.single.anyRace": "Single race",
  "payMode.single.orUse": "Pay per race — or use credits, comps, or a pack",
  // Web variant while the pack rail is off there: no pack to mention.
  "payMode.single.orUse.web": "Pay per race — or use your banked race credits",
  "payMode.single.fromRacer": "from {price} / racer",
  // A two-race bundle whose races can no longer fit today (same gate as the
  // product step's package card).
  "payMode.blocked":
    "Not enough time left today to fit both races — book the {name} earlier in the day, or choose a single race.",
  // WEB-only enrichment under a bundle (kiosk keeps the leaner layout).
  "payMode.included.toggle": "What's included",
  "payMode.pack.title": "Race packs",
  "payMode.pack.sub": "{sizes} prepaid races — bank them for later visits, never expire",
  "payMode.pack.chosen": "{count, plural, one {# pack added} other {# packs added}}",
  "payMode.credits":
    "{names} {count, plural, one {already has banked race credits} other {already have banked race credits}} — we’ll use them at checkout.",
  "payMode.perRacer": "Prices are per racer · {names}",
} as const;

export const racepackEs: Record<keyof typeof racepackEn, string> = {
  "racePack.eyebrow": "Race packs",

  // --- DONE screen ---
  "racePack.done.title": "¡Ya estás cargado!",
  "racePack.done.racesBold": "{count, plural, one {# carrera} other {# carreras}}",
  "racePack.done.onAccount": "en su cuenta — nunca caducan",
  "racePack.done.creditsLoading": "Los créditos se están cargando — listos en unos minutos",
  "racePack.done.licenseAddedBold": "Licencia FastTrax agregada",
  "racePack.done.licenseAddedRest":
    "para {names} — válida por un año, incluye cascos y equipo de seguridad. Listos para correr.",
  "racePack.done.licenseSettingUp":
    "Tu licencia se está configurando — por favor, regístrate en la recepción para que podamos terminarla (no necesitas pagar de nuevo).",
  "racePack.done.checkInAnyVisit":
    "Regístrate con su número de teléfono en cualquier visita — los créditos pagan las carreras al momento de pagar.",
  "racePack.done.raceToday": "Corre hoy — usa uno ahora",
  "racePack.done.done": "Listo",

  // --- ERROR (post-payment) ---
  "racePack.error.title": "Ya casi",
  "racePack.error.body":
    "Recibimos tu pago pero no pudimos terminar — por favor, acude a la recepción (no pagues de nuevo).",
  "racePack.error.backToStart": "Volver al inicio",

  // --- PAY / finalizing ---
  "racePack.finalizing.title": "Cargando los créditos…",
  "racePack.finalizing.body": "Pago recibido — poniendo las carreras en la cuenta.",
  "racePack.err.startReaderPayment": "No pudimos iniciar el pago en el lector.",

  // --- BUILD: who + packs ---
  "racePack.build.title": "Prepaga carreras — guárdalas en una cuenta.",
  "racePack.build.subtitle":
    "Inicia sesión o configura a cada corredor, luego elige su pack. Los créditos nunca caducan y pagan las carreras al momento de pagar — hoy o en cualquier visita.",
  "racePack.build.pickPacks": "Elige sus packs",
  "racePack.build.finishSetup": "primero completa su configuración arriba",
  "racePack.build.racesWord": "carreras",
  "racePack.build.monThu": "lun–jue",
  "racePack.build.anyDay": "Cualquier día",
  "racePack.build.perRace": "{price}/carrera",
  "racePack.build.licenseRequired": "Se requiere Licencia FastTrax",
  "racePack.build.licenseLead":
    "{count, plural, one {El corredor primerizo necesita una Licencia de Carreras FastTrax para salir a la pista —} other {Los corredores primerizos necesitan una Licencia de Carreras FastTrax para salir a la pista —}}",
  "racePack.build.licensePriceEach": "{price} cada una",
  "racePack.build.licenseTail":
    "{count, plural, one {, válida por un año completo e incluye el uso de nuestros cascos y equipo de seguridad. La agregamos ahora para que esté listo para correr.} other {, válida por un año completo e incluye el uso de nuestros cascos y equipo de seguridad. La agregamos ahora para que todos estén listos para correr.}}",
  "racePack.build.licenseFor": "Licencia para: {names}",
  "racePack.build.fineprint":
    "Un pack por corredor · no transferible · los créditos nunca caducan.",
  "racePack.build.readerUnavailable":
    "El lector de tarjetas no está disponible en este kiosco — por favor, acude a la recepción para comprar un race pack.",
  "racePack.build.payButton": "Paga {amount} + impuestos en el lector",
  "racePack.build.pickToContinue": "Elige un pack para continuar",
  "racePack.build.back": "Atrás",

  // --- TEASER (paso de producto de carreras) ---
  "racePack.teaser.name": "Race Packs",
  "racePack.teaser.badge": "{sizes} CARRERAS",
  "racePack.teaser.from": "desde {price}",
  "racePack.teaser.blurb":
    "Prepaga tus carreras con descuento — corre hoy y las demás quedan en tu cuenta y nunca caducan.",
  "racePack.teaser.saveUpTo": "Ahorra hasta {amount}",
  "racePack.teaser.choose": "Elige tu pack",
  "racePack.teaser.fineprint":
    "Los créditos se cargan justo después del pago y nunca caducan. Un pack por corredor · no transferible · ahorro comparado con la carrera individual de {price}.",

  // --- PICKER (tarjetas + panel de para quién + filas asignadas) ---
  "racePack.picker.racesWord": "CARRERAS",
  "racePack.picker.save": "Ahorra {amount}",
  // "Junior" se mantiene en inglés: es el nombre de la categoría de carrera que
  // ya usan el personal y la señalización del centro.
  "racePack.picker.flashSale": "Miércoles",
  "racePack.picker.juniorTier": "Junior",
  "racePack.picker.dayNoteWeekday": "Más barato — válido en visitas de lun–jue",
  "racePack.picker.dayNoteAny": "Úsalas cualquier día de la semana",
  "racePack.picker.whoFor": "¿Para quién es este pack?",
  "racePack.picker.whoForHint": "— selecciona a todos los que reciben uno",
  "racePack.picker.everyone": "Todos",
  "racePack.picker.cancel": "Cancelar",
  "racePack.picker.addPacks":
    "{count, plural, one {Agregar # pack} other {Agregar # packs}} · {amount}",
  "racePack.picker.removePack": "Quitar pack",
  "racePack.picker.selectRacers": "Selecciona corredores",
  "racePack.picker.assignment":
    "{count, plural, one {# carrera} other {# carreras}} · {day} · {price}",
  "racePack.picker.removeAria": "Quitar el race pack de {name}",
  "racePack.picker.returningOnly":
    "Los race packs se cargan a la cuenta del corredor — {names} puede unirse después de iniciar sesión como corredor que regresa.",
  "racePack.picker.firstCredit":
    "El primer crédito paga la carrera de hoy al momento de pagar — los demás quedan en su cuenta.",

  // --- CART block (sección "Race packs" de la tarjeta de carreras) ---
  "racePack.cart.eyebrow": "Race packs",
  "racePack.cart.done": "Listo",
  "racePack.cart.addEdit": "Agregar / editar",
  "racePack.cart.add": "+ Agregar race pack",
  "racePack.cart.missingLead":
    "{names} aún no {count, plural, one {tiene} other {tienen}} pack — toca",
  "racePack.cart.missingTail": "para agregar uno.",
  "racePack.cart.blurb":
    "Prepaga tus carreras con descuento — la carrera de hoy queda cubierta y las demás quedan en su cuenta y nunca caducan.",

  // --- Paso de forma de pago (página 1: qué compras, antes de qué carrera) ---
  "payMode.title.first": "Todos empiezan con una carrera Starter",
  "payMode.title.today": "¿Cuántas carreras hoy?",
  "payMode.sub.first":
    "Aunque hayas corrido en otro lugar — una carrera Starter aquí desbloquea los karts más rápidos.",
  "payMode.sub.today": "Prepaga y ahorra, o paga solo lo de hoy. La carrera se elige después.",
  "payMode.recommended": "★ Recomendado por FastTrax",
  "payMode.flashSale": "★ BOGO — TODOS LOS MIÉRCOLES",
  "payMode.selected": "✓ Seleccionado",
  "payMode.bogo.title": "2 Carreras por el Precio de 1",
  "payMode.bogo.sub":
    "Compra una carrera un miércoles y llévate otra gratis — la segunda se guarda en tu cuenta para cualquier visita de lun–jue.",
  "payMode.raceWord": "{count, plural, one {carrera} other {carreras}}",
  "payMode.incl.prefix": "incluye {list}",
  "payMode.incl.license": "licencia",
  "payMode.license.plus": "+ {price} de licencia para {names}",
  "payMode.incl.video": "video",
  "payMode.incl.appetizer": "aperitivo",
  "payMode.say.qualifier":
    "Starter ahora y te guardamos tu lugar de Intermediate para más tarde — karts más rápidos, misma visita.",
  "payMode.say.rookie": "Una carrera Starter con el video desde el kart.",
  "payMode.single.anyRace": "Carrera individual",
  "payMode.single.orUse": "Paga por carrera — o usa créditos, cortesías o un pack",
  "payMode.single.orUse.web": "Paga por carrera — o usa tus créditos de carrera guardados",
  "payMode.single.fromRacer": "desde {price} / corredor",
  "payMode.blocked":
    "No queda tiempo hoy para las dos carreras — reserva el {name} más temprano, o elige una carrera individual.",
  "payMode.included.toggle": "Qué incluye",
  "payMode.pack.title": "Race packs",
  "payMode.pack.sub": "{sizes} carreras prepagadas — guárdalas para otras visitas, nunca caducan",
  "payMode.pack.chosen": "{count, plural, one {# pack agregado} other {# packs agregados}}",
  "payMode.credits":
    "{names} ya {count, plural, one {tiene créditos de carrera} other {tienen créditos de carrera}} — los usaremos al pagar.",
  "payMode.perRacer": "Precios por corredor · {names}",
};
