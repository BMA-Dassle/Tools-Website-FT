/** The ATTRACTION flow's two reused-web steps — the only guest steps on the
 *  kiosk that were never given a kiosk-native replacement, so they still render
 *  the web wizard's components:
 *
 *    - `contact.*`  — ContactStep ("Your Info"), the attraction flow's 2nd step
 *    - `attraction.*` — AttractionProductStep, the "here's this attraction and
 *      what you can book" screen (description + product cards + qty)
 *
 *  Both components live under `src/components/features/booking/steps/` and are
 *  shared with the WEB wizard. `useLocale()` falls back to the default (English)
 *  locale outside a LocaleProvider, so keying them changes nothing on the web —
 *  see LocaleProvider's FALLBACK_LOCALE_VALUE.
 *
 *  Attraction NAMES, per-attraction descriptions and product names are
 *  data-borne (`lib/attractions-data.ts` → `AttractionConfig.es` /
 *  `AttractionProductDef.es`), not keyed here — same pattern as the combo
 *  marketing copy in `features/combos/combo-specials.ts`.
 *
 *  es values are a first-pass AI translation pending native-Spanish review. */
export const attractionEn = {
  // --- Contact step (ContactStep) ---
  "contact.title": "Your Info",
  "contact.sub": "We’ll send your confirmation and check-in details here.",
  "contact.firstName": "First name",
  "contact.lastName": "Last name",
  "contact.email": "Email",
  "contact.phone": "Phone",
  "contact.smsOptIn": "Send me a text confirmation & check-in reminder",

  // --- Attraction product step (AttractionProductStep) ---
  // `{name}` / `{price}` are data (product name, formatted price). Duration
  // labels are built from the product's minutes.
  "attraction.unknown": "Unknown attraction.",
  "attraction.durationHours": "{hours} hour",
  "attraction.durationMinutes": "{minutes} min",
  "attraction.roster": "{count, plural, one {# player} other {# players}} — {names}",
  "attraction.sessionMinutes": "{minutes} min session",
  "attraction.combo": "Combo",
  "attraction.perPerson": "person",
  "attraction.perLane": "lane",
  "attraction.howMany": "How many people?",
  "attraction.selectAria": "Select {name} — {price}",
  "attraction.selectPlainAria": "Select {name}",
  "attraction.fewerPeople": "Fewer people",
  "attraction.morePeople": "More people",
} as const;

export const attractionEs: Record<keyof typeof attractionEn, string> = {
  // --- Contact step ---
  "contact.title": "Tus datos",
  "contact.sub": "Aquí te enviaremos tu confirmación y los detalles del registro.",
  "contact.firstName": "Nombre",
  "contact.lastName": "Apellido",
  "contact.email": "Correo electrónico",
  "contact.phone": "Teléfono",
  "contact.smsOptIn": "Envíenme por mensaje mi confirmación y recordatorio de registro",

  // --- Attraction product step ---
  "attraction.unknown": "Atracción desconocida.",
  "attraction.durationHours": "{hours} hora",
  "attraction.durationMinutes": "{minutes} min",
  "attraction.roster": "{count, plural, one {# jugador} other {# jugadores}} — {names}",
  "attraction.sessionMinutes": "sesión de {minutes} min",
  "attraction.combo": "Combo",
  "attraction.perPerson": "persona",
  "attraction.perLane": "pista",
  "attraction.howMany": "¿Cuántas personas?",
  "attraction.selectAria": "Seleccionar {name} — {price}",
  "attraction.selectPlainAria": "Seleccionar {name}",
  "attraction.fewerPeople": "Menos personas",
  "attraction.morePeople": "Más personas",
};
