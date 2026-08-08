/** NEW check-in strings from main's reworked KioskCheckinFlow (split itinerary +
 *  sign-in pages, race-assignment UX, express pills, done-screen race button).
 *  The ORIGINAL check-in keys still live in the core en.ts/es.ts under
 *  `checkin.*` — REUSE those where the string is unchanged; only add keys HERE
 *  that don't already exist in en.ts (disjoint key sets — no collision). */
export const checkinEn = {
  // Header title shown on the race-assignment stage.
  "checkin.assignTitle": "Who’s racing?",

  // Loader labels while racers are being scheduled onto the grid.
  "checkin.puttingOnGrid": "Putting racers on the grid…",
  "checkin.puttingOnGridWait": "Putting racers on the grid — one moment…",

  // Last-4 possession check before texting the reservation's own contact.
  "checkin.err.last4Mismatch":
    "That doesn’t match the number on this reservation. Try again, or see the front desk.",
  "checkin.verify.eyebrow": "Confirm it’s your booking",
  "checkin.verify.title": "Enter the last 4 digits of the phone on this reservation",
  "checkin.verify.blurb": "We’ll text a code to that number to check you in.",
  "checkin.verify.aria": "Last 4 digits of the phone number",

  // Browse rows + itinerary/party navigation.
  "checkin.browse.openAria": "Open {label}, {time}",
  "checkin.express.pill": "Express lane",
  // Gold ★ pill on VIP-combo rows — proper noun, identical in every locale.
  "checkin.vip.pill": "VIP",
  "checkin.continue": "Continue ›",
  "checkin.nextWhosRacing": "Next: who’s racing ›",

  // Express-lane info modal. The badge marks reservations that really ARE
  // express (every racer resolved with a waiver on file), so this copy is the
  // END of their kiosk visit — no check-in, no OTP. The body is composed from
  // three WHOLE sentences plus one standalone place name, so the bold emphasis
  // wraps a complete translatable unit and the plain-string engine never has to
  // render ICU tags (the reason the old single-paragraph body stayed English).
  "checkin.express.pillAria": "{label}, {time} — Express Lane, no check-in needed",
  "checkin.express.title": "Express Lane — you’re already set",
  "checkin.express.bodyNothing":
    "Everyone on this reservation has a waiver on file, so there’s nothing to check in here.",
  "checkin.express.bodyWhere": "Skip the front desk and Guest Services and go straight to",
  "checkin.express.bodyPlace": "Race Check-In — 1st floor, left of the Red Track",
  "checkin.express.bodyWhen": "Arrive about 5 minutes before your race.",
  "checkin.browse.expressHint":
    "Marked Express lane? You’re already set — tap it to see where to go.",
  "checkin.gotIt": "Got it",
  "checkin.close": "Close",

  // Race-assignment step + racer picker.
  "checkin.assign.prompt":
    "Tap each race to choose who’s driving it. Junior races only list junior racers — and the same racer can take more than one race when there’s enough time between them.",
  "checkin.change": "Change",
  "checkin.chooseRacer": "Choose racer",
  "checkin.remove": "Remove",
  "checkin.assign.remaining":
    "Assign a racer to every race to check in{count, plural, =0 {.} other { — # still open.}} Everyone racing needs to be here.",
  // "Load your party" — the gold bar on the sign-in step. Everyone the booking
  // already knows who is READY is now added automatically, so this offers only
  // the people who still need something; the copy has to say that, not imply
  // the whole party is missing. (Was hard-coded English until 2026-08-07.)
  "checkin.prefill.load":
    "Add {count, plural, one {# more guest} other {# more guests}} from your booking",
  "checkin.prefill.names": "{names} — from your original booking.",
  "checkin.prefill.lapsedHint": "Anyone whose waiver lapsed just re-signs.",
  "checkin.prefill.autoAdded":
    "We added {count, plural, one {# guest} other {# guests}} from your booking.",
  // Shown when BMI never answered, so the roster is booking-labels only and may
  // be missing people who ARE registered. Previously silent.
  "checkin.roster.degraded":
    "We couldn’t reach the reservation system, so this list may be incomplete. Add anyone who’s missing.",
  "checkin.roster.loading": "Looking for your group…",
  // Nobody is ticked — the gate now counts only the people actually checking in.
  "checkin.needSomeone": "Tap at least one person to check in.",

  // Race assignment is now inline chips on each race card (no per-race modal),
  // with the unambiguous races pre-filled. Say that we filled them — a silent
  // pre-fill is a guess the guest never gets the chance to correct.
  "checkin.assign.promptShort": "Tap a name to say who’s driving each race.",
  "checkin.assign.autoFilled": "We matched racers to races. Tap any name to change it.",
  "checkin.assign.nobodyYet": "Nobody chosen yet",
  "checkin.assign.chosenOf": "{chosen} of {total} chosen",
  "checkin.done.racingBuilding": "FastTrax Racing",
  "checkin.assign.alsoAt": "also at {time}",
  "checkin.assign.movesFromTime": "moves from {time}",
  "checkin.assign.addRacer": "Add a {category} racer",
  // Partial check-in: some seats left open is a NORMAL outcome (half the party
  // arrives later), not an error to fix before continuing.
  "checkin.assign.needOne": "Choose at least one racer to check in.",
  "checkin.assign.someOpen":
    "{count, plural, one {# race is} other {# races are}} still open — check in now, and anyone else can check in when they get here.",
  // Late half of a party checking in separately — say it added only THEM.
  "checkin.done.racersAddedLater":
    "{count, plural, one {# more racer is} other {# more racers are}} on the grid — the rest of your group was already checked in.",

  "checkin.picker.title": "Who’s racing the {label}?",
  "checkin.picker.noneReady":
    "No {category} racer is ready yet. Go back and add a {category} racer with a signed waiver first.",
  "checkin.picker.elsewhere": "in another race",
  "checkin.picker.movesFrom": "moves from their {label} race",
  "checkin.picker.otherRace": "other",
  "checkin.picker.alsoAnother": "also in another race",
} as const;

