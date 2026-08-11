"use client";

/**
 * The welcome board: today's parties, and where each one goes first.
 *
 * A guest walking in with eight kids does not want a schedule — they want to
 * see their own name and be told which building to walk to. So the board is a
 * marquee, not a table: a small number of large cards, first names only, and
 * exactly one instruction each.
 *
 * VIP PARTIES ALTERNATE WITH THE WELCOME PAGES (owner 2026-08-11: "welcome 1,
 * vip, welcome 2, vip" — "it shouldn't just take over everything"). The gold
 * VIP slide is one page of this rotation, appearing after every welcome page
 * while a party is inside its greeting window. Repeated prominence, no seizure.
 *
 * Pages turn on the shared clock, so two screens showing this board are on the
 * same page at the same moment and a reboot lands where it should.
 */
import { IconClock, IconUsersGroup, IconMapPin } from "@tabler/icons-react";
import { TV_W, type SignageVenue } from "../constants";
import { withAlpha } from "../color";
import { TV_PHOTOS } from "../assets";
import { TvBrandLogo } from "../components/TvBrandLogo";
import { isBowlingStep, vipCandidatesAt } from "../director/schedule";
import { VipShowcase } from "./SceneVipWelcome";
import type { WelcomeEntry } from "../types";
import type { SceneProps } from "../director/types";

const PAD_X = 96;
const PAD_Y = 54;
const PER_PAGE = 3;
/** How long one page holds before the next. */
const PAGE_MS = 12_000;

const CYAN = "#00e2e5";
const VIP_GOLD = "#d4af37";

/**
 * Backdrops rotate with the welcome pages so the board feels alive, and they
 * are ACTUALLY VISIBLE — the first version sat one photo at 22% opacity under
 * a heavy scrim and "you can barely see what shows" (owner 2026-08-11). The
 * scrim now protects only the left rail, where the type lives; the photo owns
 * the right, behind glass cards that carry their own contrast.
 */
/**
 * BOWLING FIRST, and no children (owner 2026-08-11: "don't like the picture of the
 * kid behind it, use something else bowling related").
 *
 * `TV_PHOTOS.kbf` was index 0, and index 0 is not one option of four — with three
 * or fewer parties there is a single page, `page` is pinned at 0, and the board
 * showed that one photo permanently. It was `birthday-girl-bowling.jpg`, a
 * birthday-marketing shot of a child, greeting corporate groups.
 */
const WELCOME_BACKDROPS = [TV_PHOTOS.bowl, TV_PHOTOS.arcade, TV_PHOTOS.gel];

/**
 * Which brand's mark belongs on this card, from the building label the server
 * sent (a VENUE_INFO label — "HeadPinz Fort Myers", "FastTrax Fort Myers").
 *
 * Matched on the brand word rather than an exact label, so a renamed or added
 * centre still resolves. Null when it is neither, which keeps the text pill as an
 * honest fallback instead of stamping the wrong logo on a party's card.
 */
function buildingVenue(building: string | null): SignageVenue | null {
  const b = (building ?? "").toLowerCase();
  if (b.includes("fasttrax")) return "FT";
  if (b.includes("headpinz")) return b.includes("naples") ? "HPN" : "HPFM";
  return null;
}

/** "HeadPinz", not "HeadPinz Fort Myers" — everyone standing in the lobby
 *  knows which town they are in (owner 2026-08-11). */
function localBuilding(building: string | null): string | null {
  if (!building) return null;
  return building.replace(/\s+(Fort Myers|Naples)\s*$/i, "");
}

