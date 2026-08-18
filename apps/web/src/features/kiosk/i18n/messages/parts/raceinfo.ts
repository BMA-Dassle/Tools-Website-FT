/** Race-info hub (components/race-info/*) i18n fragment. Add `"raceInfo.*"` keys;
 *  mirror every key in es. First-pass AI translation pending native review.
 *
 *  SCOPE: only the hardcoded guest-facing copy authored in the five race-info
 *  components is keyed here. Copy that comes from the shared racing-content /
 *  race-records CONSTANTS (track names/blurbs, kart classes + specs, race-type
 *  ladder cards, SMS-Timing record rows) is data-supplied and stays as returned
 *  — those modules are outside this pass. Race tier names (Starter /
 *  Intermediate / Pro) and track names (Blue / Red / Mega) are racing proper
 *  nouns and are NOT translated. Locked glossary (FastTrax, HeadPinz, Game Zone,
 *  Podium, Pit Crew, Duckpin) stays untranslated too. A few inline-<strong>
 *  rich-text sentences (the Racing License note, the kart-spec line) are left
 *  English with a TODO(i18n) in the component, mirroring the KioskConfirmation
 *  precedent — the plain-string formatMessage engine can't render ICU tags. */
export const raceinfoEn = {
  // Section titles (tile hub + per-view header).
  "raceInfo.title.hub": "Race Info",
  "raceInfo.title.upcoming": "Upcoming Races",
  "raceInfo.title.records": "Race Records",
  "raceInfo.title.types": "Race Types",
  "raceInfo.title.tracks": "The Tracks",

  // Header chrome. "FastTrax" is a locked glossary noun; "Fort Myers" is a place
  // name kept literal in the component.
  "raceInfo.eyebrow.karting": "FastTrax Karting",
  "raceInfo.backToStart": "Back to start",
  "raceInfo.aria.backToRaceInfo": "Back to Race Info",

  // Naples redirect notice (racing is Fort-Myers-only).
  "raceInfo.naples.title": "Racing lives at Fort Myers",
  "raceInfo.naples.body":
    "FastTrax karting runs at our Fort Myers campus. This kiosk can still book bowling, blasters & laser tag.",

  // Tile landing cards. Card titles reuse the raceInfo.title.* keys above.
  "raceInfo.card.upcoming.eyebrow": "Live · Today",
  "raceInfo.card.upcoming.blurb": "Today’s race times & open seats, live from the track.",
  "raceInfo.card.records.eyebrow": "Hall of Fame",
  "raceInfo.card.records.blurb": "Fastest laps ever set — every track, every class.",
  "raceInfo.card.types.eyebrow": "Starter to Pro",
  "raceInfo.card.types.blurb": "How the qualification ladder works — and how you level up.",
  "raceInfo.card.tracks.eyebrow": "Blue · Red · Mega",
  "raceInfo.card.tracks.blurb": "Three layouts up to 2,108 ft — and the karts that run them.",

  // Book-now CTA + footer tagline.
  "raceInfo.bookNow": "Book now",
  "raceInfo.footer.tagline": "Racing · Bowling · Attractions",

  // Shared bits.
  "raceInfo.loading": "Loading…",
  "raceInfo.class.adult": "Adult",
  "raceInfo.class.junior": "Junior",

  // Race Records sub-screen. Track labels, participant names, dates and lap
  // scores are server data and stay as returned.
  "raceInfo.range.alltime": "All-Time",
  "raceInfo.range.year": "This Year",
  "raceInfo.range.month": "This Month",
  "raceInfo.records.trackRecord": "Track Record · {track}",
  "raceInfo.records.topN": "{track} — Top 5",
  "raceInfo.records.empty": "No times posted yet — go set one.",

  // Race Types sub-screen. Ladder cards (title/age/qualification/description)
  // come from the racing-content constants and stay as returned; only the
  // intro line and the "Qualification:" label are hardcoded here.
  "raceInfo.types.intro":
    "Every racer starts in Starter. Beat the qualifying lap time and the next speed unlocks on your racing license — no levels skipped.",
  "raceInfo.types.qualificationLabel": "Qualification: ",

  // The Tracks sub-screen. Track layouts, kart classes and specs come from the
  // racing-content constants; only the layout image alt text is hardcoded.
  "raceInfo.tracks.layoutAlt": "{track} layout animation",

  // Upcoming Races sub-screen. Track names, delay strings, heat time labels and
  // statusLabel come from the live feed and stay as returned.
  "raceInfo.upcoming.nowCheckingIn": "Now Checking In",
  "raceInfo.upcoming.onTime": "On Time",
  /**
   * THE LATE HALF OF THE STATUS BAND. `onTime` above is the other half.
   *
   * The band briefly showed a check-in time instead; that was wrong twice over —
   * a band labelled STATUS should carry a verdict, and the "Now Checking In" line
   * directly above it already prints that same minute (owner 2026-08-17: "it
   * should show on-time or + whatever").
   */
  "raceInfo.upcoming.lateBy": "+{mins} late",
  "raceInfo.filter.all": "All",
  "raceInfo.upcoming.loading": "Loading today’s races…",
  "raceInfo.upcoming.error":
    "Race times aren’t loading right now — our crew at the front desk has the full schedule.",
  "raceInfo.upcoming.megaNoJunior.title": "No Junior races on the Mega Track",
  "raceInfo.upcoming.megaNoJunior.body":
    "The Mega Track runs adults only. Check back on a Red & Blue day for Junior heats.",
  "raceInfo.upcoming.empty":
    "No more {cls, select, junior {Junior} other {Adult}} races on the board today.",
  "raceInfo.upcoming.spotsLeft": "{count, plural, one {# spot left} other {# spots left}}",
  "raceInfo.upcoming.ladderNote":
    "Intermediate & Pro require a qualifying lap time — everyone starts in Starter. Tap Book Now on the previous screen to grab a seat.",
} as const;

