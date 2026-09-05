/**
 * Every word the driver view says, in both languages.
 *
 * The kiosk's hard rule is that no guest-facing string ships English-only, and
 * the reason behind it applies here with more force than anywhere else on the
 * estate: a ~20-27% Spanish-speaking audience, and copy that tells someone
 * whether to stay in their kart. A half-translated safety screen is worse than
 * none. This surface is not under `/kiosk`, so it is not covered by that
 * catalog's tooling — hence a local one, with the same guarantee: `es` is typed
 * as `Record<CopyKey, string>`, so a missing Spanish string fails the build
 * rather than shipping.
 *
 * Brand and product nouns stay English (FastTrax, Blue Track, Mega). Kart
 * numbers and lap times are numerals in both.
 *
 * TONE. Short imperatives, no hedging, no exclamation marks. A driver reads
 * these at a glance or not at all, and half of them are instructions from race
 * control rather than the product talking.
 */

export const en = {
  // entry
  entryTitle: "What kart are you in?",
  entryHint: "The number on the nose cone.",
  entryStart: "Follow this kart",
  entryClear: "Clear",
  entryUnknown: "Nothing on that kart yet. Check the number, or wait for your heat to start.",

  // orientation
  rotateTitle: "Turn your phone",
  rotateBody: "The timing screen only runs sideways.",
  rotateStill: "Still following — nothing lost",

  // pit board
  labelPosition: "Position",
  labelLastLap: "Last lap",
  labelBest: "Best",
  labelGapAhead: "Gap ahead",
  labelLap: "Lap",
  labelKart: "Kart",
  labelDayRecord: "Day record",
  labelLaps: "Laps",
  labelAverage: "Average",
  labelVsBest: "vs best",
  labelRollout: "rollout",
  labelNoTime: "no time",
  waitingTitle: "Waiting for your heat",
  waitingBody: "This screen wakes up the moment kart {kart} crosses the line.",

  // takeovers
  greenTitle: "Green",
  greenBody: "Clock is running. Go.",
  blueTitle: "Blue flag",
  blueBody: "Faster kart behind you. Move to the side and let them pass.",
  cautionTitle: "Caution",
  cautionBody: "Slow down. No overtaking. Watch for marshals on track.",
  cautionKicker: "Kart {kart} has spun",
  redKicker: "Red flag · all karts stopped",
  redTitle: "Stay in your kart",
  redBody: "Do not get out. A marshal is coming to you.",
  crashTitle: "Crash detect",
  crashKicker: "Your kart has been slowed automatically, for your safety and the safety of others.",
  crashInstruction: "If you are involved and need to reverse:",
  crashHold: "Hold",
  crashYellow: "Yellow button",
  crashThen: "Then press",
  crashGreen: "Green throttle",
  crashWarning: "Look behind you first — other karts are still coming.",
  blackwhiteKicker: "Warning from race control",
  blackwhiteTitle: "Final warning",
  blackwhiteBody: "Unsportsmanlike driving. The next incident ends your race.",
  dsqKicker: "Race over for you",
  dsqTitle: "Disqualified",
  dsqBody: "Return to the pit lane now. Your lap times still count toward your best.",
  pausedTitle: "Paused",
  pausedBody: "The clock is stopped. You will not lose any of your time.",
  chequeredKicker: "Chequered flag",
  chequeredTitle: "Finished",
  chequeredBody: "Slow down, single file, follow the marshal into the pits.",
  marshalNote: "Marshal note",

  // inline
  personalBestTitle: "Personal best",
  personalBestBody: "Your fastest lap tonight.",
  dayRecordTitle: "Fastest lap of the day",
  dayRecordBody: "It stands until someone beats it.",
  monthRecordTitle: "Fastest lap this month",
  monthRecordBody: "Your name goes on the board.",
  everRecordTitle: "Track record — all time",
  everRecordBody: "Fastest anyone has ever gone here.",
  positionUpTitle: "You gained a place",
  recoveredTitle: "Back up to speed",
  recoveredBody: "Full power restored. Rejoin when the track is clear.",
  restrictedTitle: "Kart power limited",
  restrictedBody: "Race control has cut your power. Drive cleanly and it comes back.",
  slowZoneTitle: "Slow-down zone",
  slowZoneBody: "Lift earlier into that corner.",
  reassignedTitle: "You have been moved to another kart",
  reassignedBody: "This screen has switched over. Nothing else for you to do.",
  dnsTitle: "Marked as did-not-start",
  dnsBody: "See the desk — they can re-seat you.",
  aboutToStartTitle: "Your heat is about to start",
  aboutToStartBody: "Head to the grid.",
  finishedTitle: "Your laps are saved",
  finishedBody: "Come back to them any time.",

  // race report sections
  sectionResults: "Full results",
  sectionWhatHappened: "What happened",
  sectionYourLaps: "Your laps",
  sectionHowItWent: "How it went",
  linkFullResults: "See the full results",
  viewResults: "See your laps",

  // race report detail
  labelFastestLap: "Fastest lap of the heat",
  labelRepeatability: "Repeatability",
  labelRepeatabilityHint: "Your best against your typical lap — lower is more consistent.",
  labelImprovement: "Time found",
  labelImprovementHint: "First third of the heat against the last third.",
  labelBestOnLap: "Best on lap {n}",
  labelFieldSpread: "Field spread",
  labelFieldSpreadHint: "Fastest to slowest best lap.",
  labelMostImproved: "Most improved",
  labelGapToFastest: "Off the pace",
  labelNoImprovement: "Held steady",
  levelUpTitle: "Next level",
  levelUpChasing: "{time} for {level} — you are {gap} away.",
  levelUpAchieved: "Your best lap is {level} pace. Ask the desk to move you up.",
  labelNothingYet: "No timed laps in this heat.",

  // states
  feedDownTitle: "Live timing unavailable",
  feedDownBody: "We have lost the feed from the track. Your laps are still being recorded.",
} as const;

