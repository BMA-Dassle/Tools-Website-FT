/**
 * Package food configuration — guest-facing copy, EN + ES.
 *
 * BowlingFoodStep is a SHARED web/kiosk step and was hardcoded English, which
 * quietly broke the kiosk rule for as long as Pizza Bowl was the only package.
 * Redesigning it for NFL wings was the moment to fix that too.
 *
 * Food translates; brands do not. Sauce and dipper NAMES come from Square in
 * English ("Boom Boom", "Nashville Hot") and stay that way — they are how the
 * kitchen ticket reads and how the menu board reads.
 */

export const foodEn = {
  "food.title": "Customise your package",
  "food.subtitle": "Everything below is included. Anything with a price is extra.",
  "food.atCenter": "Food selections will be taken at the center.",
  "food.lane": "Lane {n}",
  "food.laneOf": "Lane {n} of {total}",
  "food.required": "Required",
  "food.optional": "Optional",
  "food.pickOne": "Pick 1",
  "food.pickUpTo": "Pick up to {n}",
  "food.pickAny": "Pick any",
  "food.included": "{n} included",
  "food.extrasOnLane": "Extras on this lane",
  "food.extrasTotal": "Extras",
  "food.done": "Done",
  "food.needsAnswer": "Needs an answer",
  "food.nextLane": "Next lane",
  "food.err.loadFailed": "Couldn’t load the options — please try again.",
} as const;

export const foodEs: Record<keyof typeof foodEn, string> = {
  "food.title": "Personaliza tu paquete",
  "food.subtitle": "Todo lo de abajo está incluido. Lo que tenga precio es adicional.",
  "food.atCenter": "Las selecciones de comida se tomarán en el centro.",
  "food.lane": "Pista {n}",
  "food.laneOf": "Pista {n} de {total}",
  "food.required": "Obligatorio",
  "food.optional": "Opcional",
  "food.pickOne": "Elige 1",
  "food.pickUpTo": "Elige hasta {n}",
  "food.pickAny": "Elige los que quieras",
  "food.included": "{n} incluido(s)",
  "food.extrasOnLane": "Adicionales en esta pista",
  "food.extrasTotal": "Adicionales",
  "food.done": "Listo",
  "food.needsAnswer": "Falta responder",
  "food.nextLane": "Siguiente pista",
  "food.err.loadFailed": "No pudimos cargar las opciones — inténtalo de nuevo.",
};
