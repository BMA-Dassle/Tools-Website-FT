/**
 * SMS-Timing "best times" (Hall of Fame) catalog — the track/tier/class →
 * rscId/scgId matrix for the records API, lifted out of app/leaderboards/
 * page.tsx (2026-07-21) so the public leaderboards page and the kiosk Race
 * Info hub read ONE source of truth.
 *
 * Data flows through our proxy: GET /api/besttimes?endpoint=records&rscId=…
 * &scgId=…&startDate=…&maxResult=… (app/api/besttimes/route.ts — tenant
 * `headpinzftmyers`, token auto-renewed server-side). Records are per
 * track + tier + class; there is no FT-vs-HPFM split (one karting facility).
 */

export type BestTimeRecord = {
  position: number;
  participant: string;
  score: string;
  date: string;
};

export type RecordCategory = {
  label: string;
  color: string;
  border: string;
  rscId: string;
  scgId: string;
};

export type RecordTrackKey = "blue" | "red" | "mega";

export type RecordTrackConfig = {
  key: RecordTrackKey;
  label: string;
  accent: string;
  adult: RecordCategory[];
  junior: RecordCategory[];
};

export const RECORD_TRACKS: RecordTrackConfig[] = [
  {
    key: "blue",
    label: "Blue Track",
    accent: "rgb(0,74,173)",
    adult: [
      {
        label: "Starter",
        color: "rgb(228,28,29)",
        border: "rgba(228,28,29,0.59)",
        rscId: "11208654",
        scgId: "11207805",
      },
      {
        label: "Intermediate",
        color: "rgb(0,74,173)",
        border: "rgba(0,74,173,0.59)",
        rscId: "11208654",
        scgId: "11207803",
      },
      {
        label: "Pro",
        color: "rgb(134,82,255)",
        border: "rgba(134,82,255,0.59)",
        rscId: "11208654",
        scgId: "11207807",
      },
    ],
    junior: [
      {
        label: "Junior Starter",
        color: "rgb(228,28,29)",
        border: "rgba(228,28,29,0.59)",
        rscId: "11208654",
        scgId: "11936433",
      },
      {
        label: "Junior Intermediate",
        color: "rgb(0,74,173)",
        border: "rgba(0,74,173,0.59)",
        rscId: "11208654",
        scgId: "12755221",
      },
      {
        label: "Junior Pro",
        color: "rgb(134,82,255)",
        border: "rgba(134,82,255,0.59)",
        rscId: "11208654",
        scgId: "15175252",
      },
    ],
  },
  {
    key: "red",
    label: "Red Track",
    accent: "rgb(228,28,29)",
    adult: [
      {
        label: "Starter",
        color: "rgb(228,28,29)",
        border: "rgba(228,28,29,0.59)",
        rscId: "11208660",
        scgId: "12113911",
      },
      {
        label: "Intermediate",
        color: "rgb(0,74,173)",
        border: "rgba(0,74,173,0.59)",
        rscId: "11208660",
        scgId: "11207809",
      },
      {
        label: "Pro",
        color: "rgb(134,82,255)",
        border: "rgba(134,82,255,0.59)",
        rscId: "11208660",
        scgId: "11207813",
      },
    ],
    junior: [
      {
        label: "Junior",
        color: "rgb(228,28,29)",
        border: "rgba(228,28,29,0.59)",
        rscId: "11208660",
        scgId: "11207811",
      },
    ],
  },
  {
    key: "mega",
    label: "Mega Track",
    accent: "rgb(134,82,255)",
    adult: [
      {
        label: "Starter",
        color: "rgb(228,28,29)",
        border: "rgba(228,28,29,0.59)",
        rscId: "-1",
        scgId: "11207799",
      },
      {
        label: "Intermediate",
        color: "rgb(0,74,173)",
        border: "rgba(0,74,173,0.59)",
        rscId: "-1",
        scgId: "11207797",
      },
      {
        label: "Pro",
        color: "rgb(134,82,255)",
        border: "rgba(134,82,255,0.59)",
        rscId: "-1",
        scgId: "11207801",
      },
    ],
    junior: [
      {
        label: "Junior Intermediate",
        color: "rgb(0,74,173)",
        border: "rgba(0,74,173,0.59)",
        rscId: "-1",
        scgId: "16924035",
      },
      {
        label: "Junior Pro",
        color: "rgb(134,82,255)",
        border: "rgba(134,82,255,0.59)",
        rscId: "-1",
        scgId: "16924037",
      },
    ],
  },
];

export type RecordTimeRange = "month" | "year" | "alltime";

function estNow(): { year: string; month: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return { year: get("year"), month: get("month") };
}

/** SMS-Timing `startDate` param for a time-range filter (center-local). */
export function recordsStartDate(range: RecordTimeRange): string {
  const { year, month } = estNow();
  if (range === "month") return `${year}-${month}-1 06:00:00`;
  if (range === "year") return `${year}-1-1 06:00:00`;
  return "2024-1-1 06:00:00";
}

export function formatRecordDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "1:02.212" (Mega) passes through; plain seconds render as "33.104s". */
export function formatRecordTime(score: string): string {
  if (score.includes(":")) return score;
  const secs = parseFloat(score);
  if (secs >= 60) {
    const mins = Math.floor(secs / 60);
    const rem = (secs % 60).toFixed(3);
    return `${mins}:${rem.padStart(6, "0")}`;
  }
  return `${secs.toFixed(3)}s`;
}