export type CopyKey = keyof typeof en;

/**
 * Spanish. Typed against the English keys, so `tsc` fails on a missing entry —
 * the same guarantee the kiosk catalog gives. Do not "fill it in later".
 */
export const es: Record<CopyKey, string> = {
  entryTitle: "¿En qué kart vas?",
  entryHint: "El número en el frente del kart.",
  entryStart: "Seguir este kart",
  entryClear: "Borrar",
  entryUnknown:
    "Todavía no hay nada en ese kart. Revisa el número o espera a que empiece tu carrera.",

  rotateTitle: "Gira tu teléfono",
  rotateBody: "La pantalla de tiempos solo funciona de lado.",
  rotateStill: "Seguimos contigo — no se pierde nada",

  labelPosition: "Posición",
  labelLastLap: "Última vuelta",
  labelBest: "Mejor",
  labelGapAhead: "Diferencia",
  labelLap: "Vuelta",
  labelKart: "Kart",
  labelDayRecord: "Récord del día",
  labelLaps: "Vueltas",
  labelAverage: "Promedio",
  labelVsBest: "vs mejor",
  labelRollout: "salida",
  labelNoTime: "sin tiempo",
  waitingTitle: "Esperando tu carrera",
  waitingBody: "Esta pantalla se activa en cuanto el kart {kart} cruce la línea.",

  greenTitle: "Verde",
  greenBody: "El reloj está corriendo. Adelante.",
  blueTitle: "Bandera azul",
  blueBody: "Kart más rápido detrás de ti. Hazte a un lado y déjalo pasar.",
  cautionTitle: "Precaución",
  cautionBody: "Baja la velocidad. No rebases. Atento a los oficiales en pista.",
  cautionKicker: "El kart {kart} ha trompeado",
  redKicker: "Bandera roja · todos los karts detenidos",
  redTitle: "Quédate en tu kart",
  redBody: "No te bajes. Un oficial va hacia ti.",
  crashTitle: "Choque detectado",
  crashKicker: "Tu kart se ha frenado automáticamente, por tu seguridad y la de los demás.",
  crashInstruction: "Si estás involucrado y necesitas retroceder:",
  crashHold: "Mantén",
  crashYellow: "Botón amarillo",
  crashThen: "Luego pisa",
  crashGreen: "Acelerador verde",
  crashWarning: "Mira hacia atrás primero — todavía vienen otros karts.",
  blackwhiteKicker: "Advertencia de control de carrera",
  blackwhiteTitle: "Última advertencia",
  blackwhiteBody: "Conducción antideportiva. El próximo incidente termina tu carrera.",
  dsqKicker: "Tu carrera ha terminado",
  dsqTitle: "Descalificado",
  dsqBody: "Regresa a los pits ahora. Tus tiempos siguen contando para tu mejor vuelta.",
  pausedTitle: "En pausa",
  pausedBody: "El reloj está detenido. No perderás nada de tu tiempo.",
  chequeredKicker: "Bandera a cuadros",
  chequeredTitle: "Terminado",
  chequeredBody: "Baja la velocidad, en fila, sigue al oficial hacia los pits.",
  marshalNote: "Nota del oficial",

  personalBestTitle: "Tu mejor vuelta",
  personalBestBody: "Tu vuelta más rápida de hoy.",
  dayRecordTitle: "Vuelta más rápida del día",
  dayRecordBody: "Se mantiene hasta que alguien la supere.",
  monthRecordTitle: "Vuelta más rápida del mes",
  monthRecordBody: "Tu nombre va al tablero.",
  everRecordTitle: "Récord de la pista — histórico",
  everRecordBody: "Lo más rápido que alguien ha ido aquí.",
  positionUpTitle: "Ganaste una posición",
  recoveredTitle: "De vuelta a toda potencia",
  recoveredBody: "Potencia restaurada. Reincorpórate cuando la pista esté libre.",
  restrictedTitle: "Potencia del kart limitada",
  restrictedBody: "Control de carrera cortó tu potencia. Conduce limpio y volverá.",
  slowZoneTitle: "Zona de frenado",
  slowZoneBody: "Levanta el pie antes en esa curva.",
  reassignedTitle: "Te han cambiado de kart",
  reassignedBody: "Esta pantalla ya cambió. No tienes que hacer nada más.",
  dnsTitle: "Marcado como no iniciado",
  dnsBody: "Habla con recepción — pueden reubicarte.",
  aboutToStartTitle: "Tu carrera está por empezar",
  aboutToStartBody: "Dirígete a la parrilla.",
  finishedTitle: "Tus vueltas están guardadas",
  finishedBody: "Puedes volver a verlas cuando quieras.",

  feedDownTitle: "Tiempos en vivo no disponibles",
  feedDownBody: "Perdimos la señal de la pista. Tus vueltas se siguen registrando.",

  sectionResults: "Resultados completos",
  sectionWhatHappened: "Qué pasó",
  sectionYourLaps: "Tus vueltas",
  sectionHowItWent: "Cómo te fue",
  linkFullResults: "Ver resultados completos",
  viewResults: "Ver tus vueltas",

  labelFastestLap: "Vuelta más rápida de la carrera",
  labelRepeatability: "Constancia",
  labelRepeatabilityHint: "Tu mejor vuelta contra tu vuelta típica — menos es más constante.",
  labelImprovement: "Tiempo ganado",
  labelImprovementHint: "El primer tercio de la carrera contra el último.",
  labelBestOnLap: "Mejor en la vuelta {n}",
  labelFieldSpread: "Diferencia del grupo",
  labelFieldSpreadHint: "De la mejor vuelta más rápida a la más lenta.",
  labelMostImproved: "Mayor progreso",
  labelGapToFastest: "Diferencia con el líder",
  labelNoImprovement: "Ritmo constante",
  levelUpTitle: "Siguiente nivel",
  levelUpChasing: "{time} para {level} — te faltan {gap}.",
  levelUpAchieved: "Tu mejor vuelta es ritmo de {level}. Pide en recepción que te suban.",
  labelNothingYet: "No hay vueltas cronometradas en esta carrera.",
};

export type Locale = "en" | "es";

/** One string, with `{kart}`-style holes filled. */
export function t(locale: Locale, key: CopyKey, vars?: Record<string, string>): string {
  const base = locale === "es" ? es[key] : en[key];
  if (!vars) return base;
  return base.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}
