/** Payment / card-reader / dispenser guest prompts (KioskReaderPayment,
 *  KioskReaderCheckout, KioskTerminalCheckoutGate, KioskDispenserHold,
 *  CardSlotGuide) i18n fragment. Add `"pay.*"` keys; mirror every key in es.
 *
 *  es values are a first-pass AI translation pending native-Spanish review.
 *  Glossary (FastTrax, HeadPinz, Game Zone) stays untranslated. Server-returned
 *  values (data.error, charge amounts) are NOT keyed here — only our own copy is.
 *  {amount} is a pre-formatted "$X.XX" string built in the component so the
 *  charge/display math is never touched by translation. */
export const paymentEn = {
  // --- Shared reader prompts (KioskReaderPayment + KioskReaderCheckout) ---
  "pay.reader.followPrompts": "Follow the prompts on the card reader",
  "pay.cancel": "Cancel",
  "pay.tryAgain": "Try again",
  "pay.back": "Back",
  "pay.finishingBooking": "Finishing your booking…",
  "pay.err.reachReader": "Couldn’t reach the card reader.",
  "pay.err.startReader": "Couldn’t start the card reader.",

  // --- KioskReaderPayment (SAVE_CARD capture) ---
  "pay.reader.insertToPay": "Insert, tap, or swipe to pay {amount}",
  "pay.reader.cardRead": "Card read",
  "pay.err.startCapture": "Couldn’t start card capture. Please try again.",

  // --- KioskReaderCheckout (direct Terminal charge) ---
  "pay.reader.tapToPay": "Tap, insert, or swipe to pay {amount}",
  "pay.reader.giftCardSwipe":
    "Have a HeadPinz or FastTrax gift card? Swipe it on the credit card reader below.",
  "pay.reader.paymentReceived": "Payment received",

  // --- KioskTerminalCheckoutGate ---
  "pay.gate.gettingReady": "Getting the reader ready…",
  "pay.gate.oneMoment": "One moment",
  "pay.err.startPaymentDesk": "Couldn’t start the payment. Please see the front desk.",
  "pay.err.priceMismatch": "The price didn’t add up — please see the front desk.",
  "pay.err.startPaymentRetry":
    "Couldn’t start the payment. Please try again or see the front desk.",

  // --- KioskDispenserHold (guest-facing copy; the staff-PIN sub-dialog stays
  //     English in-component — it's a staff-only control) ---
  "pay.dispenser.paymentSafe":
    "Your payment is safe — the transaction will pick up right where it left off.",
  "pay.dispenser.resume": "Resume",
  "pay.dispenser.waitingCleared": "Waiting until it’s cleared…",
  "pay.dispenser.resumeUnlocks":
    "Resume unlocks automatically once the dispenser reports it’s clear.",
  "pay.dispenser.seeAttendant": "See an attendant",

  // --- CardSlotGuide (accessible description; the SVG panel labels depict the
  //     physical hardware silkscreen and are intentionally left as-is) ---
  "pay.slotGuide.aria":
    "Insert your game card into the glowing green slot on the left side of the panel",
} as const;

export const paymentEs: Record<keyof typeof paymentEn, string> = {
  // --- Shared reader prompts ---
  "pay.reader.followPrompts": "Sigue las indicaciones en el lector de tarjetas",
  "pay.cancel": "Cancelar",
  "pay.tryAgain": "Intentar de nuevo",
  "pay.back": "Atrás",
  "pay.finishingBooking": "Finalizando tu reserva…",
  "pay.err.reachReader": "No pudimos conectar con el lector de tarjetas.",
  "pay.err.startReader": "No pudimos iniciar el lector de tarjetas.",

  // --- KioskReaderPayment ---
  "pay.reader.insertToPay": "Inserta, toca o desliza para pagar {amount}",
  "pay.reader.cardRead": "Tarjeta leída",
  "pay.err.startCapture": "No pudimos iniciar la captura de la tarjeta. Inténtalo de nuevo.",

  // --- KioskReaderCheckout ---
  "pay.reader.tapToPay": "Toca, inserta o desliza para pagar {amount}",
  "pay.reader.giftCardSwipe":
    "¿Tienes una tarjeta de regalo de HeadPinz o FastTrax? Deslízala en el lector de tarjetas de crédito de abajo.",
  "pay.reader.paymentReceived": "Pago recibido",

  // --- KioskTerminalCheckoutGate ---
  "pay.gate.gettingReady": "Preparando el lector…",
  "pay.gate.oneMoment": "Un momento",
  "pay.err.startPaymentDesk": "No pudimos iniciar el pago. Por favor, acude a la recepción.",
  "pay.err.priceMismatch": "El precio no cuadró — por favor, acude a la recepción.",
  "pay.err.startPaymentRetry":
    "No pudimos iniciar el pago. Inténtalo de nuevo o acude a la recepción.",

  // --- KioskDispenserHold ---
  "pay.dispenser.paymentSafe":
    "Tu pago está seguro — la transacción continuará justo donde se quedó.",
  "pay.dispenser.resume": "Reanudar",
  "pay.dispenser.waitingCleared": "Esperando a que se resuelva…",
  "pay.dispenser.resumeUnlocks":
    "Reanudar se desbloquea automáticamente cuando el dispensador indica que está listo.",
  "pay.dispenser.seeAttendant": "Buscar un encargado",

  // --- CardSlotGuide ---
  "pay.slotGuide.aria":
    "Inserta tu tarjeta de juego en la ranura verde iluminada del lado izquierdo del panel",
};
