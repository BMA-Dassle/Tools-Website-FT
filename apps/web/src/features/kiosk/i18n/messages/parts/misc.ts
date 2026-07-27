/** Smaller guest-facing pieces — sign-in boxes (KioskSignInBoxes), VIP overview
 *  (KioskVipOverview), booking-as card (KioskBookingAsCard), license match picker
 *  (LicenseMatchPicker), waiver photo (KioskWaiverPhoto), the group-waiver
 *  flow chrome (KioskWaiverFlow — legal body stays English), and the
 *  solo-bowler confirm sheet (KioskFlow). Add keys under the relevant
 *  namespaces (`signin.*`, `vip.*`, `bookingAs.*`, `license.*`,
 *  `waiverPhoto.*`, `waiverFlow.*`, `soloBowler.*`); mirror every key in es.
 *
 *  es values are a first-pass AI translation pending native-Spanish review.
 *  Locked glossary — NEVER translated: FastTrax, HeadPinz, Game Zone, Podium,
 *  Pit Crew, Duckpin. */
export const miscEn = {
  // --- Sign-in boxes (KioskSignInBoxes) ---
  "signin.sheet.qrAlt": "QR code — scan to sign in on your phone",
  "signin.sheet.title": "Scan with your phone camera",
  "signin.sheet.sub": "Adults 18+ · waiver signed on the phone · kids are added here at the kiosk",
  "signin.sheet.signing":
    "{count, plural, one {1 phone signing in right now} other {# phones signing in right now}} — they’ll pop into the list above when they finish.",
  "signin.sheet.done": "Done",
  "signin.moreWays": "More ways to add people",
  "signin.method.phone": "phone",
  "signin.method.driversLicense": "driver’s license",
  "signin.method.fasttraxLicense": "FastTrax license",
  "signin.signingShort": "{count, plural, one {1 phone signing in} other {# phones signing in}}",
  "signin.phone.title": "Sign in from your phone",
  "signin.phone.dropped": "Phone sign-in dropped — tap for a new code.",
  "signin.phone.fastest": "Fastest",
  "signin.phone.sub": "Adults 18+ — scan & sign in on your own phone.",
  "signin.license.badge": "No typing",
  "signin.license.title": "Scan your license",
  "signin.license.sub": "Driver’s license or state ID — we’ll fill it in.",
  "signin.fasttrax.badge": "Members",
  "signin.fasttrax.title": "Scan your FastTrax license",
  "signin.fasttrax.sub": "Racers — scan your FastTrax license.",

  // --- VIP / Experiences overview (KioskVipOverview) ---
  // Leg titles carry data values (`{tier}`, `{min}`); venue names (FastTrax /
  // HeadPinz) and combo copy (name, descriptions, included items, start times)
  // come from data and stay as returned.
  "vip.eyebrow": "Experience",
  "vip.priceLine": "{weekday}/person Mon–Thu · {weekend}/person Fri–Sun",
  "vip.startTimes": "Estimated start times: {times}",
  "vip.stepByStep":
    "Your afternoon, step by step — the logo shows where each part happens. Racer accounts & waivers are set up right here.",
  "vip.atVenue": "at {venue}",
  "vip.allIncluded": "All included in the price",
  "vip.minGuests": "This experience is for {count}+ guests.",
  "vip.back": "Back",
  "vip.perPersonSetUp": "/person · Let’s set it up",
  "vip.notAvailable": "Not available right now",
  "vip.leg.race.title": "{tier} Race",
  "vip.leg.race.sub": "Suit up, helmet on, hit the track",
  "vip.leg.bowling.title": "{min}-Min Bowling",
  "vip.leg.bowling.titleVip": "{min}-Min VIP Bowling",
  "vip.leg.bowling.sub": "Lanes reserved for your group",
  "vip.leg.bowling.subVip": "Your own semi-private suite",
  "vip.leg.attraction.sub": "Included in your experience",
  "vip.attraction.gelBlaster": "Gel Blaster",
  "vip.attraction.laserTag": "Laser Tag",
  "vip.attraction.duckpin": "Duckpin Bowling",
  "vip.attraction.shuffleboard": "Shuffleboard",
  "vip.attraction.generic": "Attraction",

  // --- "Booking as" checkout card (KioskBookingAsCard) ---
  "bookingAs.label": "Booking as",
  "bookingAs.textOn": "Text confirmation on",
  "bookingAs.change": "Change",
  "bookingAs.firstName": "First name",
  "bookingAs.lastName": "Last name",
  "bookingAs.email": "Email",
  "bookingAs.mobilePhone": "Mobile phone",
  "bookingAs.smsOptIn": "Text me my confirmation & check-in reminder",
  "bookingAs.done": "Done",

  // --- License-scan match picker (LicenseMatchPicker) ---
  // The scanned first name renders between `welcome` and `whichAccount` (in its
  // own styled span), so the greeting is split around it.
  "license.eyebrow": "License scanned",
  "license.welcome": "Welcome back",
  "license.whichAccount": "— which account is yours?",
  "license.subtitle": "More than one account matches your name and birthday. Tap yours to sign in.",
  "license.noneNew": "None of these — set me up as new",
  "license.back": "Back",

  // --- Waiver-time guest photo (KioskWaiverPhoto) ---
  // `{name}` is the member's name (data). Camera error strings surface hardware
  // problems; `{msg}` is the browser's own error text and stays as returned.
  "waiverPhoto.title": "Quick photo for check-in",
  "waiverPhoto.sub.minor": "A photo for {name} is optional — it speeds up check-in.",
  "waiverPhoto.sub.adult": "{name}, look at the camera — this photo verifies you at check-in.",
  "waiverPhoto.previewAlt": "How you’ll appear at check-in",
  "waiverPhoto.use": "Use this photo",
  "waiverPhoto.retake": "Retake",
  "waiverPhoto.take": "Take photo",
  "waiverPhoto.switch": "Switch camera (higher / lower)",
  "waiverPhoto.skip.minor": "Skip the photo",
  "waiverPhoto.skip.adult": "Camera isn’t working — take my photo at check-in",
  "waiverPhoto.err.blocked":
    "Camera blocked — Windows privacy settings must allow desktop apps to use the camera.",
  "waiverPhoto.err.inUse": "The camera is in use by another app.",
  "waiverPhoto.err.unavailableMsg": "Camera unavailable: {msg}",
  "waiverPhoto.err.unavailable": "Camera unavailable.",
  "waiverPhoto.err.snapFail": "Couldn’t take the photo — try again.",

  // --- Group/online waiver flow CHROME (KioskWaiverFlow) ---
  // Legal waiver BODY text lives in the reused people/signature step and stays
  // English — only this flow's chrome (headings, buttons, status) is keyed.
  // Reservation labels, time labels, and signer display names come from the
  // server and stay as returned.
  "waiverFlow.loading": "Loading…",
  "waiverFlow.back": "Back",
  "waiverFlow.eyebrow": "Online & group waivers",
  "waiverFlow.findReservation": "Find your reservation",
  "waiverFlow.pickerPrompt":
    "Racing or celebrating with a group in the next two hours? Tap your reservation to sign waivers before you play.",
  "waiverFlow.refresh": "Refresh",
  "waiverFlow.checkingReservations": "Checking today’s reservations…",
  "waiverFlow.empty.errorTitle": "Couldn’t load reservations",
  "waiverFlow.empty.title": "Nothing in the next two hours",
  "waiverFlow.empty.errorBody": "Please try again in a moment, or see the front desk.",
  "waiverFlow.empty.body":
    "Reservations show here starting two hours before their time. The front desk can always help sooner.",
  "waiverFlow.kind.online": "Online booking",
  "waiverFlow.kind.group": "Group event",
  "waiverFlow.guests": "{count, plural, one {# guest} other {# guests}}",
  "waiverFlow.group": "Group",
  "waiverFlow.signedUpSoFar": "{count} signed up so far",
  "waiverFlow.signedReady": "Signed & ready on this reservation",
  "waiverFlow.checkingSigned": "Checking who’s signed…",
  "waiverFlow.noneSigned": "No one yet — be the first to get signed in below.",
  "waiverFlow.pending":
    "{count, plural, one {# in this group still needs a waiver.} other {# in this group still need a waiver.}}",
  "waiverFlow.addYourself": "Add yourself or your group",
  "waiverFlow.done": "Done — back to start",

  // --- Solo-bowler confirm sheet (KioskFlow) ---
  // Shown when Continue is tapped on "Who's bowling?" with only ONE bowler on
  // the roster — usually an incomplete party. `{name}` is the bowler's typed
  // first name (data). The eyebrow reuses `peopleUi.beforeYouContinue`.
  "soloBowler.title": "Just one bowler so far",
  "soloBowler.bodyNamed":
    "Only {name} is on the list — everyone bowling should be added here. Add the rest of your group, or continue if it’s really just one.",
  "soloBowler.body":
    "Only one person is on the list — everyone bowling should be added here. Add the rest of your group, or continue if it’s really just one.",
  "soloBowler.addMore": "Add more bowlers",
  "soloBowler.continueNamed": "Just {name} today — continue",
  "soloBowler.continue": "Just 1 bowler — continue",
} as const;