export const raceinfoEs: Record<keyof typeof raceinfoEn, string> = {
  "raceInfo.title.hub": "Info de Carreras",
  "raceInfo.title.upcoming": "Próximas Carreras",
  "raceInfo.title.records": "Récords de Carrera",
  "raceInfo.title.types": "Tipos de Carrera",
  "raceInfo.title.tracks": "Las Pistas",

  "raceInfo.eyebrow.karting": "FastTrax Karting",
  "raceInfo.backToStart": "Volver al inicio",
  "raceInfo.aria.backToRaceInfo": "Volver a Info de Carreras",

  "raceInfo.naples.title": "Las carreras están en Fort Myers",
  "raceInfo.naples.body":
    "El karting de FastTrax funciona en nuestro campus de Fort Myers. Este kiosco todavía puede reservar boliche, blasters y láser tag.",

  "raceInfo.card.upcoming.eyebrow": "En vivo · Hoy",
  "raceInfo.card.upcoming.blurb":
    "Horarios de carreras y lugares disponibles de hoy, en vivo desde la pista.",
  "raceInfo.card.records.eyebrow": "Salón de la Fama",
  "raceInfo.card.records.blurb": "Las vueltas más rápidas de la historia — cada pista, cada clase.",
  "raceInfo.card.types.eyebrow": "De Starter a Pro",
  "raceInfo.card.types.blurb":
    "Cómo funciona la escalera de clasificación — y cómo subes de nivel.",
  "raceInfo.card.tracks.eyebrow": "Blue · Red · Mega",
  "raceInfo.card.tracks.blurb": "Tres trazados de hasta 2,108 ft — y los karts que los recorren.",

  "raceInfo.bookNow": "Reservar ahora",
  "raceInfo.footer.tagline": "Carreras · Boliche · Atracciones",

  "raceInfo.loading": "Cargando…",
  "raceInfo.class.adult": "Adulto",
  "raceInfo.class.junior": "Junior",

  "raceInfo.range.alltime": "Histórico",
  "raceInfo.range.year": "Este año",
  "raceInfo.range.month": "Este mes",
  "raceInfo.records.trackRecord": "Récord de pista · {track}",
  "raceInfo.records.topN": "{track} — Top 5",
  "raceInfo.records.empty": "Aún no hay tiempos registrados — ve a marcar uno.",

  "raceInfo.types.intro":
    "Cada corredor empieza en Starter. Supera el tiempo de vuelta de clasificación y la siguiente velocidad se desbloquea en tu licencia de carreras — sin saltarte niveles.",
  "raceInfo.types.qualificationLabel": "Clasificación: ",

  "raceInfo.tracks.layoutAlt": "animación del trazado de {track}",

  "raceInfo.upcoming.nowCheckingIn": "Registrándose ahora",
  "raceInfo.upcoming.onTime": "A tiempo",
  // Pairs with "A tiempo" above. Short enough for the band's 26px chip.
  "raceInfo.upcoming.lateBy": "+{mins} de retraso",
  "raceInfo.filter.all": "Todas",
  "raceInfo.upcoming.loading": "Cargando las carreras de hoy…",
  "raceInfo.upcoming.error":
    "Los horarios de carreras no se están cargando en este momento — nuestro equipo en la recepción tiene el horario completo.",
  "raceInfo.upcoming.megaNoJunior.title": "No hay carreras Junior en la Mega Track",
  "raceInfo.upcoming.megaNoJunior.body":
    "La Mega Track es solo para adultos. Vuelve en un día de Red y Blue para las tandas Junior.",
  "raceInfo.upcoming.empty":
    "No quedan más carreras {cls, select, junior {Junior} other {Adulto}} en el tablero hoy.",
  "raceInfo.upcoming.spotsLeft":
    "{count, plural, one {# lugar disponible} other {# lugares disponibles}}",
  "raceInfo.upcoming.ladderNote":
    "Intermediate y Pro requieren un tiempo de vuelta de clasificación — todos empiezan en Starter. Toca Reservar ahora en la pantalla anterior para conseguir un lugar.",
};
