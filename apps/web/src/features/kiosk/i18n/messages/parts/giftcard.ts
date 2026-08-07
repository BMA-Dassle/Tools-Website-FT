/** Gift-card payment flow (KioskGiftCardFlow + the pay-screen entry button)
 *  i18n fragment. Add `"giftcard.*"` keys; mirror every key in es.
 *
 *  v1 product rule (owner 2026-07-29): guest copy speaks ONLY of gift cards —
 *  the word "split" never appears; multi-card splitting arrives later on the
 *  same rail. {amount} / {last4} are pre-formatted in the component so charge
 *  math is never touched by translation. Glossary (FastTrax, HeadPinz, Game
 *  Zone) stays untranslated. es values are a first-pass AI translation pending
 *  native-Spanish review. */
export const giftcardEn = {
  // --- Pay-screen entry (replaces pay.reader.giftCardSwipe when the flag is on) ---
  "giftcard.useButton": "Use a gift card",

  // --- Capture screen ---
  "giftcard.eyebrow": "Gift card",
  "giftcard.addTitle": "Add a gift card",
  "giftcard.leftToPay": "Left to pay",
  "giftcard.scanPrompt": "Scan the QR code from your gift card email at the scanner below",
  "giftcard.swipePrompt": "…or swipe a plastic gift card",
  "giftcard.typeInstead": "Type the number instead",
  "giftcard.numberLabel": "Gift card number",
  "giftcard.lookupCta": "Look up",
  "giftcard.checking": "Checking that card…",

  // --- Confirm ---
  "giftcard.found": "Gift card •••• {last4}",
  "giftcard.balance": "Balance {amount}",
  "giftcard.applyQuestion": "Apply {amount} toward your total?",
  "giftcard.applyCta": "Apply {amount}",

  // --- Applied board ---
  "giftcard.appliedEyebrow": "Gift card applied",
  "giftcard.appliedChip": "Gift card •••• {last4} — applied {amount}",
  "giftcard.total": "Total",
  "giftcard.remove": "Remove",
  "giftcard.payRest": "Pay {amount} by card",
  "giftcard.finishPayment": "Finish payment",
  "giftcard.cancelStartOver": "Cancel and start over",

  // --- Reader (split) ---
  "giftcard.readerExactAmount": "The reader shows this exact amount.",

  // --- Ambient pay screen (2026-08: no button — scan/swipe just works) ---
  "giftcard.ambientHint":
    "Have a gift card? Swipe it at the card reader, or scan its QR code at the scanner below.",
  "giftcard.cardHold": "Card •••• {last4} — {amount} approved",
  "giftcard.applying": "Applying your gift card…",
  "giftcard.coversAll": "Your gift card covers the whole payment — finishing up…",
  "giftcard.enterNumber": "Enter a gift card number",
  "giftcard.limitReached": "Gift card limit reached — pay the rest by card.",
  "giftcard.cancelConfirm.title": "Cancel this payment?",
  "giftcard.cancelConfirm.body":
    "We'll release every gift card and card hold — nothing has been charged.",
  "giftcard.cancelConfirm.keep": "Keep paying",
  "giftcard.cancelConfirm.confirm": "Cancel payment",

  // --- Errors / rejections (our copy; server detail may append) ---
  "giftcard.err.notGiftCard":
    "That doesn’t look like a gift card — scan the QR code from your gift card email.",
  "giftcard.err.gamezoneCard": "That’s a Game Zone play card, not a gift card.",
  "giftcard.err.lookup": "We couldn’t use that gift card — check the number or see the front desk.",
  "giftcard.err.apply": "Couldn’t apply the gift card. Please try again.",
  "giftcard.err.capture": "We couldn’t finish the payment — try again or see the front desk.",
  "giftcard.err.scanNotUsable":
    "We can only use gift cards here — a team member can help with anything else.",
} as const;

export const giftcardEs: Record<keyof typeof giftcardEn, string> = {
  "giftcard.useButton": "Usa una tarjeta de regalo",

  "giftcard.eyebrow": "Tarjeta de regalo",
  "giftcard.addTitle": "Agregar una tarjeta de regalo",
  "giftcard.leftToPay": "Falta por pagar",
  "giftcard.scanPrompt":
    "Escanea el código QR del correo de tu tarjeta de regalo en el escáner de abajo",
  "giftcard.swipePrompt": "…o desliza una tarjeta de regalo física",
  "giftcard.typeInstead": "Escribir el número",
  "giftcard.numberLabel": "Número de la tarjeta de regalo",
  "giftcard.lookupCta": "Buscar",
  "giftcard.checking": "Verificando la tarjeta…",

  "giftcard.found": "Tarjeta de regalo •••• {last4}",
  "giftcard.balance": "Saldo {amount}",
  "giftcard.applyQuestion": "¿Aplicar {amount} a tu total?",
  "giftcard.applyCta": "Aplicar {amount}",

  "giftcard.appliedEyebrow": "Tarjeta de regalo aplicada",
  "giftcard.appliedChip": "Tarjeta de regalo •••• {last4} — aplicado {amount}",
  "giftcard.total": "Total",
  "giftcard.remove": "Quitar",
  "giftcard.payRest": "Paga {amount} con tarjeta",
  "giftcard.finishPayment": "Finalizar pago",
  "giftcard.cancelStartOver": "Cancelar y empezar de nuevo",

  "giftcard.readerExactAmount": "El lector muestra esta cantidad exacta.",

  "giftcard.ambientHint":
    "¿Tienes una tarjeta de regalo? Deslízala en el lector de tarjetas o escanea su código QR en el escáner de abajo.",
  "giftcard.cardHold": "Tarjeta •••• {last4} — {amount} aprobado",
  "giftcard.applying": "Aplicando tu tarjeta de regalo…",
  "giftcard.coversAll": "Tu tarjeta de regalo cubre todo el pago — finalizando…",
  "giftcard.enterNumber": "Escribir el número de una tarjeta de regalo",
  "giftcard.limitReached": "Límite de tarjetas de regalo alcanzado — paga el resto con tarjeta.",
  "giftcard.cancelConfirm.title": "¿Cancelar este pago?",
  "giftcard.cancelConfirm.body":
    "Liberaremos todas las retenciones de tarjetas — no se ha cobrado nada.",
  "giftcard.cancelConfirm.keep": "Seguir pagando",
  "giftcard.cancelConfirm.confirm": "Cancelar el pago",

  "giftcard.err.notGiftCard":
    "Eso no parece una tarjeta de regalo — escanea el código QR del correo de tu tarjeta de regalo.",
  "giftcard.err.gamezoneCard":
    "Esa es una tarjeta de juego de Game Zone, no una tarjeta de regalo.",
  "giftcard.err.lookup":
    "No pudimos usar esa tarjeta de regalo — revisa el número o acude a la recepción.",
  "giftcard.err.apply": "No pudimos aplicar la tarjeta de regalo. Inténtalo de nuevo.",
  "giftcard.err.capture":
    "No pudimos finalizar el pago — inténtalo de nuevo o acude a la recepción.",
  "giftcard.err.scanNotUsable":
    "Aquí solo podemos usar tarjetas de regalo — un miembro del equipo puede ayudarte con lo demás.",
};
