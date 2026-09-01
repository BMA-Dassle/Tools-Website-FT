/** "Your Crew" page (/kiosk/racers) i18n fragment. Add `"crew.*"` keys; mirror
 *  every key in es.
 *
 *  Everything inside the roster itself (add player, sign in, waiver, guardian)
 *  comes from parts/party.ts + parts/peopleUi.ts via the mounted people step —
 *  this fragment carries only the page shell and the session-banner door.
 *  Glossary (FastTrax, HeadPinz, Game Zone) stays untranslated. es values are a
 *  first-pass AI translation pending native-Spanish review. */
export const crewEn = {
  "crew.eyebrow": "Players & waivers",
  "crew.title": "Your Crew",
  "crew.subtitle":
    "Add everyone who's here. Each person gets an account and signs their waiver right now — so booking takes seconds.",
  "crew.back": "Back",
  "crew.loading": "Warming up…",
  // Primary hand-off into the booking flow — the party rides the shared session.
  "crew.bookSomething": "Book something",
  "crew.startOver": "Start over",
  // Start-over confirm — this wipes a possibly-live cart, not just the roster.
  "crew.confirm.title": "Clear everyone and start over?",
  "crew.confirm.body":
    "This signs out everyone on this kiosk and empties anything in the cart — the next group starts fresh.",
  "crew.confirm.stay": "Keep my crew",
  "crew.confirm.reset": "Clear & start over",
  "crew.footer.tagline": "No charge yet — this just gets everyone signed in.",
  // Session-banner door (KioskFlow): the signed-in strip's tap-through hint and
  // the chooser-only empty state.
  "crew.banner.manage": "Add or manage players",
  "crew.banner.empty": "Nobody signed in yet · Add your people",
} as const;

export const crewEs: Record<keyof typeof crewEn, string> = {
  "crew.eyebrow": "Jugadores y exenciones",
  "crew.title": "Tu equipo",
  "crew.subtitle":
    "Agrega a todos los que están aquí. Cada persona crea su cuenta y firma su exención ahora mismo — así reservar toma segundos.",
  "crew.back": "Atrás",
  "crew.loading": "Preparando…",
  "crew.bookSomething": "Reservar algo",
  "crew.startOver": "Empezar de nuevo",
  "crew.confirm.title": "¿Quitar a todos y empezar de nuevo?",
  "crew.confirm.body":
    "Esto cierra la sesión de todos en este quiosco y vacía lo que haya en el carrito — el siguiente grupo empieza desde cero.",
  "crew.confirm.stay": "Conservar mi equipo",
  "crew.confirm.reset": "Quitar y empezar de nuevo",
  "crew.footer.tagline": "Sin cargo todavía — esto solo registra a todos.",
  "crew.banner.manage": "Agregar o administrar jugadores",
  "crew.banner.empty": "Nadie ha iniciado sesión · Agrega a tu gente",
};
