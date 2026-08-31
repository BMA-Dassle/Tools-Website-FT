import redis from "@/lib/redis";
import { detectConflicts, conflictAdminLabel } from "@/lib/healthnet-conflicts";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";
import { adminPoppins } from "~/components/features/admin-skin/font";
import HealthnetRosterClient, {
  type RosterRow,
} from "@/app/admin/[token]/healthnet/HealthnetRosterClient";

/**
 * Health Net Team Day roster — everyone's name, scheduled times, and who has
 * completed check-in (the "almost here" confirm flow).
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/healthnet` (v1 — the static token in the path) and
 * `/admin/healthnet` (v2 — a Microsoft SSO session, no credential in the URL
 * at all).
 *
 * Reads the RSVP records straight from Redis and hands the rows down. No
 * `mintAdminApiToken()`: the client renders server-fetched rows and calls no
 * `/api/admin/*` endpoint, so there is no credential to give it.
 */

const RESOLUTION_LABELS: Record<string, string> = {
  "earlier-race": "wants earlier race",
  "later-race": "wants later race",
  "later-activity": "wants gel/laser later",
  "earlier-activity": "wants gel/laser earlier",
  "adjust-race": "adjust race",
  "adjust-activity": "adjust gel/laser",
  keep: "keep as-is",
};

const SLUG = "healthnet-2026";

/** "2026-06-19T10:24:00" (naive ET) → "10:24 AM". */
function fmtTime(iso?: string): string {
  if (!iso) return "";
  const tp = iso.replace(/Z$/, "").split("T")[1];
  if (!tp) return "";
  const [h, m] = tp.split(":").map(Number);
  if (Number.isNaN(h)) return "";
  return `${((h + 11) % 12) + 1}:${String(Number.isNaN(m) ? 0 : m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export default async function AdminToolPage() {
  const emails = await redis.smembers(`groupevent:${SLUG}:rsvp-index`);
  const keys = emails.map((e) => `groupevent:${SLUG}:rsvp:${e}`);
  const datas = keys.length ? await redis.mget(keys) : [];

  const rows: RosterRow[] = [];
  for (const data of datas) {
    if (!data) continue;
    let r: GroupEventRsvp;
    try {
      r = JSON.parse(data);
    } catch {
      continue;
    }
    const resv = r.reservations || [];
    const race = resv.find((x) => x.type === "racing");
    const gel = resv.find((x) => x.type === "gel-blaster");
    const laser = resv.find((x) => x.type === "laser-tag");
    // Earliest scheduled time → used for sorting the day's flow.
    const firstTime = resv
      .map((x) => x.time)
      .filter(Boolean)
      .sort()[0];
    const conflicts = detectConflicts(r);
    rows.push({
      name: r.name || "(no name)",
      email: r.email,
      phone: r.phone || "",
      racing: race ? `${race.track ? race.track + " " : ""}${fmtTime(race.time)}`.trim() : "",
      gelBlaster: gel ? fmtTime(gel.time) : "",
      laserTag: laser ? fmtTime(laser.time) : "",
      // Raw ISO times (naive ET, same day) for chronological column sorting —
      // the display strings above (12h, track-prefixed) don't sort by time as text.
      racingTime: race?.time || "",
      gelTime: gel?.time || "",
      laserTime: laser?.time || "",
      freeflow: (r.freeflow || []).join(", "),
      checkedIn: !!r.confirmedAt,
      confirmedAt: r.confirmedAt || "",
      firstTime: firstTime || "",
      conflict: conflicts.length ? conflictAdminLabel(conflicts) : "",
      conflictResolution: r.conflictResolution
        ? RESOLUTION_LABELS[r.conflictResolution] || r.conflictResolution
        : "",
      conflictStayWith: r.conflictStayWith || "",
    });
  }

  rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  return (
    <div className={adminPoppins.variable}>
      <HealthnetRosterClient rows={rows} />
    </div>
  );
}