export function SceneEventWelcome({ feed, nowMs, venue, config }: SceneProps) {
  const all = feed?.events ?? [];

  // VIP parties inside their greeting window join the rotation as gold pages.
  // With no events at all but VIPs known, the board is VIP wall to wall rather
  // than blank.
  const vipParties = vipCandidatesAt(nowMs, feed?.vip ?? null, config.vip, isBowlingStep).map(
    (c) => c.vip,
  );

  const welcomePages = Math.ceil(all.length / PER_PAGE);
  const interleaved = vipParties.length > 0;

  if (welcomePages === 0) {
    if (!interleaved) return null;
    return <VipShowcase parties={vipParties} />;
  }

  // welcome 1, VIP, welcome 2, VIP, … — the VIP slide after every welcome page.
  const totalPages = interleaved ? welcomePages * 2 : welcomePages;
  const seq = Math.floor(nowMs / PAGE_MS) % totalPages;
  if (interleaved && seq % 2 === 1) {
    return <VipShowcase parties={vipParties} />;
  }
  const page = interleaved ? Math.floor(seq / 2) : seq;
  const shown = all.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  const backdrop = WELCOME_BACKDROPS[page % WELCOME_BACKDROPS.length];

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      {/* The photo is content now, not a rumour of one. */}
      <div
        aria-hidden
        className="tv-kenburns"
        style={{
          position: "absolute",
          inset: "-6%",
          backgroundImage: `url(${backdrop})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          opacity: 0.55,
          filter: "saturate(0.85) brightness(0.75)",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(to right, #000418 20%, rgba(2,10,34,0.72) 46%, rgba(2,10,34,0.25) 75%, rgba(2,10,34,0.45) 100%)",
        }}
      />
      <div aria-hidden className="tv-sweep" style={{ position: "absolute", inset: 0 }} />

      <div
        style={{
          position: "absolute",
          inset: `${PAD_Y}px ${PAD_X}px`,
          display: "flex",
          gap: 64,
          alignItems: "center",
        }}
      >
        {/* Left: the greeting. It never changes, so it anchors the screen while
            the cards page underneath. */}
        <div style={{ width: 560, flexShrink: 0 }}>
          {/* The real mark, not the word (owner 2026-08-11: "use actual logos"). */}
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span className="tv-eyebrow" style={{ fontSize: 26 }}>
              Today at
            </span>
            <TvBrandLogo venue={venue} height={66} />
          </div>
          <div
            className="tv-display"
            style={{
              marginTop: 18,
              // 108px: sized to FIT the 560px rail. At 168px the word ran
              // ~730px and the overflow disappeared UNDER the first card's
              // opaque glass — the wall read "WELCO" (owner 2026-08-11).
              fontSize: 108,
              lineHeight: 1.02,
              whiteSpace: "nowrap",
              background: `linear-gradient(180deg, #f5ecee 52%, ${CYAN})`,
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            Welcome
          </div>
          {welcomePages > 1 && <PageDots count={welcomePages} active={page} />}
        </div>

        {/* Right: the parties. */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 22 }}>
          {shown.map((e, i) => (
            // Keyed by page so each page's cards replay their cascade.
            <PartyCard key={`${page}-${e.id}`} entry={e} index={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

function PartyCard({ entry, index }: { entry: WelcomeEntry; index: number }) {
  const accent = entry.isVip ? VIP_GOLD : CYAN;
  const building = localBuilding(entry.building);
  return (
    <div
      className="tv-glass tv-rise"
      style={{
        position: "relative",
        padding: "26px 34px",
        borderLeft: `8px solid ${accent}`,
        // Cascade in, one after another, so a page turn reads as arrival.
        animationDelay: `${index * 90}ms`,
        overflow: "hidden",
      }}
    >
      <div
        className="tv-display"
        style={{
          fontSize: 66,
          color: "#fff",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          textShadow: `0 0 40px ${withAlpha(accent, 0.45)}`,
        }}
      >
        {entry.title}
      </div>

      <div
        style={{
          marginTop: 12,
          display: "flex",
          alignItems: "center",
          gap: 30,
          fontSize: 34,
          color: "rgba(245,236,238,0.78)",
          flexWrap: "wrap",
        }}
      >
        {entry.startsAtLabel && (
          <Meta icon={<IconClock size={32} />} text={entry.startsAtLabel} numeric />
        )}
        {entry.guestCount != null && (
          <Meta icon={<IconUsersGroup size={32} />} text={`${entry.guestCount} guests`} />
        )}
        {entry.firstStopLabel && (
          <Meta icon={<IconMapPin size={32} color={accent} />} text={entry.firstStopLabel} />
        )}
      </div>

      {/* WHICH BUILDING TO WALK TO — as the venue's real mark rather than its name
          in caps (owner 2026-08-11: "headpinz on the tile is where I want real
          logo"). The pill is the one thing on a card a guest uses to navigate, so
          the logo earns its place here more than anywhere: it is recognised at a
          glance from across a lobby, where a word has to be read.

          Falls back to the text pill for a building whose brand we cannot resolve
          — HP Arena and the like are HeadPinz, but a future third brand would
          otherwise silently lose its label. */}
      {building &&
        (buildingVenue(entry.building) ? (
          <div
            style={{
              position: "absolute",
              right: 28,
              top: 24,
              display: "flex",
              alignItems: "center",
              padding: "10px 22px",
              borderRadius: 999,
              border: `2px solid ${withAlpha(accent, 0.55)}`,
              background: "rgba(0,0,0,0.22)",
              maxWidth: TV_W * 0.22,
            }}
          >
            <TvBrandLogo venue={buildingVenue(entry.building)!} height={44} />
          </div>
        ) : (
          <div
            style={{
              position: "absolute",
              right: 28,
              top: 28,
              padding: "8px 20px",
              borderRadius: 999,
              border: `2px solid ${withAlpha(accent, 0.55)}`,
              color: accent,
              fontSize: 26,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
              maxWidth: TV_W * 0.2,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {building}
          </div>
        ))}
    </div>
  );
}

function Meta({ icon, text, numeric }: { icon: React.ReactNode; text: string; numeric?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
      <span aria-hidden style={{ display: "inline-flex", opacity: 0.8 }}>
        {icon}
      </span>
      <span className={numeric ? "tv-num" : undefined}>{text}</span>
    </span>
  );
}

/** Which page of parties is up. Only rendered when there is more than one. */
function PageDots({ count, active }: { count: number; active: number }) {
  return (
    <div aria-hidden style={{ marginTop: 34, display: "flex", gap: 12 }}>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          style={{
            width: i === active ? 44 : 14,
            height: 14,
            borderRadius: 999,
            background: i === active ? CYAN : "rgba(245,236,238,0.25)",
            transition: "width 400ms ease, background 400ms ease",
          }}
        />
      ))}
    </div>
  );
}
