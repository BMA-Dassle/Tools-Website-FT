import type { GroupTicket, GroupTicketMember, RaceTicket } from "@/lib/race-tickets";

/** The two HP Arena activities. Both run on the single "HP Arena"
 *  dayplanner resource — the activity is derived from the BMI session
 *  name ("7 - Nexus Laser Tag" / "11 - Nexus Gel Blaster"). */
export type ArenaActivity = "laser-tag" | "gel-blaster";

const ACTIVITY_DISPLAY: Record<ArenaActivity, string> = {
  "laser-tag": "Laser Tag",
  "gel-blaster": "Gel Blaster",
};

export function activityDisplay(activity: ArenaActivity): string {
  return ACTIVITY_DISPLAY[activity];
}

/**
 * Classify a BMI session by name. The HP Arena resource hosts both
 * activities (and could host future ones — parties, events), so the
 * cron must filter: anything unrecognized returns null and is skipped
 * (and logged) rather than ticketed with wrong copy.
 */
export function classifyArenaSession(sessionName: string): ArenaActivity | null {
  const n = sessionName.toLowerCase();
  if (n.includes("laser tag")) return "laser-tag";
  if (n.includes("gel blaster")) return "gel-blaster";
  return null;
}

/** True when a single ticket is an HP Arena ticket (drives the /t/[id]
 *  view branch). Absent `activity` = racing (back-compat). */
export function isArenaTicket(ticket: Pick<RaceTicket, "activity">): boolean {
  return ticket.activity === "laser-tag" || ticket.activity === "gel-blaster";
}

/** True when a group ticket is HP-branded (drives the /g/[id] view
 *  branch). Groups never mix brands — buckets are built per-cron. */
export function isArenaGroup(group: Pick<GroupTicket, "brand">): boolean {
  return group.brand === "headpinz";
}

/** Arena activity of a group member, defaulting to laser-tag display
 *  if the member somehow lacks one (defensive — cron always sets it). */
export function memberActivity(member: Pick<GroupTicketMember, "activity">): ArenaActivity {
  return member.activity === "gel-blaster" ? "gel-blaster" : "laser-tag";
}
