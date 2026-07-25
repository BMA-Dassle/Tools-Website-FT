/**
 * Spanish (es-US) message catalog.
 *
 * ⚠ FIRST-PASS AI TRANSLATION — Phase 3 native-Spanish human review is PENDING.
 * Every value below is a machine/first-pass rendering and must be verified by a
 * native-Spanish reviewer before this locale ships (see
 * tasks/kiosk-i18n-spanish-plan.md § Phase 3). Where wording is legal- or
 * safety-critical and a confident translation isn't possible, the value is left
 * in English with a `// TODO(i18n)` note rather than guessed.
 *
 * Typed to `MessageKey`, so it must cover exactly the English keys — a missing
 * or stray key is a compile error. Runtime still falls back to English per key
 * (getMessages) as a belt-and-suspenders guard.
 *
 * Proper nouns in the locked glossary (FastTrax, HeadPinz, Game Zone, Podium,
 * Pit Crew, Duckpin) stay untranslated in every locale.
 */
import type { MessageKey } from "./en";

export const es: Record<MessageKey, string> = {
  "attract.letsPlay": "¡A jugar!",
  "attract.subtitle.racing":
    "Reserva carreras, boliche y atracciones aquí mismo — toma como un minuto.",
  "attract.subtitle.bowling":
    "Reserva boliche, blasters y láser tag aquí mismo — toma como un minuto.",
  "attract.touchToStart": "Toca para comenzar",

  // --- Category chooser (KioskCategories) ---
  "categories.heading.addAnything": "¿Agregar algo más?",
  "categories.heading.whatToday": "¿Qué vamos a hacer hoy?",
  "categories.exp.title": "Experiencias",
  "categories.exp.eyebrowFallback": "Experiencias combinadas",
  "categories.exp.blurb": "Varias atracciones combinadas en un solo precio fácil",
  "categories.attr.title": "Atracciones",
  "categories.attr.eyebrow": "{count, plural, one {# atracción} other {# atracciones}}",
  "categories.attr.blurb.naples": "Boliche, gel blasters, láser tag y más — elige una hora y listo",
  "categories.attr.blurb.default": "Carreras, boliche, blasters y más — elige una hora y listo",
  "categories.gameZone.eyebrow.reload": "Recargar · consultar saldo",
  "categories.gameZone.eyebrow.full": "Recargar · comprar · 1 a 10 tarjetas",
  "categories.gameZone.blurb.reload":
    "Recarga tu tarjeta de arcade o consulta su saldo — sin esperas",
  "categories.gameZone.blurb.full": "Compra o recarga fichas de arcade — sin esperas",
  "categories.disabled.experience":
    "No disponible en este momento — vuelve más tarde o pregunta a un encargado.",
  "categories.disabled.attraction":
    "No queda nada para reservar hoy — la recepción puede ayudarte con visitas sin cita.",
  "categories.backToCategories": "Todas las categorías",
  "categories.pick.experience": "Elige tu experiencia",
  "categories.pick.attraction": "Elige una atracción",
  "categories.eyebrow.mostPopular": "Más popular",
  "categories.eyebrow.premiumRacing": "Carreras premium",
  "categories.combo.priceLine": "{weekday}/persona lun–jue · {weekend}/persona vie–dom",
  "categories.qualifier.blurb":
    "Califica en un Starter, luego sube de nivel — video POV, aperitivo gratis y licencia incluidos.",
  "categories.qualifier.fromWeekday": "Desde {price}/persona lun–jue",
  "categories.qualifier.fromWeekend": "Desde {price}/persona vie–dom",
  "categories.qualifier.disabled":
    "No queda suficiente tiempo hoy para las dos carreras — vuelve más tarde o pregunta a un encargado.",
  "categories.emptyShelf": "Hoy no hay experiencias combinadas disponibles en esta ubicación.",
  "categories.gameZone.unavailable.title":
    "Las tarjetas de Game Zone no están disponibles en este kiosco",
  "categories.gameZone.unavailable.note": "Usa otro kiosco o visita Servicio al Cliente",
  "categories.tile.unavailable": "No disponible",
  "categories.tile.atVenue": "En {venue}",
  "categories.exp.nextAvailable": "Próxima disponibilidad · {time}",
  "categories.exp.nextAvailableSlots":
    "Próxima disponibilidad · {time} · {count, plural, one {# lugar} other {# lugares}}",
  "categories.tile.nextLane": "Próxima pista · {time}",
  "categories.tile.countTables": "{count, plural, one {# mesa} other {# mesas}} · {time}",
  "categories.tile.countPlayers": "{count, plural, one {# jugador} other {# jugadores}} · {time}",

  // --- Confirmation (KioskConfirmation) ---
  "confirmation.booked": "¡Reservación confirmada!",
  "confirmation.receiptNote":
    "Acabamos de enviarte por mensaje y correo tu confirmación y los enlaces de registro — ese es tu boleto, no hay nada que imprimir.",
  "confirmation.racing.eyebrow": "Carreras — lo que sigue",
  "confirmation.racing.howButton": "¿Cómo funciona el registro de carreras?",
  "confirmation.lane.readyTitle": "{lane} está lista",
  "confirmation.lane.readyTitleGeneric": "Tu pista está lista",
  "confirmation.lane.readyPrompt":
    "¿Quieres que abramos tu pista ahora para que empieces a jugar boliche?",
  "confirmation.lane.opening": "Abriendo…",
  "confirmation.lane.openButton": "Abrir mi pista",
  "confirmation.lane.later": "Me registro más tarde",
  "confirmation.lane.openTitle": "{lane} está abierta",
  "confirmation.lane.openTitleGeneric": "Tu pista está abierta",
  "confirmation.lane.openBody.fasttrax": "Ve para allá — tu pista está lista.",
  "confirmation.lane.openBody.headpinz":
    "Ve para allá — tus zapatos te los llevarán directo a la pista.",
  "confirmation.lane.failedTitle": "No pudimos abrir tu pista",
  "confirmation.lane.failedBody":
    "Por favor acude a la recepción y te pondrán a jugar boliche de inmediato.",
  "confirmation.racePacks.eyebrow": "Paquetes de carreras",
  "confirmation.qr.alt": "Código de registro",
  "confirmation.bookingCode": "Código de reservación",
  "confirmation.done": "Listo — empezar de nuevo",
  "confirmation.dispensing": "Dispensando tus tarjetas…",
  "confirmation.dispensingHint": "Toma cada tarjeta cuando salga — terminamos automáticamente.",
  "confirmation.returningIn":
    "Volviendo al inicio en {seconds}s — toca en cualquier lugar para quedarte",
  "confirmation.raceCheckin.eyebrow": "Registro de carreras",
  "confirmation.raceCheckin.title": "Qué esperar",
  "confirmation.raceCheckin.gotIt": "Entendido",

  // --- Bowling tier step (KioskBowlingTierStep) ---
  "bowlingTier.loading": "Cargando pistas…",
  "bowlingTier.intro":
    "Pistas estándar o la suite VIP con servicio de salón — elige tu horario a continuación.",
  "bowlingTier.upgrade": "Mejora",
  "bowlingTier.perLaneHour": "/pista por hora",
  "bowlingTier.classic.title": "Pistas clásicas",
  "bowlingTier.classic.sub": "La favorita de la casa — hasta 8 por pista",
  "bowlingTier.vip.title": "Suites VIP",
  "bowlingTier.vip.sub": "Asientos en suite privada, servicio de salón en tu pista",

  // --- Bowling time step (KioskBowlingTimeStep) ---
  "bowlingTime.busy.racing": "Estás en carrera",
  "bowlingTime.busy.booked": "Ya tienes una reserva",
  "bowlingTime.busy.bowling": "Estás jugando boliche",
  "bowlingTime.heroEyebrow": "Próximas pistas disponibles · hoy en {center}",
  "bowlingTime.heroSelected": "Listo — continúa para elegir tu paquete de pista",
  "bowlingTime.heroUnselected": "Toca para jugar boliche en cuanto estés listo",
  "bowlingTime.noneToday":
    "No quedan horarios de pista hoy — la recepción puede ayudarte con disponibilidad sin cita.",
  "bowlingTime.orPickAnother": "O elige otro horario para hoy",
  "bowlingTime.conflictNote":
    "Los horarios tachados se cruzan con algo que ya reservaste en esta visita.",
  "bowlingTime.availabilityNote":
    "La disponibilidad exacta de pistas se confirma en el siguiente paso — si un horario se acaba de llenar, te ofreceremos el más cercano disponible.",

  // --- Attraction slot step (KioskSlotStep) ---
  "slot.finding": "Buscando tu próxima hora disponible…",
  "slot.nextAvailable": "Próxima disponibilidad · hoy",
  "slot.holding": "Apartando tu lugar…",
  "slot.held": "Apartado para ti — continúa para seguir",
  "slot.spotsOpen":
    "{count, plural, one {# lugar disponible} other {# lugares disponibles}} — toca para tomarlo",
  "slot.hold.filled": "Ese horario se acaba de llenar — elige otro abajo.",
  "slot.error": "No pudimos revisar los horarios de hoy — elige de la lista de abajo.",
  "slot.noneSoon":
    "No hay nada disponible para tu grupo en las próximas horas — los horarios restantes de hoy están abajo, o pregunta en la recepción por disponibilidad sin cita.",
  "slot.orPickAnother": "O elige otro horario para hoy",

  // --- Bowler roster / details (KioskBowlingDetailsStep) ---
  "bowlingDetails.intro.shoes":
    "Nombres, zapatos y bumpers — para que tu pista esté lista en cuanto tú lo estés.",
  "bowlingDetails.intro.noShoes":
    "Nombres y bumpers — para que tu pista esté lista en cuanto tú lo estés.",
  "bowlingDetails.readyCount": "{ready} de {total} listos",
  "bowlingDetails.bowlerN": "Jugador {num}",
  "bowlingDetails.ready": "Listo",
  "bowlingDetails.name": "Nombre",
  "bowlingDetails.shoeSize": "Talla de zapato",
  "bowlingDetails.shoeRentalNote": "alquiler {price}/par · zapatos propios gratis",
  "bowlingDetails.ownShoes": "Zapatos propios",
  "bowlingDetails.cat.toddler": "Infantil",
  "bowlingDetails.cat.mens": "Hombre",
  "bowlingDetails.cat.womens": "Mujer",
  "bowlingDetails.bumpers": "Bumpers",
  "bowlingDetails.yes": "Sí",
  "bowlingDetails.no": "No",
  "bowlingDetails.rentalSummary":
    "{count, plural, one {# alquiler de zapatos} other {# alquileres de zapatos}} · {price}/par",
};