export const checkinEs: Record<keyof typeof checkinEn, string> = {
  "checkin.assignTitle": "¿Quién compite?",

  "checkin.puttingOnGrid": "Colocando a los pilotos en la parrilla…",
  "checkin.puttingOnGridWait": "Colocando a los pilotos en la parrilla — un momento…",

  "checkin.err.last4Mismatch":
    "Eso no coincide con el número de esta reserva. Inténtalo de nuevo o acude a recepción.",
  "checkin.verify.eyebrow": "Confirma que es tu reserva",
  "checkin.verify.title": "Ingresa los últimos 4 dígitos del teléfono de esta reserva",
  "checkin.verify.blurb": "Enviaremos un código por mensaje a ese número para registrarte.",
  "checkin.verify.aria": "Últimos 4 dígitos del número de teléfono",

  "checkin.browse.openAria": "Abrir {label}, {time}",
  "checkin.express.pill": "Carril exprés",
  "checkin.vip.pill": "VIP",
  "checkin.continue": "Continuar ›",
  "checkin.nextWhosRacing": "Siguiente: ¿quién compite? ›",

  "checkin.express.pillAria": "{label}, {time} — Carril Exprés, no necesitas registrarte",
  "checkin.express.title": "Carril Exprés — ya está todo listo",
  "checkin.express.bodyNothing":
    "Todos en esta reserva ya tienen su exención firmada, así que no hay nada que registrar aquí.",
  "checkin.express.bodyWhere": "Omite la recepción y Guest Services y ve directamente a",
  "checkin.express.bodyPlace":
    "Race Check-In — 1er piso, a la izquierda de la pista roja (Red Track)",
  "checkin.express.bodyWhen": "Llega unos 5 minutos antes de tu carrera.",
  "checkin.browse.expressHint":
    "¿Marcada como Carril exprés? Ya está todo listo — tócala para ver a dónde ir.",
  "checkin.gotIt": "Entendido",
  "checkin.close": "Cerrar",

  "checkin.assign.prompt":
    "Toca cada carrera para elegir quién la conduce. Las carreras junior solo muestran pilotos junior — y el mismo piloto puede tomar más de una carrera cuando hay suficiente tiempo entre ellas.",
  "checkin.change": "Cambiar",
  "checkin.chooseRacer": "Elegir piloto",
  "checkin.remove": "Quitar",
  "checkin.assign.remaining":
    "Asigna un piloto a cada carrera para registrarte{count, plural, =0 {.} other { — quedan # sin asignar.}} Todos los que compiten deben estar aquí.",
  "checkin.prefill.load":
    "Agregar {count, plural, one {# invitado más} other {# invitados más}} de tu reserva",
  "checkin.prefill.names": "{names} — de tu reserva original.",
  "checkin.prefill.lapsedHint": "Quien tenga la exención vencida solo vuelve a firmar.",
  "checkin.prefill.autoAdded":
    "Agregamos {count, plural, one {# invitado} other {# invitados}} de tu reserva.",
  "checkin.roster.degraded":
    "No pudimos conectar con el sistema de reservas, así que esta lista puede estar incompleta. Agrega a quien falte.",
  "checkin.roster.loading": "Buscando a tu grupo…",
  "checkin.needSomeone": "Toca al menos a una persona para registrarte.",

  "checkin.assign.promptShort": "Toca un nombre para indicar quién conduce cada carrera.",
  "checkin.assign.autoFilled":
    "Asignamos los pilotos a las carreras. Toca cualquier nombre para cambiarlo.",
  "checkin.assign.nobodyYet": "Aún no hay nadie elegido",
  "checkin.assign.chosenOf": "{chosen} de {total} elegidos",
  "checkin.done.racingBuilding": "FastTrax Racing",
  "checkin.assign.alsoAt": "también a las {time}",
  "checkin.assign.movesFromTime": "cambia de las {time}",
  "checkin.assign.addRacer": "Agregar un piloto {category}",
  "checkin.assign.needOne": "Elige al menos un piloto para registrarte.",
  "checkin.assign.someOpen":
    "{count, plural, one {Queda # carrera} other {Quedan # carreras}} sin asignar — regístrate ahora y los demás pueden registrarse cuando lleguen.",
  "checkin.done.racersAddedLater":
    "{count, plural, one {# piloto más está} other {# pilotos más están}} en la parrilla — el resto de tu grupo ya se había registrado.",

  "checkin.picker.title": "¿Quién compite en {label}?",
  "checkin.picker.noneReady":
    "Aún no hay ningún piloto {category} listo. Regresa y agrega un piloto {category} con una exención firmada primero.",
  "checkin.picker.elsewhere": "en otra carrera",
  "checkin.picker.movesFrom": "cambia de su carrera de {label}",
  "checkin.picker.otherRace": "otra",
  "checkin.picker.alsoAnother": "también en otra carrera",
};
