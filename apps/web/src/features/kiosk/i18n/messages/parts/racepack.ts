/** Standalone race-pack purchase flow (KioskRacePackFlow) i18n fragment. Add
 *  `"racePack.*"` keys; mirror every key in es. "Race pack"/"Pit Crew" glossary.
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
};