export const miscEs: Record<keyof typeof miscEn, string> = {
  // --- Sign-in boxes (KioskSignInBoxes) ---
  "signin.sheet.qrAlt": "Código QR — escanéalo para iniciar sesión en tu teléfono",
  "signin.sheet.title": "Escanea con la cámara de tu teléfono",
  "signin.sheet.sub":
    "Adultos 18+ · exención firmada en el teléfono · los niños se agregan aquí en el kiosco",
  "signin.sheet.signing":
    "{count, plural, one {1 teléfono iniciando sesión ahora} other {# teléfonos iniciando sesión ahora}} — aparecerán en la lista de arriba cuando terminen.",
  "signin.sheet.done": "Listo",
  "signin.moreWays": "Más formas de agregar personas",
  "signin.method.phone": "teléfono",
  "signin.method.driversLicense": "licencia de conducir",
  "signin.method.fasttraxLicense": "licencia FastTrax",
  "signin.signingShort":
    "{count, plural, one {1 teléfono iniciando sesión} other {# teléfonos iniciando sesión}}",
  "signin.phone.title": "Inicia sesión desde tu teléfono",
  "signin.phone.dropped": "Se cerró el inicio de sesión del teléfono — toca para un código nuevo.",
  "signin.phone.fastest": "Lo más rápido",
  "signin.phone.sub": "Adultos 18+ — escanea e inicia sesión en tu propio teléfono.",
  "signin.license.badge": "Sin escribir",
  "signin.license.title": "Escanea tu licencia",
  "signin.license.sub": "Licencia de conducir o identificación estatal — la completaremos por ti.",
  "signin.fasttrax.badge": "Miembros",
  "signin.fasttrax.title": "Escanea tu licencia FastTrax",
  "signin.fasttrax.sub": "Corredores — escaneen su licencia FastTrax.",

  // --- VIP / Experiences overview (KioskVipOverview) ---
  "vip.eyebrow": "Experiencia",
  "vip.priceLine": "{weekday}/persona lun–jue · {weekend}/persona vie–dom",
  "vip.startTimes": "Horas de inicio estimadas: {times}",
  "vip.stepByStep":
    "Tu tarde, paso a paso — el logotipo muestra dónde ocurre cada parte. Las cuentas de corredor y las exenciones se configuran aquí mismo.",
  "vip.atVenue": "en {venue}",
  "vip.allIncluded": "Todo incluido en el precio",
  "vip.minGuests": "Esta experiencia es para {count}+ invitados.",
  "vip.back": "Atrás",
  "vip.perPersonSetUp": "/persona · Vamos a configurarlo",
  "vip.notAvailable": "No disponible en este momento",
  "vip.leg.race.title": "Carrera {tier}",
  "vip.leg.race.sub": "Ponte el traje, casco puesto, a la pista",
  "vip.leg.bowling.title": "Boliche de {min} min",
  "vip.leg.bowling.titleVip": "Boliche VIP de {min} min",
  "vip.leg.bowling.sub": "Pistas reservadas para tu grupo",
  "vip.leg.bowling.subVip": "Tu propia suite semiprivada",
  "vip.leg.attraction.sub": "Incluido en tu experiencia",
  "vip.attraction.gelBlaster": "Gel Blaster",
  "vip.attraction.laserTag": "Laser Tag",
  "vip.attraction.duckpin": "Boliche Duckpin",
  "vip.attraction.shuffleboard": "Shuffleboard",
  "vip.attraction.generic": "Atracción",

  // --- "Booking as" checkout card (KioskBookingAsCard) ---
  "bookingAs.label": "Reservando como",
  "bookingAs.textOn": "Confirmación por mensaje activada",
  "bookingAs.change": "Cambiar",
  "bookingAs.firstName": "Nombre",
  "bookingAs.lastName": "Apellido",
  "bookingAs.email": "Correo electrónico",
  "bookingAs.mobilePhone": "Teléfono móvil",
  "bookingAs.smsOptIn": "Envíenme por mensaje mi confirmación y recordatorio de registro",
  "bookingAs.done": "Listo",

  // --- License-scan match picker (LicenseMatchPicker) ---
  "license.eyebrow": "Licencia escaneada",
  "license.welcome": "Bienvenido de nuevo",
  "license.whichAccount": "— ¿cuál cuenta es la tuya?",
  "license.subtitle":
    "Más de una cuenta coincide con tu nombre y fecha de nacimiento. Toca la tuya para iniciar sesión.",
  "license.noneNew": "Ninguna de estas — configúrame como nuevo",
  "license.back": "Atrás",

  // --- Waiver-time guest photo (KioskWaiverPhoto) ---
  "waiverPhoto.title": "Foto rápida para el registro",
  "waiverPhoto.sub.minor": "Una foto para {name} es opcional — agiliza el registro.",
  "waiverPhoto.sub.adult": "{name}, mira a la cámara — esta foto te verifica al registrarte.",
  "waiverPhoto.previewAlt": "Cómo aparecerás al registrarte",
  "waiverPhoto.use": "Usar esta foto",
  "waiverPhoto.retake": "Volver a tomar",
  "waiverPhoto.take": "Tomar foto",
  "waiverPhoto.switch": "Cambiar cámara (más alta / más baja)",
  "waiverPhoto.skip.minor": "Omitir la foto",
  "waiverPhoto.skip.adult": "La cámara no funciona — tomen mi foto al registrarme",
  "waiverPhoto.err.blocked":
    "Cámara bloqueada — la configuración de privacidad de Windows debe permitir que las aplicaciones de escritorio usen la cámara.",
  "waiverPhoto.err.inUse": "La cámara está en uso por otra aplicación.",
  "waiverPhoto.err.unavailableMsg": "Cámara no disponible: {msg}",
  "waiverPhoto.err.unavailable": "Cámara no disponible.",
  "waiverPhoto.err.snapFail": "No se pudo tomar la foto — inténtalo de nuevo.",

  // --- Group/online waiver flow CHROME (KioskWaiverFlow) ---
  "waiverFlow.loading": "Cargando…",
  "waiverFlow.back": "Atrás",
  "waiverFlow.eyebrow": "Exenciones en línea y de grupo",
  "waiverFlow.findReservation": "Encuentra tu reservación",
  "waiverFlow.pickerPrompt":
    "¿Corriendo o celebrando con un grupo en las próximas dos horas? Toca tu reservación para firmar las exenciones antes de jugar.",
  "waiverFlow.refresh": "Actualizar",
  "waiverFlow.checkingReservations": "Revisando las reservaciones de hoy…",
  "waiverFlow.empty.errorTitle": "No se pudieron cargar las reservaciones",
  "waiverFlow.empty.title": "Nada en las próximas dos horas",
  "waiverFlow.empty.errorBody": "Inténtalo de nuevo en un momento, o consulta en recepción.",
  "waiverFlow.empty.body":
    "Las reservaciones aparecen aquí a partir de dos horas antes de su hora. Recepción siempre puede ayudarte antes.",
  "waiverFlow.kind.online": "Reserva en línea",
  "waiverFlow.kind.group": "Evento de grupo",
  "waiverFlow.guests": "{count, plural, one {# invitado} other {# invitados}}",
  "waiverFlow.group": "Grupo",
  "waiverFlow.signedUpSoFar": "{count} registrados hasta ahora",
  "waiverFlow.signedReady": "Firmados y listos en esta reservación",
  "waiverFlow.checkingSigned": "Revisando quién ha firmado…",
  "waiverFlow.noneSigned": "Nadie todavía — sé el primero en registrarte abajo.",
  "waiverFlow.pending":
    "{count, plural, one {# en este grupo todavía necesita una exención.} other {# en este grupo todavía necesitan una exención.}}",
  "waiverFlow.addYourself": "Agrégate a ti o a tu grupo",
  "waiverFlow.done": "Listo — volver al inicio",

  // --- Solo-bowler confirm sheet (KioskFlow) ---
  "soloBowler.title": "Solo un jugador hasta ahora",
  "soloBowler.bodyNamed":
    "Solo {name} está en la lista — todos los que van a jugar boliche deben agregarse aquí. Agrega al resto de tu grupo, o continúa si de verdad es solo uno.",
  "soloBowler.body":
    "Solo hay una persona en la lista — todos los que van a jugar boliche deben agregarse aquí. Agrega al resto de tu grupo, o continúa si de verdad es solo uno.",
  "soloBowler.addMore": "Agregar más jugadores",
  "soloBowler.continueNamed": "Solo {name} hoy — continuar",
  "soloBowler.continue": "Solo 1 jugador — continuar",
};
