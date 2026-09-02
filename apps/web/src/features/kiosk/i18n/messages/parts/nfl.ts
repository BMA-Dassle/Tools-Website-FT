/**
 * NFL Ticket on NeoVerse — guest-facing copy, EN + ES.
 *
 * The game picker is a SHARED web/kiosk step, and `useLocale` falls back to the
 * default locale when there is no provider, so these keys serve the web flow in
 * English and the kiosk in whichever language the guest chose.
 *
 * LOCKED GLOSSARY — never translated: NFL, NeoVerse, HeadPinz, FastTrax. Team
 * names stay in English too; "Chiefs at Bills" is how the matchup is printed on
 * every screen in the building, and translating one half of it would make the
 * card harder to match to the TV, not easier.
 *
 * "Wings", "pizza" and "pitcher" DO translate — they are food, not brands.
 */

export const nflEn = {
  "nfl.title": "Pick your game",
  "nfl.subtitle":
    "Your game on the NeoVerse LED walls. Lanes open 15 minutes before kickoff and are yours for 3 hours — shoes, a one-topping pizza, 10 wings and a soda pitcher included.",
  /** e.g. "1:00 PM kickoff · lanes open 12:45 PM · CBS" */
  "nfl.card.times": "{kickoff} kickoff · lanes open {open}",
  /** Heading above each kickoff window — the time is said once, not per game. */
  "nfl.window.opens": "lanes open {open}",
  /** The day's per-lane price, shown once above the list. */
  "nfl.priceLine": "{price} per lane",
  "nfl.card.soldOut": "Sold out",
  "nfl.card.perLane": "/lane",
  "nfl.card.holding": "Holding your lane…",
  "nfl.pickDate": "Which day?",
  "nfl.dateToday": "Today",
  "nfl.dateTomorrow": "Tomorrow",
  "nfl.noSchedule":
    "No football on the schedule in the next few weeks. Check back once the next slate is out.",
  "nfl.empty": "No football on this date — pick another day.",
  "nfl.footer":
    "Up to 6 bowlers a lane. Game going long? Tell the front desk — we’ll do our best to keep the party going.",
  "nfl.tooManyLanes":
    "{players} bowlers needs {lanes} lanes, and NFL Ticket seats up to {max} per booking. Give us a call and we’ll set the group up.",
  "nfl.err.noCenter":
    "We couldn’t tell which location this is for. Go back and re-select your center.",
  "nfl.err.notSetUp": "NFL lanes aren’t set up for this date yet — please check back soon.",
  "nfl.err.notBookable": "NFL lanes aren’t bookable right now — please check back soon.",
  "nfl.err.holdFailed": "Couldn’t reserve this game window. Try another game.",
  "nfl.err.probeFailed": "Couldn’t check that game window — please try again.",
  "nfl.err.loadFailed": "Couldn’t load the games — please try again.",
  "stepTitle.pickYourGame": "Pick Your Game",
  "stepReason.nflGame": "Pick your game to hold a VIP lane",
} as const;

export const nflEs: Record<keyof typeof nflEn, string> = {
  "nfl.title": "Elige tu partido",
  "nfl.subtitle":
    "Tu partido en las pantallas LED de NeoVerse. Las pistas abren 15 minutos antes del saque inicial y son tuyas por 3 horas — incluye zapatos, una pizza de un ingrediente, 10 alitas y una jarra de refresco.",
  "nfl.card.times": "Saque inicial {kickoff} · pistas abren {open}",
  "nfl.window.opens": "pistas abren {open}",
  "nfl.priceLine": "{price} por pista",
  "nfl.card.soldOut": "Agotado",
  "nfl.card.perLane": "/pista",
  "nfl.card.holding": "Apartando tu pista…",
  "nfl.pickDate": "¿Qué día?",
  "nfl.dateToday": "Hoy",
  "nfl.dateTomorrow": "Mañana",
  "nfl.noSchedule":
    "No hay fútbol americano programado en las próximas semanas. Vuelve cuando salga el próximo calendario.",
  "nfl.empty": "No hay fútbol americano en esta fecha — elige otro día.",
  "nfl.footer":
    "Hasta 6 jugadores por pista. ¿El partido se alarga? Avisa en recepción y haremos lo posible por alargar la fiesta.",
  "nfl.tooManyLanes":
    "{players} jugadores necesitan {lanes} pistas, y NFL Ticket admite hasta {max} por reserva. Llámanos y preparamos el grupo.",
  "nfl.err.noCenter":
    "No pudimos identificar la ubicación. Vuelve atrás y selecciona tu centro de nuevo.",
  "nfl.err.notSetUp": "Las pistas de NFL aún no están listas para esta fecha — vuelve pronto.",
  "nfl.err.notBookable": "Las pistas de NFL no se pueden reservar ahora — vuelve pronto.",
  "nfl.err.holdFailed": "No pudimos apartar este horario. Prueba con otro partido.",
  "nfl.err.probeFailed": "No pudimos comprobar ese horario — inténtalo de nuevo.",
  "nfl.err.loadFailed": "No pudimos cargar los partidos — inténtalo de nuevo.",
  "stepTitle.pickYourGame": "Elige tu partido",
  "stepReason.nflGame": "Elige tu partido para apartar una pista VIP",
};
