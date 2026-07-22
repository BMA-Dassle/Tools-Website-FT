import { RaceInfoScreen } from "~/features/kiosk/components/race-info/RaceInfoScreen";

/**
 * /kiosk/race-info — view-only Race Info hub: upcoming races (live
 * availability), track records, race types, and track layouts, plus a Book
 * Now bar into the booking flow. The attract-screen button is OPT-IN via
 * NEXT_PUBLIC_KIOSK_RACE_INFO_ENABLED (default OFF) and Fort-Myers-only;
 * this page stays reachable by typed URL either way for staff testing.
 */
export default function KioskRaceInfoPage() {
  return <RaceInfoScreen />;
}
