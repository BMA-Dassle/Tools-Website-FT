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
};
