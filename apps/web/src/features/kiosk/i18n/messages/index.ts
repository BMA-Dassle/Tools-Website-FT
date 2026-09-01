/**
 * Message-catalog registry.
 *
 * The catalog is composed from a `en.ts`/`es.ts` CORE (screens converted before
 * the split) plus one fragment file per remaining screen under `./parts/`. Each
 * screen owns its own fragment, so parallel screen conversions never edit a
 * shared file. `MessageKey` is the union of every key across core + fragments.
 *
 * Catalogs are small (a few hundred short strings across 2–3 languages), so
 * they're statically bundled rather than lazy-loaded — this avoids a
 * flash-of-English while an async chunk loads on the fixed-canvas kiosk.
 */
import { en } from "./en";
import { es } from "./es";
import { gamezoneEn, gamezoneEs } from "./parts/gamezone";
import { partyEn, partyEs } from "./parts/party";
import { raceinfoEn, raceinfoEs } from "./parts/raceinfo";
import { paymentEn, paymentEs } from "./parts/payment";
import { racepackEn, racepackEs } from "./parts/racepack";
import { miscEn, miscEs } from "./parts/misc";
import { peopleUiEn, peopleUiEs } from "./parts/peopleUi";
import { checkinEn, checkinEs } from "./parts/checkin";
import { flowEn, flowEs } from "./parts/flow";
import { attractionEn, attractionEs } from "./parts/attraction";
import { giftcardEn, giftcardEs } from "./parts/giftcard";
import { entryscanEn, entryscanEs } from "./parts/entryscan";
import { povEn, povEs } from "./parts/pov";
import { addonsEn, addonsEs } from "./parts/addons";
import { racesimEn, racesimEs } from "./parts/racesim";
import { crewEn, crewEs } from "./parts/crew";
import { nflEn, nflEs } from "./parts/nfl";
import type { KioskLocale } from "../locales";

/** English source of truth — core + every screen fragment. */
const EN = {
  ...en,
  ...gamezoneEn,
  ...partyEn,
  ...raceinfoEn,
  ...paymentEn,
  ...racepackEn,
  ...miscEn,
  ...peopleUiEn,
  ...checkinEn,
  ...flowEn,
  ...attractionEn,
  ...giftcardEn,
  ...entryscanEn,
  ...povEn,
  ...addonsEn,
  ...racesimEn,
  ...crewEn,
  ...nflEn,
};

/** Spanish — each piece is exhaustively typed against its English counterpart. */
const ES = {
  ...es,
  ...gamezoneEs,
  ...partyEs,
  ...raceinfoEs,
  ...paymentEs,
  ...racepackEs,
  ...miscEs,
  ...peopleUiEs,
  ...checkinEs,
  ...flowEs,
  ...attractionEs,
  ...giftcardEs,
  ...entryscanEs,
  ...povEs,
  ...addonsEs,
  ...racesimEs,
  ...crewEs,
  ...nflEs,
};

export type MessageKey = keyof typeof EN;
export type Messages = Record<MessageKey, string>;

const CATALOGS: Record<KioskLocale, Messages> = { en: EN, es: ES };

/** The catalog for a locale (always defined; `en` is the ultimate fallback). */
export function getMessages(locale: KioskLocale): Messages {
  return CATALOGS[locale] ?? EN;
}

/** Raw English source string for a key — the per-key runtime fallback. */
export function fallbackMessage(key: MessageKey): string {
  return EN[key];
}
