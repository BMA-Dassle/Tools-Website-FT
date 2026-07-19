/** Payload shapes shared by the kiosk waiver API routes and KioskWaiverFlow.
 *  Route files can only export handlers, so the contracts live here. */

export interface KioskWaiverReservationItem {
  projectId: string;
  locationId: number;
  label: string;
  startIso: string;
  stopIso: string;
  timeLabel: string;
  persons: number;
  registeredPersons: number | null;
  kind: "online" | "group";
}

export interface KioskWaiverRosterPerson {
  personId: string;
  displayName: string;
}

export interface KioskWaiverRosterPayload {
  success: boolean;
  projectId: string;
  people: KioskWaiverRosterPerson[];
  counts: { registered: number; valid: number; pending: number };
}
