/** Guest race-history sheet (Your Crew roster cards) i18n fragment. Add
 *  `"rh.*"` keys; mirror every key in es.
 *
 *  Glossary stays untranslated: track names (Blue/Red/Mega), level names
 *  (Starter/Intermediate/Pro) and credit KIND labels (which come from BMI data
 *  as-is). "Heat" is "manga" per the flow fragment's precedent. es values are a
 *  first-pass AI translation pending native-Spanish review. */
export const racehistoryEn = {
  "rh.button": "My race history",
  "rh.eyebrow": "Race history",
  "rh.since": "Racing since {date}",
  "rh.licenceOnFile": "Licence on file",
  "rh.loading": "Reading your races…",
  "rh.error": "Couldn’t read race history right now.",
  "rh.races": "Races",
  "rh.thisMonth": "{n} this month",
  "rh.best": "Best {track}",
  "rh.pace": "{level} pace",
  "rh.notYet": "Not yet raced",
  // The two halves of "1.31 s off Pro on Blue — a 43.390 lap gets you there";
  // split so the gap+level half can render bold amber.
  "rh.nextGap": "{gap} off {level}",
  "rh.nextRest": "on {track} — a {time} lap gets you there",
  "rh.credits": "Your credits",
  "rh.creditsFailed": "Couldn’t read balances right now.",
  "rh.noCredits": "No credits right now.",
  "rh.heats": "Your heats",
  "rh.noneYet": "No races on record yet.",
  "rh.th.date": "Date",
  "rh.th.heat": "Heat",
  "rh.th.kart": "Kart",
  "rh.th.best": "Best",
  "rh.th.avg": "Avg",
  "rh.th.laps": "Laps",
  "rh.th.pos": "Pos",
  "rh.close": "Close",
} as const;

export const racehistoryEs: Record<keyof typeof racehistoryEn, string> = {
  "rh.button": "Mi historial de carreras",
  "rh.eyebrow": "Historial de carreras",
  "rh.since": "Corriendo desde {date}",
  "rh.licenceOnFile": "Licencia registrada",
  "rh.loading": "Leyendo tus carreras…",
  "rh.error": "No pudimos leer el historial ahora.",
  "rh.races": "Carreras",
  "rh.thisMonth": "{n} este mes",
  "rh.best": "Mejor {track}",
  "rh.pace": "Ritmo {level}",
  "rh.notYet": "Aún sin correr",
  "rh.nextGap": "{gap} para {level}",
  "rh.nextRest": "en {track} — con una vuelta de {time} llegas",
  "rh.credits": "Tus créditos",
  "rh.creditsFailed": "No pudimos leer los saldos ahora.",
  "rh.noCredits": "Sin créditos por ahora.",
  "rh.heats": "Tus mangas",
  "rh.noneYet": "Todavía no hay carreras registradas.",
  "rh.th.date": "Fecha",
  "rh.th.heat": "Manga",
  "rh.th.kart": "Kart",
  "rh.th.best": "Mejor",
  "rh.th.avg": "Prom",
  "rh.th.laps": "Vueltas",
  "rh.th.pos": "Pos",
  "rh.close": "Cerrar",
};
