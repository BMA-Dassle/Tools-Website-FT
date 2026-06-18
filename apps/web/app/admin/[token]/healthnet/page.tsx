import { notFound } from "next/navigation";
import redis from "@/lib/redis";
import { detectConflicts, conflictAdminLabel } from "@/lib/healthnet-conflicts";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";
import HealthnetRosterClient, { type RosterRow } from "./HealthnetRosterClient";

const RESOLUTION_LABELS: Record<string, string> = {
  "earlier-race": "wants earlier race",
  "later-race": "wants later race",
  "later-activity": "wants gel/laser later",
  "earlier-activity": "wants gel/laser earlier",
  "adjust-race": "adjust race",
  "adjust-activity": "adjust gel/laser",
  keep: "keep as-is",
};

/**
 * Admin: Health Net Team Day roster — everyone's name, scheduled times, and
 * who has completed check-in (the "almost here" confirm flow).
 *
 * Token-gated by ADMIN_CAMERA_TOKEN — same key as the other front-desk admin
 * tools. Reads RSVP records straight from Redis.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/healthnet
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

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

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

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

  return <HealthnetRosterClient rows={rows} />;
}
