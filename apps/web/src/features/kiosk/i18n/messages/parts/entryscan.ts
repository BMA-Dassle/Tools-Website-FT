/** Entry-screen scanning (attract + the category chooser/shelves) i18n
 *  fragment. Add `"entryscan.*"` keys; mirror every key in es.
 *
 *  These are the guest-visible strings the entry-scan feature produces. A scan
 *  that navigates says nothing — the screen change IS the feedback — so almost
 *  everything here is a miss message; the one exception is a racer scanning on
 *  the chooser, which has somewhere to put their identity but nowhere to send
 *  them. Copy rule: never blame the guest and never leave them stuck. Each line
 *  names what happened and where the nearest human is. Glossary (FastTrax,
 *  HeadPinz, Game Zone) stays untranslated. es values are a first-pass AI
 *  translation pending native-Spanish review. */
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
  // A racing licence / member code scanned on the chooser, where there is no
  // screen to move to. Deliberately does NOT claim "signed in": when check-in
  // is switched off we skip the lookup, so the people step is the first thing
  // that actually proves the code resolves to somebody.
  "entryscan.racerSignedIn": "Got it — pick an activity and we'll have you ready to go.",
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
  "entryscan.racerSignedIn": "Listo: elige una actividad y te dejamos todo preparado.",
};
