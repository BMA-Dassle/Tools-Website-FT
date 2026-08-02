/** Entry-screen scanning (attract + the category chooser/shelves) i18n
 *  fragment. Add `"entryscan.*"` keys; mirror every key in es.
 *
 *  These are the ONLY guest-visible strings the entry-scan feature produces —
 *  a successful scan navigates and says nothing, so everything here is a miss
 *  message. Copy rule: never blame the guest and never leave them stuck. Each
 *  line names what happened and where the nearest human is. Glossary
 *  (FastTrax, HeadPinz, Game Zone) stays untranslated. es values are a
 *  first-pass AI translation pending native-Spanish review. */
export const entryscanEn = {
  // Square gift card — recognised, but it has no entry-screen destination yet
  // (owner 2026-08-02: "we will introduce others later").
  "entryscan.giftCard":
    "Gift cards are used at checkout — start your booking and pay with it there.",
  // A driver's licence under the scanner. Licences ARE used for sign-in deeper
  // in the flow, so point at that rather than calling it wrong.
  "entryscan.license":
    "That's a driver's licence — you can scan it once you've picked an activity.",
  // Anything no classifier recognised.
  "entryscan.unknown": "We couldn't read that one — a team member can help.",
  // Recognised, but the destination is switched off on this kiosk.
  "entryscan.noDestination": "We can't use that at this kiosk — a team member can help.",
  // The lookup was rate-limited.
  "entryscan.tryAgain": "Just a moment — try that scan again.",
  // Shown while the one conditional lookup is in flight.
  "entryscan.checking": "Checking that code…",
} as const;

export const entryscanEs: Record<keyof typeof entryscanEn, string> = {
  "entryscan.giftCard":
    "Las tarjetas de regalo se usan al pagar: comienza tu reserva y paga con ella allí.",
  "entryscan.license":
    "Eso es una licencia de conducir: puedes escanearla cuando hayas elegido una actividad.",
  "entryscan.unknown": "No pudimos leer eso. Un miembro del equipo puede ayudarte.",
  "entryscan.noDestination":
    "No podemos usar eso en este quiosco. Un miembro del equipo puede ayudarte.",
  "entryscan.tryAgain": "Un momento: intenta escanear de nuevo.",
  "entryscan.checking": "Verificando ese código…",
};
