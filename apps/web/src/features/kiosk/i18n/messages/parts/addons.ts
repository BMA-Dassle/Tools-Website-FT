/** Booking ADD-ONS i18n fragment — the "Race Video & Extras" step's add-on
 *  cards (data/addon-catalog.ts entries) and their cart rows. Key shape is
 *  `${addon.i18nPrefix}.*` — every catalog entry needs its own `.name`,
 *  `.blurb`, `.pickerLabel`, `.cart.rowLabel` pairs here, EN + ES in the same
 *  commit (a missing ES entry fails tsc — do not "fill it in later").
 *
 *  es values are a first-pass AI translation pending native-Spanish review.
 *  Glossary: FastTrax stays untranslated. {price} is a pre-formatted "$X.XX"
 *  string built in the component from the catalog's priceCents; {name}
 *  interpolates the racer's name. */
export const addonsEn = {
  "stepTitle.raceExtras": "Race Video & Extras",

  // --- Extras section (below the POV card) ---
  "addons.sectionTitle": "Extras",

  // --- Replacement headsock ---
  "addon.headsock.name": "Replacement Headsock",
  "addon.headsock.blurb":
    "Your first one is included with your FastTrax license. Need a spare or replacing a lost one? Pick who needs it.",
  "addon.headsock.priceEach": "{price} each",
  "addon.headsock.pickerLabel": "Who needs one?",
  "addon.headsock.perRacerHint": "One per racer — it goes on their racing account",
  "addon.headsock.cart.rowLabel": "Replacement Headsock · {name}",

  // --- Cart row controls (shared by all add-ons) ---
  "addons.cart.change": "Change",
  "addons.cart.remove": "Remove",
} as const;

export const addonsEs: Record<keyof typeof addonsEn, string> = {
  "stepTitle.raceExtras": "Video de carrera y extras",

  // --- Sección de extras (debajo de la tarjeta POV) ---
  "addons.sectionTitle": "Extras",

  // --- Calcetín de cabeza de repuesto ---
  "addon.headsock.name": "Calcetín de cabeza de repuesto",
  "addon.headsock.blurb":
    "El primero está incluido con tu licencia FastTrax. ¿Necesitas uno extra o perdiste el tuyo? Elige quién lo necesita.",
  "addon.headsock.priceEach": "{price} cada uno",
  "addon.headsock.pickerLabel": "¿Quién necesita uno?",
  "addon.headsock.perRacerHint": "Uno por corredor — se registra en su cuenta de carreras",
  "addon.headsock.cart.rowLabel": "Calcetín de repuesto · {name}",

  // --- Controles de la fila del carrito (compartidos) ---
  "addons.cart.change": "Cambiar",
  "addons.cart.remove": "Quitar",
};
