/**
 * Spanish (es-US) message catalog.
 *
 * Typed to `MessageKey`, so it must cover exactly the English keys — a missing
 * or stray key is a compile error. Runtime still falls back to English per key
 * (getMessages) as a belt-and-suspenders guard.
 *
 * Phase 0 = hand-written spike strings. Phase 3 replaces/extends this with the
 * AI first-pass + native-Spanish review. Proper nouns in the locked glossary
 * (FastTrax, HeadPinz, Game Zone, Podium, Pit Crew, Duckpin) stay untranslated.
 */
import type { MessageKey } from "./en";

export const es: Record<MessageKey, string> = {
  "attract.letsPlay": "¡A jugar!",
  "attract.subtitle.racing":
    "Reserva carreras, boliche y atracciones aquí mismo — toma como un minuto.",
  "attract.subtitle.bowling":
    "Reserva boliche, blasters y láser tag aquí mismo — toma como un minuto.",
  "attract.touchToStart": "Toca para comenzar",
};
