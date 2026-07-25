"use client";

/**
 * /kiosk/race-info — the view-only Race Info hub (owner 2026-07-21).
 *
 * Tile landing (the kiosk CategoryCard language: full-bleed photo, eyebrow,
 * k-display title, accent bar) → four sub-screens, each with a back button:
 *
 *   Upcoming Races — live race status + today's availability grid
 *   Race Records   — SMS-Timing Hall of Fame fastest laps
 *   Race Types     — Starter / Intermediate / Pro qualification ladder
 *   The Tracks     — Blue / Red / Mega layouts + kart classes
 *
 * Nothing here books: the Book Now bar exits into the kiosk booking flow
 * (/kiosk/flow — the same destination as the attract screen's start()).
 * Racing is Fort-Myers-only; Naples kiosks never show the entry button, and
 * this screen renders a redirect notice if reached anyway.
 *
 * Authored to the fixed 1080×1920 kiosk canvas (px, not vh) inside the
 * KioskShell stage, like every kiosk-native screen.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { IconChevronLeft, IconFlag } from "@tabler/icons-react";
import { useKioskConfig } from "../../KioskConfigContext";
import { KIOSK_PHOTOS } from "../../assets";
import { clarityEvent, clarityTag } from "~/lib/clarity";
import { CategoryCard } from "../KioskCategories";
import { IdleWatcher } from "../IdleWatcher";
import { UpcomingRaces } from "./UpcomingRaces";
import { RaceRecords } from "./RaceRecords";
import { RaceTypes } from "./RaceTypes";
import { TheTracks } from "./TheTracks";
import { useT, type MessageKey } from "../../i18n";

type View = "tiles" | "upcoming" | "records" | "types" | "tracks";

const VIEW_TITLE_KEYS: Record<Exclude<View, "tiles">, MessageKey> = {
  upcoming: "raceInfo.title.upcoming",
  records: "raceInfo.title.records",
  types: "raceInfo.title.types",
  tracks: "raceInfo.title.tracks",
};

// Info screens hold no vendor state, so an abandoned one just returns to the
// attract loop. Longer than the booking flow's between-step patience — guests
// stand and read this screen.
const IDLE_TIMEOUT_MS = 120_000;

export function RaceInfoScreen() {
  const router = useRouter();
  const { config } = useKioskConfig();
  const t = useT();
  const [view, setView] = useState<View>("tiles");

  // Optional ?view=upcoming|records|types|tracks deep link — staff/testing
  // convenience (the page is already typed-URL-only while the flag is off).
  // Applied AFTER mount so SSR + first client render agree ("tiles") — reading
  // window.location in the initializer was a hydration mismatch.
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("view");
    if (v === "upcoming" || v === "records" || v === "types" || v === "tracks") setView(v);
  }, []);

  // Defensive gate — the attract button is already Fort-Myers-only. A missing
  // config (typed URL on a fresh browser) is allowed for staff testing.
  if (config && config.center !== "fort-myers") {
    return (
      <div className="k-flow items-center justify-center gap-[40px] px-[64px] text-center">
        <div className="k-display text-[64px]">{t("raceInfo.naples.title")}</div>
        <div className="text-[30px] text-white/60">{t("raceInfo.naples.body")}</div>
        <button
          type="button"
          className="k-btn-ghost k-tap"
          onClick={() => router.replace("/kiosk")}
        >
          {t("raceInfo.backToStart")}
        </button>
      </div>
    );
  }

  const open = (next: Exclude<View, "tiles">) => {
    clarityEvent(`kiosk:raceinfo:${next}`);
    setView(next);
  };

  const back = () => {
    if (view === "tiles") router.replace("/kiosk");
    else setView("tiles");
  };

  const bookNow = () => {
    clarityTag("kiosk_entry", "raceinfo");
    clarityEvent("kiosk:raceinfo:book");
    router.push("/kiosk/flow");
  };

  return (
    <div className="k-flow">
      <IdleWatcher
        timeoutMs={IDLE_TIMEOUT_MS}
        paused={false}
        onReset={() => router.replace("/kiosk")}
      />

      {/* Header — back + eyebrow + section title */}
      <div className="k-flow-head pb-[8px]">
        <div className="flex items-center gap-[28px]">
          <button
            type="button"
            aria-label={
              view === "tiles" ? t("raceInfo.backToStart") : t("raceInfo.aria.backToRaceInfo")
            }
            onClick={back}
            className="k-tap flex h-[96px] w-[96px] shrink-0 items-center justify-center rounded-[24px] border-2 border-white/15 bg-white/5 text-white/80"
          >
            <IconChevronLeft size={52} aria-hidden="true" />
          </button>
          <div>
            <div className="k-eyebrow">
              <span className="text-[#e53935]">{t("raceInfo.eyebrow.karting")}</span>
              <span className="text-white/40"> · Fort Myers</span>
            </div>
            <div className="k-display mt-[10px] text-[74px]">
              {view === "tiles" ? t("raceInfo.title.hub") : t(VIEW_TITLE_KEYS[view])}
            </div>
          </div>
        </div>
      </div>

      {view === "tiles" ? (
        <>
          {/* Tile landing — the category-chooser card language. */}
          <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-[24px] px-[64px] pt-[24px]">
            <div className="relative flex min-h-0 flex-col">
              <CategoryCard
                photo={KIOSK_PHOTOS.race}
                eyebrow={t("raceInfo.card.upcoming.eyebrow")}
                accent="#e53935"
                title={t("raceInfo.title.upcoming")}
                blurb={t("raceInfo.card.upcoming.blurb")}
                onClick={() => open("upcoming")}
              />
            </div>
            <div className="relative flex min-h-0 flex-col">
              <CategoryCard
                photo={KIOSK_PHOTOS.flag}
                eyebrow={t("raceInfo.card.records.eyebrow")}
                accent="#e8b14c"
                title={t("raceInfo.title.records")}
                blurb={t("raceInfo.card.records.blurb")}
                onClick={() => open("records")}
              />
            </div>
            <div className="relative flex min-h-0 flex-col">
              <CategoryCard
                photo={KIOSK_PHOTOS.raceAction}
                eyebrow={t("raceInfo.card.types.eyebrow")}
                accent="#00e2e5"
                title={t("raceInfo.title.types")}
                blurb={t("raceInfo.card.types.blurb")}
                onClick={() => open("types")}
              />
            </div>
            <div className="relative flex min-h-0 flex-col">
              <CategoryCard
                photo={KIOSK_PHOTOS.redTrack}
                eyebrow={t("raceInfo.card.tracks.eyebrow")}
                accent="#8652ff"
                title={t("raceInfo.title.tracks")}
                blurb={t("raceInfo.card.tracks.blurb")}
                onClick={() => open("tracks")}
              />
            </div>
          </div>

          {/* Book Now — the attract screen's primary-CTA language. */}
          <div className="k-z-actions pt-[28px]">
            <button type="button" onClick={bookNow} className="k-btn-primary k-tap kiosk-pulse">
              <IconFlag size={44} aria-hidden="true" />
              {t("raceInfo.bookNow")}
            </button>
          </div>
          <div className="flex h-[96px] shrink-0 items-center justify-center">
            <span className="k-eyebrow text-white/35">{t("raceInfo.footer.tagline")}</span>
          </div>
        </>
      ) : (
        <div className="k-flow-body kiosk-scroll">
          {view === "upcoming" && <UpcomingRaces />}
          {view === "records" && <RaceRecords />}
          {view === "types" && <RaceTypes />}
          {view === "tracks" && <TheTracks />}
        </div>
      )}
    </div>
  );
}
