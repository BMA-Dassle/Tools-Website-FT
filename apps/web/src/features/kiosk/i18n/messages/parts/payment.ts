/** Payment / card-reader / dispenser guest prompts (KioskReaderPayment,
 *  KioskReaderCheckout, KioskTerminalCheckoutGate, KioskDispenserHold,
 *  CardSlotGuide) i18n fragment. Add `"pay.*"` keys; mirror every key in es. */
export const paymentEn = {} as const;

export const paymentEs: Record<keyof typeof paymentEn, string> = {};
