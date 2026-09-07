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
  // Fail-CLOSED states. Before 2026-09-06 a package whose food failed to load
  // said "selections will be taken at the center" and let the guest through —
  // and the kitchen got Pizza Bowls with no pizza. Now the guest retries.
  "food.err.unavailable":
    "We couldn’t load the food choices for this package. Tap Retry — if it keeps failing, our front desk can take your order.",
  "food.retry": "Retry",
  "food.pickN": "Pick {n}",
  // canAdvance reasons (see FOOD_REASON in food-config.ts; KioskFlow maps them).
  "stepReason.foodNotLoaded": "Hang on — loading your package’s food choices",
  "stepReason.foodUnavailable": "We couldn’t load the food choices for this package — tap Retry",
  "stepReason.foodPickEveryGroup": "Make every included pick before you continue",
  "stepReason.foodPickEveryLane": "Make every included pick, for every lane",
  // Post-booking editor (PackageFoodEditor) — confirmation page, open-lane
  // gates (web + kiosk), reservation admin. Copy is shared; the kiosk renders it.
  "food.edit.title": "Your pizza & drink",
  "food.edit.pickFirst": "Pick your pizza topping and drink before you open the lane.",
  "food.edit.missing": "Your package includes food that hasn’t been picked yet — choose it below.",
  "food.edit.save": "Update order",
  "food.edit.saving": "Saving…",
  "food.edit.saved": "Order updated — the kitchen has your choices.",
  "food.edit.laneOpen": "Your lane is already open — see the front desk to change your order.",
  "food.edit.loadFail": "We couldn’t load your food options — tap Retry.",
  "food.edit.saveFail": "We couldn’t update your order. Try again, or see the front desk.",
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
  "food.err.unavailable":
    "No pudimos cargar las opciones de comida de este paquete. Toca Reintentar — si sigue fallando, en recepción pueden tomar tu pedido.",
  "food.retry": "Reintentar",
  "food.pickN": "Elige {n}",
  "stepReason.foodNotLoaded": "Un momento — cargando las opciones de comida de tu paquete",
  "stepReason.foodUnavailable":
    "No pudimos cargar las opciones de comida de este paquete — toca Reintentar",
  "stepReason.foodPickEveryGroup": "Haz todas las elecciones incluidas antes de continuar",
  "stepReason.foodPickEveryLane": "Haz todas las elecciones incluidas, en cada pista",
  "food.edit.title": "Tu pizza y bebida",
  "food.edit.pickFirst": "Elige el ingrediente de tu pizza y tu bebida antes de abrir la pista.",
  "food.edit.missing": "Tu paquete incluye comida que aún no has elegido — escógela abajo.",
  "food.edit.save": "Actualizar pedido",
  "food.edit.saving": "Guardando…",
  "food.edit.saved": "Pedido actualizado — la cocina ya tiene tus elecciones.",
  "food.edit.laneOpen": "Tu pista ya está abierta — pasa a recepción para cambiar tu pedido.",
  "food.edit.loadFail": "No pudimos cargar tus opciones de comida — toca Reintentar.",
  "food.edit.saveFail": "No pudimos actualizar tu pedido. Inténtalo de nuevo o pasa a recepción.",
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
