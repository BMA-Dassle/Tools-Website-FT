/**
 * Racing marketing/info content — race-type qualification cards, kart-class
 * requirements, and track-layout facts. Lifted out of app/racing/page.tsx
 * (2026-07-21) so the public /racing page and the kiosk Race Info hub render
 * ONE source of truth instead of drifting copies.
 *
 * Qualifying lap-time COPY lives here; the canonical per-tier qualifying
 * strings used by booking + emails stay in app/book/race/data.ts
 * (TIER_QUALIFYING / TIER_DESCRIPTIONS) — update both when times change.
 */

export interface RaceTypeCard {
  title: string;
  /** Card accent (matches the /racing page palette). */
  color: string;
  border: string;
  age: string;
  qual: string;
  desc: string;
  note?: string;
}

export const RACE_TYPE_CARDS: RaceTypeCard[] = [
  {
    title: "Adult Starter",
    color: "rgb(228,28,29)",
    border: "rgba(228,28,29,0.59)",
    age: "13+ / 59”+",
    qual: "None — all racers start here",
    desc: "Fun meets friendly competition. Perfect for families, casual drivers, and first-timers.",
  },
  {
    title: "Adult Intermediate",
    color: "rgb(0,74,173)",
    border: "rgba(0,74,173,0.59)",
    age: "13+ / 59”+",
    qual: "Lap time of 41s (Blue), 46s (Red), or 1:28 (Mega) in Starter",
    desc: "For serious drivers. High-speed karts, competitive lap tracking, challenging layout.",
  },
  {
    title: "Adult Pro",
    color: "rgb(134,82,255)",
    border: "rgba(134,82,255,0.59)",
    age: "13+ / 59”+",
    qual: "Lap time of 32.5s (Blue), 37s (Red), or 1:08.5 (Mega) in Intermediate",
    desc: "Ultimate test of skill and speed. Fastest karts, precision timing, most demanding config.",
  },
  {
    title: "Junior Starter",
    color: "rgb(228,28,29)",
    border: "rgba(228,28,29,0.59)",
    age: "7–13 / 49”–70”",
    qual: "None — all juniors start here",
    desc: "Speed-controlled karts, easy track layout, team supervision.",
    note: "Not available on Mega Track Tuesdays",
  },
  {
    title: "Junior Intermediate",
    color: "rgb(0,74,173)",
    border: "rgba(0,74,173,0.59)",
    age: "7–13 / 49”–70”",
    qual: "Lap time of 1:15 in Junior Starter",
    desc: "Faster karts, more challenging layout, real competition.",
  },
  {
    title: "Junior Pro",
    color: "rgb(134,82,255)",
    border: "rgba(134,82,255,0.59)",
    age: "7–13 / 49”–70”",
    qual: "Lap time of 45s in Junior Intermediate",
    desc: "Fastest junior karts, precision timing, most demanding config.",
  },
];

export interface KartClassCard {
  title: string;
  color: string;
  border: string;
  items: { label: string; value: string }[];
}

export const KART_CLASS_CARDS: KartClassCard[] = [
  {
    title: "Adult Karts",
    color: "rgb(228,28,29)",
    border: "rgba(228,28,29,0.59)",
    items: [
      { label: "Ages", value: "13+" },
      { label: "Min Height", value: "59” (4’9”)" },
    ],
  },
  {
    title: "Junior Karts",
    color: "rgb(0,74,173)",
    border: "rgba(0,74,173,0.59)",
    items: [
      { label: "Ages", value: "7–13" },
      { label: "Height", value: "49” to 70”" },
      { label: "Track", value: "Blue Track only" },
      {
        label: "Note",
        value: "First-time Junior races not available on Mega Track Tuesdays",
      },
    ],
  },
  {
    title: "Mini Karts",
    color: "rgb(134,82,255)",
    border: "rgba(134,82,255,0.59)",
    items: [
      { label: "Ages", value: "4–6" },
      { label: "Height", value: "No minimum" },
      { label: "Hours", value: "Close at 10:00 PM daily" },
    ],
  },
];

export interface TrackLayoutInfo {
  key: "blue" | "red" | "mega";
  name: string;
  color: string;
  lengthFt: number;
  blurb: string;
  /** Animated layout diagram (Vercel Blob — same asset the /racing page shows). */
  gif: string;
  warning?: string;
}

const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

export const TRACK_LAYOUTS: TrackLayoutInfo[] = [
  {
    key: "blue",
    name: "The Blue Track",
    color: "rgb(0,74,173)",
    lengthFt: 1095,
    blurb: "Technical & Clockwise.",
    gif: `${BLOB}/images/tracks/track-layout-1.gif`,
  },
  {
    key: "red",
    name: "The Red Track",
    color: "rgb(228,28,29)",
    lengthFt: 1013,
    blurb: "High-speed & Counter-clockwise.",
    gif: `${BLOB}/images/tracks/track-layout-1.gif`,
  },
  {
    key: "mega",
    name: "The Mega Track",
    color: "rgb(134,82,255)",
    lengthFt: 2108,
    blurb: "Tuesdays Only: Florida's longest multi-level track.",
    gif: `${BLOB}/images/tracks/mega-track-layout.gif`,
    warning:
      "Junior Notice: First-time Juniors cannot race the Mega Track. You must qualify on a split-track day first.",
  },
];

/** EcoVolt GT kart facts — from the /racing partnerships section. */
export const KART_SPECS = {
  model: "Biz-Karts EcoVolt GT",
  motor: "10.5 kW brushless electric motors with instant torque",
  safety: "Smart crash detection that only slows karts within 75ft of a wreck",
  structure: "360Karting multi-level circuit — Florida's longest indoor track",
} as const;
