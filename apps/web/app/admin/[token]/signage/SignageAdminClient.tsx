"use client";

/**
 * Screen management.
 *
 * The whole point of this page: hanging a new TV, or changing what an existing
 * one shows, must be a form — never a deploy. So everything the platform can
 * vary per screen is exposed here as a checkbox or a number, and a saved change
 * reaches the wall on its next 10-second poll with no reboot.
 *
 * Deliberately plain. It is a staff tool used a handful of times a year; the
 * beautiful surface is the TV itself.
 */
import { useCallback, useEffect, useState } from "react";
import { ADMIN_SANS, PORTAL_BLUE, PORTAL_DARK } from "~/components/features/admin-skin/theme";
import { publicOrigin } from "~/lib/helpers/public-origin";
import {
  SIGNAGE_VENUES,
  VENUE_INFO,
  TEST_SCREEN_NUMBER,
  TV_MAX_OVERSCAN_PCT,
  type SignageVenue,
} from "~/features/signage/constants";
import {
  ROLE_PRESETS,
  rolePreset,
  resolveScreenConfig,
  type ScreenRole,
} from "~/features/signage/defaults";
import {
  startupInstructions,
  startupScriptFileName,
  dualStartupScriptFileName,
  dualStartupInstructions,
} from "~/features/signage/startup-script";
import { resolvePair } from "~/features/signage/pairing";
import type { ScreenConfig, SignageScreen } from "~/features/signage/types";
import BriefingAssetManager, { type BriefingAssetState } from "./BriefingAssetManager";

/** The build THIS admin page was served from, for comparing against a screen. */
const CURRENT_BUILD = (process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 8);

interface LoadState {
  screens: SignageScreen[];
  seen: Record<string, { at: string; build: string | null } | null>;
}

/** One camera in the picker, from GET /api/admin/signage/cameras. */
interface CameraOption {
  id: string;
  name: string;
  group: string | null;
  status: string | null;
}
type CameraLoad = { list: CameraOption[]; configured: boolean } | null;

/** Track resource ids, so the Blue/Red screens can be scoped by picking a name
 *  rather than by typing an id nobody remembers. */
const TRACK_OPTIONS: { label: string; resourceId: string }[] = [
  { label: "Blue Track", resourceId: "11208654" },
  { label: "Red Track", resourceId: "11208660" },
  { label: "Mega Track", resourceId: "-1" },
];

export default function SignageAdminClient({ token }: { token: string }) {
  const [data, setData] = useState<LoadState>({ screens: [], seen: {} });
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [loadedAt, setLoadedAt] = useState(0);
  const [assets, setAssets] = useState<BriefingAssetState | null>(null);
  const [cameras, setCameras] = useState<CameraLoad>(null);

  /** The camera list for the picker. Its own endpoint, and loaded LAZILY — only
   *  when the form opens — because it calls out to Nx (a second or two) and most
   *  visits to this page never touch a camera board. */
  const loadCameras = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/signage/cameras?token=${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setCameras({ list: [], configured: false });
        return;
      }
      const json = (await res.json()) as { cameras?: CameraOption[]; configured?: boolean };
      setCameras({ list: json.cameras ?? [], configured: json.configured ?? false });
    } catch {
      setCameras({ list: [], configured: false });
    }
  }, [token]);

  /** Which briefing films are uploaded. Its own endpoint because the briefing
   *  rooms are their own subsystem — this page only needs the file list. */
  const loadAssets = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/briefing?token=${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as BriefingAssetState;
      setAssets({
        videos: json.videos,
        helmetPosterUrl: json.helmetPosterUrl,
        welcomeBackAudioUrl: json.welcomeBackAudioUrl ?? null,
      });
    } catch {
      /* the section simply shows "not uploaded" */
    }
  }, [token]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/signage?token=${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      if (res.ok) setData((await res.json()) as LoadState);
      // One clock read per load, passed down — so a row's "online" dot is not
      // an impure Date.now() call during render.
      setLoadedAt(Date.now());
      // Piggy-backed on the same refresh rather than a second effect: the file
      // list and the screen list are both "what does this page show", and one
      // poller is one thing to reason about.
      await loadAssets();
    } finally {
      setLoading(false);
    }
  }, [token, loadAssets]);

  useEffect(() => {
    void load();
    // Keep the online dots honest without a manual refresh.
    const iv = setInterval(() => void load(), 30_000);
    return () => clearInterval(iv);
  }, [load]);

  /** Open the form, and pull the camera list the first time — lazily, from the
   *  click rather than an effect, so a page view that never edits a screen never
   *  calls out to Nx. */
  const openForm = useCallback(
    (draft: Draft) => {
      setEditing(draft);
      if (!cameras) void loadCameras();
    },
    [cameras, loadCameras],
  );

  /**
   * Every action says what happened.
   *
   * Previously only failures spoke, so a working button and a dead one looked
   * identical — press Preview VIP, see nothing on the page and nothing on a
   * stale screen, and conclude the feature is broken (owner 2026-08-11: "I get
   * no feedback on admin page that it was triggered either"). Silence is the
   * worst possible answer from a tool used to diagnose screens.
   */
  const post = useCallback(
    async (body: Record<string, unknown>, successNote?: string) => {
      setBusy(true);
      setNote(null);
      try {
        const res = await fetch(`/api/admin/signage?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) {
          setNote(`✕ ${json.error ?? `Failed (${res.status})`}`);
          return false;
        }
        if (successNote) setNote(`✓ ${successNote}`);
        return true;
      } catch (err) {
        setNote(`✕ Could not reach the server${err instanceof Error ? ` — ${err.message}` : ""}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [token],
  );

  const save = async () => {
    if (!editing) return;
    const ok = await post({
      action: "save",
      venue: editing.venue,
      screenNumber: editing.screenNumber,
      name: editing.name,
      config: draftToConfig(editing),
    });
    if (ok) {
      setEditing(null);
      await load();
    }
  };

  const remove = async (screenId: string) => {
    // Deleting stops us managing the screen; it does not turn the TV off. Say
    // so, because "delete" on a wall-mounted device reads as "switch it off".
    if (!window.confirm(`Stop managing ${screenId}? The TV keeps running until it is unplugged.`))
      return;
    if (await post({ action: "delete", screenId })) await load();
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: PORTAL_DARK.bodyGradient,
        color: PORTAL_DARK.fg,
        fontFamily: ADMIN_SANS,
        padding: 24,
      }}
    >
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: "1.6rem", fontWeight: 700, margin: 0 }}>Lobby TVs</h1>
        <p style={{ color: PORTAL_DARK.muted, fontSize: 14, marginTop: 6 }}>
          Create a screen, tick what it shows, then open its URL on the player. Changes reach a
          screen within about ten seconds — no restart.
        </p>
      </header>

      {note && (
        <div
          role="status"
          style={{
            marginBottom: 16,
            padding: "10px 14px",
            borderRadius: 8,
            border: `1px solid ${PORTAL_DARK.border}`,
            background: PORTAL_DARK.card,
            fontSize: 14,
          }}
        >
          {note}
        </div>
      )}

      {!editing && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => openForm(newDraft())}
            style={primaryBtn}
            disabled={busy}
          >
            Add a screen
          </button>
          {Array.from(new Set(data.screens.map((s) => s.center))).map((center) => (
            <button
              key={center}
              type="button"
              onClick={async () => {
                if (await post({ action: "reload-screens", center })) {
                  setNote(`Reload sent — screens at ${center} refresh within about 10 seconds.`);
                }
              }}
              style={btn}
              disabled={busy}
              title="Force every screen at this center to reload now"
            >
              Reload {center} screens
            </button>
          ))}
        </div>
      )}

      {editing && (
        <ScreenForm
          draft={editing}
          onChange={setEditing}
          onSave={save}
          onCancel={() => setEditing(null)}
          busy={busy}
          cameras={cameras}
        />
      )}

      <section style={{ marginTop: 28 }}>
        {loading ? (
          <p style={{ color: PORTAL_DARK.muted }}>Loading…</p>
        ) : data.screens.length === 0 ? (
          <p style={{ color: PORTAL_DARK.muted }}>
            No screens yet. The first one is usually the TV above the kiosk bank.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {data.screens.map((s) => (
              <ScreenRow
                key={s.screenId}
                screen={s}
                // Resolved here rather than in the row: the row only knows its
                // own screen, and a pair is a fact about the whole list.
                pairedWith={pairSidesFor(data.screens, s.screenId)}
                token={token}
                heartbeat={data.seen[s.screenId] ?? null}
                nowMs={loadedAt}
                onEdit={() => openForm(draftFromScreen(s))}
                onDelete={() => remove(s.screenId)}
                onTest={() =>
                  post(
                    { action: "test-celebration", center: s.center },
                    `Celebration sent to ${s.center} — watch the screen.`,
                  )
                }
                onSimulate={(action, extra, label) =>
                  post({ action, center: s.center, firstName: "Marcus", ...extra }, label)
                }
                onSimulateScan={(track, opts, label) =>
                  post(
                    {
                      action: "simulate-scan",
                      center: s.center,
                      track,
                      firstName: "Marcus",
                      ...opts,
                    },
                    label,
                  )
                }
                busy={busy}
              />
            ))}
          </div>
        )}
      </section>

      <BriefingAssetManager token={token} assets={assets} onChanged={() => void loadAssets()} />
    </div>
  );
}

/* ── row ──────────────────────────────────────────────────────────────── */

/** The two screen ids of this screen's pairing group, left first, or null. */
function pairSidesFor(
  screens: SignageScreen[],
  screenId: string,
): { leftId: string; rightId: string } | null {
  const pair = resolvePair(screens, screenId);
  return pair ? { leftId: pair.left.screenId, rightId: pair.right.screenId } : null;
}

function ScreenRow({
  screen,
  pairedWith,
  token,
  heartbeat,
  nowMs,
  onEdit,
  onDelete,
  onTest,
  onSimulateScan,
  onSimulate,
  busy,
}: {
  screen: SignageScreen;
  /** Set only when this screen is half of a two-screen pairing group. */
  pairedWith: { leftId: string; rightId: string } | null;
  token: string;
  heartbeat: { at: string; build: string | null } | null;
  /** Clock read once per load by the parent — never Date.now() during render. */
  nowMs: number;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onSimulateScan: (
    track: string,
    opts: { vip?: boolean; birthday?: boolean },
    label?: string,
  ) => void;
  onSimulate: (action: string, extra?: Record<string, unknown>, label?: string) => void;
  busy: boolean;
}) {
  const [showSetup, setShowSetup] = useState(false);
  const [showTests, setShowTests] = useState(false);

  // Only offer tests this screen can actually act on. Pressing "Preview
  // welcome" on a board whose playlist is race-checkin only did nothing at all
  // — the welcome board is a rotation scene, so a screen that does not list it
  // can never show it — and a button that silently does nothing reads as a
  // broken feature (owner 2026-08-11).
  const resolved = resolveScreenConfig(screen.config, screen.venue as SignageVenue);
  const canRaceCheckin = resolved.playlist.some((p) => p.scene === "race-checkin");
  const canWelcome = resolved.playlist.some((p) => p.scene === "event-welcome");

  // VIP is welcome-board content now (not an interrupt), so previewing it only
  // makes sense where the welcome board runs — and only if VIP pages are on.
  const canVip = canWelcome && resolved.vip.enabled;
  const canCelebrate = resolved.celebration.enabled;
  const canBriefing = resolved.playlist.some((p) => p.scene === "briefing");
  const canResults = resolved.playlist.some((p) => p.scene === "race-results");
  const canGuide = resolved.playlist.some((p) => p.scene === "race-guide");
  const online = heartbeat ? nowMs - Date.parse(heartbeat.at) < 60_000 : false;
  const scopedTrack = screen.config.scope?.resourceIds?.[0];
  const trackName =
    TRACK_OPTIONS.find((t) => t.resourceId === scopedTrack)
      ?.label.split(" ")[0]
      .toLowerCase() ?? "blue";
  // publicOrigin: this URL gets copied into TV player configs. Copied from
  // the auth-walled admin proxy domain, location.origin would brick the
  // board (a wall player has no Vercel Auth session).
  const url = `${publicOrigin(typeof window !== "undefined" ? window.location.origin : "")}/tv?screen=${encodeURIComponent(screen.screenId)}`;
  const scenes = (screen.config.playlist ?? []).map((p) => p.scene);

  return (
    <div
      style={{
        border: `1px solid ${PORTAL_DARK.border}`,
        background: PORTAL_DARK.card,
        borderRadius: 10,
        padding: 16,
        display: "flex",
        gap: 16,
        alignItems: "flex-start",
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: "1 1 320px", minWidth: 280 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            aria-hidden
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: online ? "#46d68c" : PORTAL_DARK.muted,
              boxShadow: online ? "0 0 10px #46d68c" : "none",
            }}
          />
          <strong style={{ fontSize: 16 }}>{screen.name || "Unnamed screen"}</strong>
          <code style={{ fontSize: 12, color: PORTAL_DARK.muted }}>{screen.screenId}</code>
          {screen.screenNumber === TEST_SCREEN_NUMBER && <span style={pill}>test</span>}
        </div>
        <p style={{ color: PORTAL_DARK.muted, fontSize: 13, margin: "8px 0 0" }}>
          {VENUE_INFO[screen.venue as SignageVenue]?.label ?? screen.venue} ·{" "}
          {online
            ? "online now"
            : heartbeat
              ? `last seen ${timeAgo(heartbeat.at, nowMs)}`
              : "never seen"}
          {heartbeat?.build ? ` · build ${heartbeat.build}` : ""}
        </p>
        <p style={{ color: PORTAL_DARK.muted, fontSize: 13, margin: "4px 0 0" }}>
          Shows: {scenes.length ? scenes.join(", ") : "ads"}
        </p>
        {resolved.overscanPct > 0 && (
          // Say it on the row, not only inside the form. A fitting correction is
          // invisible by design once it is right, and an undocumented one gets
          // "fixed" by the next person who wonders why this wall is letterboxed.
          <p style={{ color: PORTAL_DARK.muted, fontSize: 13, margin: "4px 0 0" }}>
            Picture pulled in {resolved.overscanPct}% per edge (this panel overscans)
          </p>
        )}
        {heartbeat?.build && heartbeat.build !== CURRENT_BUILD && (
          <p
            style={{
              margin: "8px 0 0",
              fontSize: 13,
              color: "#f0b341",
              fontWeight: 600,
            }}
          >
            ⚠ This screen is running an older build ({heartbeat.build}, page is {CURRENT_BUILD}).
            Buttons here may do nothing until it reloads — press Reload screens, or restart the
            player.
          </p>
        )}
        <code
          style={{
            display: "block",
            marginTop: 10,
            fontSize: 12,
            color: PORTAL_BLUE,
            wordBreak: "break-all",
          }}
        >
          {url}
        </code>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(url)} style={btn}>
          Copy URL
        </button>
        <a
          href={`/api/admin/signage?token=${encodeURIComponent(token)}&script=${encodeURIComponent(screen.screenId)}`}
          style={{ ...btn, textDecoration: "none", display: "inline-block" }}
          download={startupScriptFileName(screen.screenId)}
        >
          Download startup script
        </a>
        {/* Only offered where it can actually work. A two-monitor launcher needs
            a PAIRING GROUP to know which screen belongs on which side, so the
            button follows the group rather than asking the person setting up a
            wall to remember the pairing. */}
        {pairedWith && (
          <a
            href={`/api/admin/signage?token=${encodeURIComponent(token)}&dual=${encodeURIComponent(screen.screenId)}`}
            style={{ ...btn, textDecoration: "none", display: "inline-block" }}
            download={dualStartupScriptFileName(pairedWith.leftId, pairedWith.rightId)}
            title={`One player PC driving two monitors: ${pairedWith.leftId} on the left, ${pairedWith.rightId} on the right`}
          >
            Download 2-monitor script
          </a>
        )}
        <button type="button" onClick={() => setShowSetup((v) => !v)} style={btn}>
          {showSetup ? "Hide setup" : "Setup steps"}
        </button>
        <button type="button" onClick={() => setShowTests((v) => !v)} style={btn} disabled={busy}>
          {showTests ? "Hide testing" : "Testing"}
        </button>
        <button type="button" onClick={onEdit} style={btn} disabled={busy}>
          Edit
        </button>
        <button type="button" onClick={onDelete} style={dangerBtn} disabled={busy}>
          Remove
        </button>
      </div>

      {showTests && (
        <div
          style={{
            flexBasis: "100%",
            marginTop: 4,
            padding: 16,
            borderRadius: 8,
            background: "rgba(0,0,0,0.25)",
            border: `1px solid ${PORTAL_DARK.border}`,
          }}
        >
          <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 600 }}>Testing</p>
          <p style={{ ...hint, margin: "0 0 12px" }}>
            Simulations publish to the same rail a real guest does, so what you see here is what
            will happen for real. Previews land on the screen itself and clear themselves after 90
            seconds.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {canCelebrate && (
              <button type="button" onClick={onTest} style={btn} disabled={busy}>
                Fire test celebration
              </button>
            )}
            {canRaceCheckin && (
              <button
                type="button"
                onClick={() =>
                  onSimulateScan(trackName, {}, `Scan sent on ${trackName} — Marcus should appear.`)
                }
                style={btn}
                disabled={busy}
                title="Publishes a racer-scanned event on the real rail"
              >
                Simulate scan
              </button>
            )}
            {canRaceCheckin && (
              <button
                type="button"
                onClick={() =>
                  onSimulateScan(
                    trackName,
                    { birthday: true },
                    "Birthday sent — BOTH karting boards take over.",
                  )
                }
                style={{ ...btn, borderColor: "#ec4899", color: "#ec4899" }}
                disabled={busy}
                title="Fires the full birthday takeover on BOTH karting boards"
              >
                Simulate birthday
              </button>
            )}
            {canRaceCheckin && (
              <button
                type="button"
                onClick={() =>
                  onSimulate("simulate-wrong-race", { track: trackName }, "Wrong-race notice sent.")
                }
                style={{ ...btn, borderColor: "#f0b341", color: "#f0b341" }}
                disabled={busy}
                title="Somebody scanned for a heat that is not the one checking in"
              >
                Simulate wrong race
              </button>
            )}
            {canRaceCheckin && (
              <button
                type="button"
                onClick={() =>
                  onSimulate(
                    "preview",
                    { screenId: screen.screenId, mode: "race" },
                    `Session preview pushed to ${screen.screenId} for 90s.`,
                  )
                }
                style={btn}
                disabled={busy}
                title="Show a live-looking session ON THIS SCREEN for 90 seconds"
              >
                Preview session
              </button>
            )}
            {canBriefing && (
              <button
                type="button"
                onClick={() =>
                  onSimulate(
                    "preview",
                    { screenId: screen.screenId, mode: "briefing" },
                    `Briefing preview pushed to ${screen.screenId} — video, then helmet sizes, then qualifiers.`,
                  )
                }
                style={btn}
                disabled={busy}
                title="Runs the whole sequence on this screen, on the real schedule"
              >
                Preview briefing
              </button>
            )}
            {canBriefing && (
              <button
                type="button"
                onClick={() =>
                  onSimulate(
                    "preview",
                    { screenId: screen.screenId, mode: "briefing-return" },
                    `Welcome-back board pushed to ${screen.screenId}.`,
                  )
                }
                style={btn}
                disabled={busy}
                title="Skip straight to the welcome-back board — no need to sit through the film"
              >
                Preview welcome back
              </button>
            )}
            {/* One button per mood the scores wall can be in. They are separate
                buttons rather than a dropdown because the whole reason to press
                one is to compare it against the others on the wall. */}
            {canGuide && (
              <button
                type="button"
                onClick={() =>
                  onSimulate(
                    "preview",
                    { screenId: screen.screenId, mode: "guide-arrow" },
                    `Briefing arrow pushed to ${screen.screenId} for 2 minutes.`,
                  )
                }
                style={btn}
                disabled={busy}
                title="Show the proceed-to-the-room arrow without waiting for a real send"
              >
                Preview arrow
              </button>
            )}
            {canResults && (
              <button
                type="button"
                onClick={() =>
                  onSimulate(
                    "preview",
                    { screenId: screen.screenId, mode: "results" },
                    `Results preview pushed to ${screen.screenId} — two racers levelled up.`,
                  )
                }
                style={btn}
                disabled={busy}
                title="A finished race where two people beat the qualifying time"
              >
                Preview results
              </button>
            )}
            {canResults && (
              <button
                type="button"
                onClick={() =>
                  onSimulate(
                    "preview",
                    { screenId: screen.screenId, mode: "results-none" },
                    `Results preview pushed to ${screen.screenId} — nobody qualified.`,
                  )
                }
                style={btn}
                disabled={busy}
                title="The same board when nobody cleared the time"
              >
                Preview results (none)
              </button>
            )}
            {canResults && (
              <button
                type="button"
                onClick={() =>
                  onSimulate(
                    "preview",
                    { screenId: screen.screenId, mode: "results-pro" },
                    `Results preview pushed to ${screen.screenId} — Pro grid.`,
                  )
                }
                style={btn}
                disabled={busy}
                title="A Pro grid — nothing to qualify for, so the panel shows fast lap and podium"
              >
                Preview results (Pro)
              </button>
            )}
            {canResults && (
              <button
                type="button"
                onClick={() =>
                  onSimulate(
                    "preview",
                    { screenId: screen.screenId, mode: "results-mega" },
                    `Results preview pushed to ${screen.screenId} — 20-kart Mega grid.`,
                  )
                }
                style={btn}
                disabled={busy}
                title="A 20-kart Mega grid, to check the two-column layout"
              >
                Preview results (Mega)
              </button>
            )}
            {canVip && (
              <button
                type="button"
                onClick={() =>
                  onSimulate(
                    "preview",
                    { screenId: screen.screenId, mode: "vip" },
                    `VIP preview pushed to ${screen.screenId} for 90s.`,
                  )
                }
                style={{ ...btn, borderColor: "#d4af37", color: "#d4af37" }}
                disabled={busy}
                title="Show the VIP takeover on this screen"
              >
                Preview VIP
              </button>
            )}
            {canWelcome && (
              <button
                type="button"
                onClick={() =>
                  onSimulate(
                    "preview",
                    { screenId: screen.screenId, mode: "event" },
                    `Welcome preview pushed to ${screen.screenId} for 90s.`,
                  )
                }
                style={btn}
                disabled={busy}
                title="Show the party welcome board on this screen"
              >
                Preview welcome
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                onSimulate(
                  "preview",
                  { screenId: screen.screenId, mode: "off" },
                  `${screen.screenId} back to normal.`,
                )
              }
              style={btn}
              disabled={busy}
              title="Return this screen to normal now"
            >
              End preview
            </button>
          </div>
        </div>
      )}

      {showSetup && <SetupSteps screenId={screen.screenId} pairedWith={pairedWith} />}
    </div>
  );
}

/** How to get this screen running on a Windows player. Generated from the same
 *  module that writes the script, so the steps and the file cannot drift. */
function SetupSteps({
  screenId,
  pairedWith,
}: {
  screenId: string;
  pairedWith: { leftId: string; rightId: string } | null;
}) {
  // A paired screen's steps are NOT the single-screen steps: the file has a
  // different name, the desktop has to be extended, and on a managed PC the Edge
  // sign-in policy has to be cleared before anything comes up at all. Showing the
  // one-screen list next to a two-monitor download is how someone follows the
  // wrong instructions confidently.
  const paired = !!pairedWith;
  const steps = pairedWith
    ? dualStartupInstructions(pairedWith.leftId, pairedWith.rightId)
    : startupInstructions(screenId);
  return (
    <div
      style={{
        flexBasis: "100%",
        marginTop: 4,
        padding: 18,
        borderRadius: 8,
        background: "rgba(0,0,0,0.25)",
        border: `1px solid ${PORTAL_DARK.border}`,
      }}
    >
      <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>
        {paired
          ? `Setting up the two-monitor player (${pairedWith?.leftId} left, ${pairedWith?.rightId} right)`
          : "Setting up the player PC"}
      </p>
      <ol
        style={{
          margin: 0,
          paddingLeft: 22,
          fontSize: 13,
          lineHeight: 1.75,
          color: PORTAL_DARK.muted,
        }}
      >
        {steps.map((step) => (
          <li key={step} style={{ marginBottom: 8 }}>
            {step}
          </li>
        ))}
      </ol>
      <p style={{ margin: "14px 0 0", fontSize: 12, color: PORTAL_DARK.muted }}>
        {paired
          ? "The script waits for the network, reads the monitor layout, opens each board fullscreen on its own monitor with its own Edge profile, and relaunches either one automatically if Edge is closed or crashes."
          : "The script waits for the network, opens Edge in true kiosk mode with its own profile, and relaunches automatically if Edge is ever closed or crashes."}
      </p>
    </div>
  );
}

/* ── form ─────────────────────────────────────────────────────────────── */

interface Draft {
  venue: SignageVenue;
  screenNumber: number;
  name: string;
  role: ScreenRole;
  showEventWelcome: boolean;
  showAds: boolean;
  showRaceCheckin: boolean;
  showBriefing: boolean;
  /** "" = not a briefing screen. */
  briefingRoom: "" | "red" | "blue";
  showCamera: boolean;
  cameraDeviceId: string;
  cameraLabel: string;
  /** "" = no track clocks (a non-track camera such as a lobby cam). */
  cameraTrack: "" | "blue" | "red" | "mega";
  /** Pit assignment board — owns its wall, like briefing and camera. */
  showPitBoard: boolean;
  /** Race results / scores wall — owns its wall too. */
  showResults: boolean;
  /** "" = no track picked, which shows the board's setup notice. */
  resultsTrack: "" | "blue" | "red" | "mega";
  /** Check-in guide wall — owns its wall too. */
  showGuide: boolean;
  /** Which tracks the ONE check-in screen covers. */
  guideTracks: "both" | "blue" | "red" | "mega";
  /** Which way the briefing rooms are FROM THIS SCREEN. */
  guideArrow: "left" | "right";
  vipEnabled: boolean;
  vipLeadMins: number;
  celebrationEnabled: boolean;
  crownEnabled: boolean;
  showNextAvailable: boolean;
  checkinWindowMins: number;
  showCheckinCountdown: boolean;
  megaRole: "session" | "checkin";
  pitMegaRole: "assignment" | "tracker";
  showRecordsQr: boolean;
  trackResourceId: string;
  pairGroupId: string;
  pairPosition: number;
  pairCount: number;
  /** The front-desk wall's four-scene loop. Ticked alone, like the briefing and
   *  camera boards — a wall panel owns its screen. */
  showFrontDesk: boolean;
  /** "" = this screen is not part of a video wall. */
  wallId: string;
  wallPosition: number;
  wallCount: number;
  /** Gap between panels as a percent of ONE panel's picture width. */
  wallGapPct: number;
  /** "" = derive from the ends (first fasttrax, last headpinz, inner none). */
  wallBrand: "" | "fasttrax" | "headpinz" | "none";
  /** Percent inset per edge for a panel that crops its own picture. 0 = off. */
  overscanPct: number;
}

/** A stored guide config → the form's single choice. `tracks` is the field; the
 *  singular `track` is still read so a row written before the one-screen change
 *  edits cleanly instead of silently resetting. */
function guideTracksFromConfig(g: ScreenConfig["raceGuide"]): Draft["guideTracks"] {
  const list = g?.tracks ?? (g?.track ? [g.track] : []);
  if (list.length === 1) {
    const only = list[0];
    if (only === "blue" || only === "red" || only === "mega") return only;
  }
  return "both";
}

function newDraft(): Draft {
  return {
    venue: "HPFM",
    screenNumber: 1,
    name: "",
    role: "kiosk-bank",
    showEventWelcome: true,
    showAds: true,
    showRaceCheckin: false,
    showBriefing: false,
    briefingRoom: "",
    showCamera: false,
    cameraDeviceId: "",
    cameraLabel: "",
    cameraTrack: "",
    showPitBoard: false,
    showResults: false,
    resultsTrack: "",
    showGuide: false,
    guideTracks: "both",
    guideArrow: "left",
    vipEnabled: true,
    vipLeadMins: 10,
    celebrationEnabled: true,
    crownEnabled: true,
    showNextAvailable: false,
    checkinWindowMins: 8,
    showCheckinCountdown: true,
    megaRole: "session",
    pitMegaRole: "assignment",
    showRecordsQr: true,
    trackResourceId: "",
    pairGroupId: "",
    pairPosition: 0,
    pairCount: 2,
    showFrontDesk: false,
    wallId: "",
    wallPosition: 0,
    // Five is the only wall that exists, so it is the sensible default the moment
    // somebody types a wall id — but it stays editable, because the next wall
    // will not be five.
    wallCount: 5,
    // ~6 inches on a ~48in picture (owner 2026-08-17).
    wallGapPct: 12,
    wallBrand: "",
    // A new screen assumes a panel that behaves. Nothing is inset until somebody
    // stands in front of a TV that is cropping and says so.
    overscanPct: 0,
  };
}

function draftFromScreen(s: SignageScreen): Draft {
  const c = s.config;
  const scenes = new Set((c.playlist ?? []).map((p) => p.scene));
  return {
    venue: s.venue as SignageVenue,
    screenNumber: s.screenNumber,
    name: s.name,
    role: "kiosk-bank",
    showEventWelcome: scenes.has("event-welcome"),
    // A briefing or camera screen shows ONLY its one scene, so ads must not be
    // inferred from an empty scene set the way they are for an unconfigured one.
    showAds:
      scenes.has("ads") || (scenes.size === 0 && !scenes.has("briefing") && !scenes.has("camera")),
    showRaceCheckin: scenes.has("race-checkin"),
    showBriefing: scenes.has("briefing"),
    briefingRoom: c.briefingRoom === "red" || c.briefingRoom === "blue" ? c.briefingRoom : "",
    showCamera: scenes.has("camera"),
    cameraDeviceId: c.cameraMonitor?.deviceId ?? "",
    cameraLabel: c.cameraMonitor?.label ?? "",
    cameraTrack:
      c.cameraMonitor?.track === "blue" ||
      c.cameraMonitor?.track === "red" ||
      c.cameraMonitor?.track === "mega"
        ? c.cameraMonitor.track
        : "",
    showPitBoard: scenes.has("pit-board"),
    showResults: scenes.has("race-results"),
    showGuide: scenes.has("race-guide"),
    // Read back for the same reason every other field here is: draftToConfig
    // REBUILDS the blob, so anything the form does not carry is dropped by
    // the next unrelated save.
    guideTracks: guideTracksFromConfig(c.raceGuide),
    guideArrow: c.raceGuide?.arrow === "right" ? "right" : "left",
    // Read back for the same reason overscanPct is (see its note below):
    // draftToConfig REBUILDS the whole blob, so a field the form does not
    // carry is a field the next unrelated save silently drops.
    resultsTrack:
      c.resultsBoard?.track === "blue" ||
      c.resultsBoard?.track === "red" ||
      c.resultsBoard?.track === "mega"
        ? c.resultsBoard.track
        : "",
    vipEnabled: c.interrupts?.["vip-welcome"]?.enabled !== false,
    vipLeadMins: c.interrupts?.["vip-welcome"]?.leadMins ?? 10,
    celebrationEnabled: c.interrupts?.celebration?.enabled !== false,
    crownEnabled: c.interrupts?.["billboard-crown"]?.enabled === true,
    showNextAvailable: c.showNextAvailable === true,
    checkinWindowMins: c.checkinWindowMins ?? 8,
    showCheckinCountdown: c.showCheckinCountdown !== false,
    megaRole: c.megaRole === "checkin" ? "checkin" : "session",
    pitMegaRole: c.pitMegaRole === "tracker" ? "tracker" : "assignment",
    showRecordsQr: c.showRecordsQr === true,
    trackResourceId: c.scope?.resourceIds?.[0] ?? "",
    pairGroupId: c.pairing?.groupId ?? "",
    pairPosition: c.pairing?.position ?? 0,
    pairCount: c.pairing?.count ?? 2,
    showFrontDesk:
      scenes.has("vip-showcase") || scenes.has("open-now") || scenes.has("kiosk-howto"),
    // READ BACK, AND THIS IS THE SHARPEST CASE OF WHY. draftToConfig rebuilds the
    // whole blob, so a field the form does not carry is dropped by the next
    // unrelated save — and dropping `wall` from ONE panel of five does not merely
    // lose a setting: that panel falls back to position 0 of 1, stops rendering its
    // own slice, and the wall reads as broken while the other four are fine.
    wallId: c.wall?.wallId ?? "",
    wallPosition: c.wall?.position ?? 0,
    wallCount: c.wall?.count ?? 5,
    wallGapPct: typeof c.wall?.gapPct === "number" ? c.wall.gapPct : 12,
    wallBrand:
      c.wall?.brand === "fasttrax" || c.wall?.brand === "headpinz" || c.wall?.brand === "none"
        ? c.wall.brand
        : "",

    // Read back so that editing anything else on a corrected screen does not
    // un-correct it — draftToConfig below rebuilds the whole blob, so a field
    // the form does not carry is a field the next save silently drops.
    overscanPct: typeof c.overscanPct === "number" ? c.overscanPct : 0,
  };
}

/** Draft → the config blob the TV actually reads. */
function draftToConfig(d: Draft): ScreenConfig {
  const playlist: NonNullable<ScreenConfig["playlist"]> = [];
  // A BRIEFING SCREEN OWNS ITS WALL. It is ticked alone rather than mixed with
  // the others: a safety briefing that rotates out to an advert halfway through
  // is not a briefing, and the room's idle board is content the next group wants
  // anyway. So this branch returns early rather than appending.
  if (d.showBriefing) {
    playlist.push({ scene: "briefing", slots: 1 });
  } else if (d.showCamera) {
    // A CAMERA MONITOR OWNS ITS WALL too — one live picture, nothing rotating
    // across it. Ticked alone, same as the briefing board.
    playlist.push({ scene: "camera", slots: 1 });
  } else if (d.showPitBoard) {
    // A PIT BOARD OWNS ITS WALL: always assignment (owner 2026-08-13), and a
    // celebration cutting across "hold — karts coming in" would put confetti
    // over a safety instruction.
    playlist.push({ scene: "pit-board", slots: 1 });
  } else if (d.showGuide) {
    // A GUIDE WALL OWNS ITS WALL, and for a sharper reason than the others:
    // an advert rotating across the arrow that tells a group which room to
    // walk into would not just be noise, it would send them the wrong way.
    playlist.push({ scene: "race-guide", slots: 1 });
  } else if (d.showFrontDesk) {
    // A WALL PANEL OWNS ITS SCREEN, and this branch is the tear invariant in code.
    // All five panels must carry a BYTE-IDENTICAL playlist, because scene selection
    // is `slot % totalSlots` — two panels disagreeing about their slot total wrap at
    // different moments and the wall visibly tears. Writing the literal here rather
    // than composing it from tick-boxes is what makes that true by construction: the
    // form cannot produce a four-slot variant on one panel. Nothing carries
    // `requiresData` for the same reason (see defaults.ts FRONT_DESK_CONFIG).
    playlist.push({ scene: "vip-showcase", slots: 4 });
    playlist.push({ scene: "open-now", slots: 2 });
    playlist.push({ scene: "kiosk-howto", slots: 1 });
    playlist.push({ scene: "ads", slots: 1 });
  } else if (d.showResults) {
    // A SCORES WALL OWNS ITS WALL: a racer reading their own lap time off it
    // has thirty seconds on the walk past, and rotating an advert across that
    // window would waste the whole point of the screen.
    playlist.push({ scene: "race-results", slots: 1 });
  } else {
    if (d.showRaceCheckin) playlist.push({ scene: "race-checkin", slots: 3 });
    if (d.showEventWelcome) playlist.push({ scene: "event-welcome", slots: 2, requiresData: true });
    if (d.showAds) playlist.push({ scene: "ads", slots: 1 });
    // A screen with everything unticked still shows house ads — a blank wall is
    // never an acceptable outcome of a form.
    if (playlist.length === 0) playlist.push({ scene: "ads", slots: 1 });
  }

  return {
    playlist,
    ...(d.showBriefing && d.briefingRoom ? { briefingRoom: d.briefingRoom } : {}),
    ...(d.showCamera && d.cameraDeviceId.trim()
      ? {
          cameraMonitor: {
            deviceId: d.cameraDeviceId.trim(),
            ...(d.cameraLabel.trim() ? { label: d.cameraLabel.trim() } : {}),
            ...(d.cameraTrack ? { track: d.cameraTrack } : {}),
          },
        }
      : {}),
    ...(d.showResults && d.resultsTrack ? { resultsBoard: { track: d.resultsTrack } } : {}),
    ...(d.showGuide
      ? {
          raceGuide: {
            tracks: d.guideTracks === "both" ? (["blue", "red"] as const) : [d.guideTracks],
            arrow: d.guideArrow,
          },
        }
      : {}),
    interrupts: {
      "vip-welcome": { enabled: d.vipEnabled, leadMins: d.vipLeadMins },
      celebration: { enabled: d.celebrationEnabled },
      "billboard-crown": { enabled: d.crownEnabled },
    },
    showNextAvailable: d.showNextAvailable,
    checkinWindowMins: d.checkinWindowMins,
    showCheckinCountdown: d.showCheckinCountdown,
    megaRole: d.megaRole,
    pitMegaRole: d.pitMegaRole,
    showRecordsQr: d.showRecordsQr,
    scope: d.trackResourceId ? { resourceIds: [d.trackResourceId] } : {},
    // Omitted entirely at 0 rather than written as a zero, so a screen that has
    // never needed correcting carries no fitting field at all. `> 0` also eats a
    // NaN from a cleared input before it can reach the wall.
    ...(d.overscanPct > 0 ? { overscanPct: d.overscanPct } : {}),
    ...(d.pairGroupId
      ? { pairing: { groupId: d.pairGroupId, position: d.pairPosition, count: d.pairCount } }
      : {}),
    // Written only when the screen has a wall id: `wallId` is what groups the
    // panels, and a wall block without one resolves to "not on a wall" anyway.
    // Kept SEPARATE from `pairing` above, which is the whole architectural point —
    // two of these five panels also share a player PC, and folding a 5-wide group
    // into `pairing` would delete their two-monitor launcher (resolvePair needs
    // exactly 2).
    ...(d.wallId
      ? {
          wall: {
            wallId: d.wallId,
            position: d.wallPosition,
            count: d.wallCount,
            gapPct: d.wallGapPct,
            ...(d.wallBrand ? { brand: d.wallBrand } : {}),
          },
        }
      : {}),
  };
}

function ScreenForm({
  draft,
  onChange,
  onSave,
  onCancel,
  busy,
  cameras,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  cameras: CameraLoad;
}) {
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v });

  const applyRole = (role: ScreenRole) => {
    const preset = rolePreset(role);
    const scenes = new Set((preset.config.playlist ?? []).map((p) => p.scene));
    onChange({
      ...draft,
      role,
      showEventWelcome: scenes.has("event-welcome"),
      showAds: scenes.has("ads"),
      showRaceCheckin: scenes.has("race-checkin"),
      showBriefing: scenes.has("briefing"),
      showCamera: scenes.has("camera"),
      showPitBoard: scenes.has("pit-board"),
      showResults: scenes.has("race-results"),
      showGuide: scenes.has("race-guide"),
      showFrontDesk:
        scenes.has("vip-showcase") || scenes.has("open-now") || scenes.has("kiosk-howto"),
      // Picking the front-desk role fills in the wall defaults so the only thing
      // left to set is WHICH panel this is. All five must share the wall id, which
      // is why it is seeded rather than left blank for five separate typings.
      wallId: scenes.has("vip-showcase") ? draft.wallId || "hpfm-front-desk" : draft.wallId,
      wallCount: scenes.has("vip-showcase") ? 5 : draft.wallCount,
      wallGapPct: scenes.has("vip-showcase") ? 12 : draft.wallGapPct,
      // Picking the briefing role at FastTrax defaults the venue too — the rooms
      // only exist there, and a briefing screen saved as HeadPinz would get no
      // briefing data at all (the pulse skips the lookup off-venue). Same for a
      // pit board: the pit lanes are a FastTrax thing. And for a scores wall:
      // the tracks are.
      venue:
        scenes.has("briefing") ||
        scenes.has("pit-board") ||
        scenes.has("race-results") ||
        scenes.has("race-guide")
          ? "FT"
          : // The front-desk wall is a HeadPinz Fort Myers fixture — it hangs over
            // that building's second kiosk bank, and a panel saved as FastTrax would
            // read the wrong venue's ad catalog and brand.
            scenes.has("vip-showcase")
            ? "HPFM"
            : draft.venue,
      vipEnabled: preset.config.interrupts?.["vip-welcome"]?.enabled !== false,
      celebrationEnabled: preset.config.interrupts?.celebration?.enabled !== false,
      crownEnabled: preset.config.interrupts?.["billboard-crown"]?.enabled === true,
    });
  };

  return (
    <div
      style={{
        border: `1px solid ${PORTAL_DARK.border}`,
        background: PORTAL_DARK.card,
        borderRadius: 10,
        padding: 20,
        marginTop: 16,
        display: "grid",
        gap: 18,
        maxWidth: 720,
      }}
    >
      <Field label="What is this screen for?">
        <select
          value={draft.role}
          onChange={(e) => applyRole(e.target.value as ScreenRole)}
          style={input}
        >
          {ROLE_PRESETS.map((p) => (
            <option key={p.role} value={p.role}>
              {p.label}
            </option>
          ))}
        </select>
        <p style={hint}>{rolePreset(draft.role).description}</p>
      </Field>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <Field label="Center">
          <select
            value={draft.venue}
            onChange={(e) => set("venue", e.target.value as SignageVenue)}
            style={input}
          >
            {SIGNAGE_VENUES.map((v) => (
              <option key={v} value={v}>
                {VENUE_INFO[v].label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Screen number">
          <input
            type="number"
            min={0}
            value={draft.screenNumber}
            onChange={(e) => set("screenNumber", Number(e.target.value))}
            style={{ ...input, width: 120 }}
          />
          <p style={hint}>Use {TEST_SCREEN_NUMBER} for a test screen.</p>
        </Field>
      </div>

      <Field label="Where is it?">
        <input
          type="text"
          value={draft.name}
          placeholder="Above the kiosk bank"
          onChange={(e) => set("name", e.target.value)}
          style={input}
        />
      </Field>

      <fieldset style={fieldset}>
        <legend style={legend}>What it shows</legend>
        <Check
          checked={draft.showEventWelcome}
          onChange={(v) => set("showEventWelcome", v)}
          label="Welcome board"
          hint="Today's birthday parties and group functions, and where they go first. Hides itself when there are no events."
        />
        <Check
          checked={draft.showAds}
          onChange={(v) => set("showAds", v)}
          label="House advertising"
          hint="What the kiosks below can sell; never a paused product. UNTICKED, ads still fill in whenever nothing else has anything to show — a wall never goes blank — so leave this off to make events the priority and ads the fallback."
        />
        <Check
          checked={draft.showRecordsQr}
          onChange={(v) => set("showRecordsQr", v)}
          label="Track records QR"
          hint="A labelled 'Scan for track records' code on the track boards, shown only when the screen is calm — never while a scan is landing or a heat is being called."
        />
        <Check
          checked={draft.showNextAvailable}
          onChange={(v) => set("showNextAvailable", v)}
          label="Show next available times on ads"
          hint="Puts a real next-available time on each advert, read from the same availability the kiosks use. A locked or unknown product simply shows no time."
        />
        <Check
          checked={draft.showRaceCheckin}
          onChange={(v) => set("showRaceCheckin", v)}
          label="Race check-in"
          hint="The session checking in now, and racers as they scan. Ships with the racing-TV release."
        />
        <Check
          checked={draft.showBriefing}
          onChange={(v) => set("showBriefing", v)}
          label="Briefing room"
          hint="Plays the safety video for the session staff send to this room, then helmet sizes, then who levelled up in the session before. Takes the whole screen — nothing else shows and nothing interrupts it."
        />
        <Check
          checked={draft.showCamera}
          onChange={(v) => set("showCamera", v)}
          label="Camera monitor"
          hint="A live venue camera on this screen, refreshed about once a second — e.g. a briefing room's own camera so staff can watch it fill. Takes the whole screen; pick the camera below. Nothing else shows and nothing interrupts it."
        />
        <Check
          checked={draft.showPitBoard}
          onChange={(v) => set("showPitBoard", v)}
          label="Pit assignment board"
          hint="The staged session's spots — names, photos, camera state — with the seating rail: seat while the race runs, hold while karts return. Pick the track below. Takes the whole screen; nothing else shows and nothing interrupts it."
        />
        <Check
          checked={draft.showGuide}
          onChange={(v) => set("showGuide", v)}
          label="Check-in screen"
          hint="Between check-in and the briefing rooms. Explains shoes, lockers and how you move up a class over track photos — then turns the track's colour with a big arrow to the briefing room the moment that session is sent. Pick the track and the direction below."
        />
        <Check
          checked={draft.showResults}
          onChange={(v) => set("showResults", v)}
          label="Race results board"
          hint="The race that just came back in — final standings with best laps, and who levelled up a class. For a wall at the kart return. Pick the track below. Takes the whole screen; nothing else shows and nothing interrupts it."
        />
        <Check
          checked={draft.showFrontDesk}
          onChange={(v) => set("showFrontDesk", v)}
          label="Front desk wall panel"
          hint="One panel of the five-TV wall over the second kiosk bank. All five run the SAME loop — the VIP Experience, the menu board of what's open, then one instruction per kiosk — and each renders its own slice. Takes the whole screen; set the wall position below."
        />
      </fieldset>

      {draft.showGuide && (
        <fieldset style={fieldset}>
          <legend style={legend}>Check-in screen</legend>
          <Field label="Which tracks does this screen cover?">
            <select
              value={draft.guideTracks}
              onChange={(e) => set("guideTracks", e.target.value as Draft["guideTracks"])}
              style={input}
            >
              <option value="both">Both tracks &mdash; Blue and Red</option>
              <option value="blue">Blue Track only</option>
              <option value="red">Red Track only</option>
              <option value="mega">Mega Track only</option>
            </select>
            <p style={hint}>
              This is ONE screen for the whole check-in area, not one per track. On
              &ldquo;both&rdquo; it carries a qualifying card for each track and takes the arrow
              from whichever one is sent &mdash; if two go at once, the newest owns the screen and
              the other is named along the bottom.
            </p>
          </Field>
          <Field label="Which way are the briefing rooms from this screen?">
            <select
              value={draft.guideArrow}
              onChange={(e) => set("guideArrow", e.target.value as Draft["guideArrow"])}
              style={input}
            >
              <option value="left">Left &mdash; arrow points left</option>
              <option value="right">Right &mdash; arrow points right</option>
            </select>
            <p style={hint}>
              This is a fact about where the screen hangs, so it is set per screen. An arrow
              pointing confidently the wrong way is worse than no arrow &mdash; check it from where
              a guest actually stands.
            </p>
          </Field>
        </fieldset>
      )}

      {draft.showResults && (
        <Field label="Which track's results does this screen show?">
          <select
            value={draft.resultsTrack}
            onChange={(e) => set("resultsTrack", e.target.value as Draft["resultsTrack"])}
            style={input}
          >
            <option value="">Choose a track…</option>
            <option value="blue">Blue Track</option>
            <option value="red">Red Track</option>
            <option value="mega">Mega Track</option>
          </select>
          <p style={hint}>
            Required. Until it is set the screen shows a setup notice rather than guessing a track.
            Heat numbers repeat across tracks — Blue 59 and Red 59 are two different races — so this
            is what decides which one the board is reporting.
          </p>
        </Field>
      )}

      {draft.showBriefing && (
        <Field label="Which briefing room is this screen in?">
          <select
            value={draft.briefingRoom}
            onChange={(e) => set("briefingRoom", e.target.value as "" | "red" | "blue")}
            style={input}
          >
            <option value="">Choose a room…</option>
            <option value="red">Red briefing room</option>
            <option value="blue">Blue briefing room</option>
          </select>
          <p style={hint}>
            Required. Both rooms read the same feed, so this is what tells the screen which sends
            are for it — until it is set, the screen shows a setup notice instead of briefings.
          </p>
        </Field>
      )}

      {draft.showCamera && (
        <fieldset style={fieldset}>
          <legend style={legend}>Camera</legend>
          <Field label="Which camera?">
            <CameraPicker
              cameras={cameras}
              value={draft.cameraDeviceId}
              onChange={(id) => set("cameraDeviceId", id)}
            />
            <p style={hint}>
              The live feed comes through the venue&rsquo;s Nx system. Point a board at a briefing
              room&rsquo;s own camera so staff can watch it fill from the floor.
            </p>
          </Field>
          <Field label="Caption on the board (optional)">
            <input
              type="text"
              value={draft.cameraLabel}
              placeholder="Blue Briefing Room"
              onChange={(e) => set("cameraLabel", e.target.value)}
              style={input}
            />
          </Field>
          <Field label="Show which track's clocks? (optional)">
            <select
              value={draft.cameraTrack}
              onChange={(e) => set("cameraTrack", e.target.value as Draft["cameraTrack"])}
              style={input}
            >
              <option value="">No clocks</option>
              <option value="blue">Blue Track</option>
              <option value="red">Red Track</option>
              <option value="mega">Mega Track</option>
            </select>
            <p style={hint}>
              Pick a track and the big session and running-behind clocks appear along the bottom,
              following that track (and Mega on Mega days). Leave blank for a plain camera.
            </p>
          </Field>
        </fieldset>
      )}

      <fieldset style={fieldset}>
        <legend style={legend}>What interrupts it</legend>
        <Check
          checked={draft.vipEnabled}
          onChange={(v) => set("vipEnabled", v)}
          label="VIP welcome"
          hint="A gold VIP slide joins the welcome rotation — welcome page, VIP, welcome page, VIP — from about 10 minutes before a party's bowling leg. Not a takeover."
        />
        {draft.vipEnabled && (
          <label style={{ ...hint, display: "block", marginLeft: 28 }}>
            Start greeting{" "}
            <input
              type="number"
              min={1}
              max={60}
              value={draft.vipLeadMins}
              onChange={(e) => set("vipLeadMins", Number(e.target.value))}
              style={{ ...input, width: 72, display: "inline-block", margin: "0 6px" }}
            />
            minutes before
          </label>
        )}
        <Check
          checked={draft.celebrationEnabled}
          onChange={(v) => set("celebrationEnabled", v)}
          label="Kiosk celebrations"
          hint="A short burst when someone books or checks in on a kiosk nearby."
        />
        <Check
          checked={draft.crownEnabled}
          onChange={(v) => set("crownEnabled", v)}
          label="Join the kiosk billboard"
          hint="Only for a screen physically above a bank of kiosks — it performs as the top of their billboard."
        />
      </fieldset>

      {draft.showRaceCheckin && (
        <Field label="Check-in countdown">
          <Check
            checked={draft.showCheckinCountdown}
            onChange={(v) => set("showCheckinCountdown", v)}
            label="Show the countdown"
            hint="Off, the board still shows the session and the cut-off state — just without a ticking timer."
          />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 14 }}>Racers get</span>
            <input
              type="number"
              min={1}
              max={60}
              value={draft.checkinWindowMins}
              onChange={(e) => set("checkinWindowMins", Number(e.target.value))}
              style={{ ...input, width: 90 }}
            />
            <span style={{ fontSize: 14 }}>minutes from when the heat is called</span>
          </div>
          <p style={hint}>
            The board counts down from the moment the heat is first called. When it runs out it says
            &ldquo;Check in now &mdash; see the desk&rdquo; rather than showing a zero, because
            staff will still check somebody in a minute late.
          </p>
        </Field>
      )}

      {draft.showRaceCheckin && (
        <Field label="On Mega days, this board shows">
          <select
            value={draft.megaRole}
            onChange={(e) => set("megaRole", e.target.value as "session" | "checkin")}
            style={input}
          >
            <option value="session">Session data (now checking in, cut-off, delay)</option>
            <option value="checkin">Live check-in feed (every name, never clears)</option>
          </select>
          <p style={hint}>
            On Mega days both tracks run as one circuit, so the pair of boards would show the same
            thing. Set one to the check-in feed and the pair splits the job: one board carries the
            session, the other lists everyone as they scan — names never age off.
          </p>
        </Field>
      )}

      {draft.showPitBoard && (
        <Field label="On Mega days, this pit sign shows">
          <select
            value={draft.pitMegaRole}
            onChange={(e) => set("pitMegaRole", e.target.value as "assignment" | "tracker")}
            style={input}
          >
            <option value="assignment">Seat assignments (the pit board, as today)</option>
            <option value="tracker">Session tracker (every stage, checking in to pit in)</option>
          </select>
          <p style={hint}>
            On Mega days both pit signs read the one combined lane, so the pair would show the same
            seats. Set one to the session tracker and the pair splits the job: one sign seats the
            group, the other shows every session&rsquo;s place in the pipeline — called, briefing
            rooms, holding, karts, on track, pit in.
          </p>
        </Field>
      )}

      <Field label="Only react to one track (optional)">
        <select
          value={draft.trackResourceId}
          onChange={(e) => set("trackResourceId", e.target.value)}
          style={input}
        >
          <option value="">Everything at this center</option>
          {TRACK_OPTIONS.map((t) => (
            <option key={t.resourceId} value={t.resourceId}>
              {t.label}
            </option>
          ))}
        </select>
        <p style={hint}>
          Pick a track so this screen ignores scans on the other one. Leave it open for a lobby TV.
        </p>
      </Field>

      <Field label="Is this TV cutting off the edges? (optional)">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            type="number"
            min={0}
            max={TV_MAX_OVERSCAN_PCT}
            step={0.5}
            value={draft.overscanPct}
            onChange={(e) => set("overscanPct", Number(e.target.value))}
            style={{ ...input, width: 100 }}
          />
          <span style={{ fontSize: 14 }}>% pulled in on every edge</span>
        </div>
        <p style={hint}>
          Leave at 0 for a panel that shows the whole picture. <strong>Try the TV first:</strong>{" "}
          most sets crop their own input until you turn it off &mdash; &ldquo;Just Scan&rdquo; on
          LG, Picture Size &rarr; &ldquo;Fit to Screen&rdquo; on Samsung, &ldquo;Dot by Dot&rdquo;
          or &ldquo;Normal&rdquo; elsewhere, or rename the HDMI input to &ldquo;PC&rdquo;. That is
          sharper than correcting here, because the TV is zooming a crop.
        </p>
        <p style={hint}>
          If the TV&rsquo;s own menu won&rsquo;t do it, save 3 and watch the screen: it re-fits
          within about fifteen seconds with no restart &mdash; safe to do mid-service, even during a
          briefing &mdash; then nudge by 0.5 until the bottom line just clears the bezel. Every
          percent costs a little picture, so stop at the first value that works.
        </p>
      </Field>

      <fieldset style={fieldset}>
        <legend style={legend}>Video wall (optional)</legend>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            type="text"
            value={draft.wallId}
            placeholder="Wall name, e.g. hpfm-front-desk"
            onChange={(e) => set("wallId", e.target.value)}
            style={{ ...input, flex: "1 1 200px" }}
            aria-label="Wall name"
          />
          <input
            type="number"
            min={0}
            value={draft.wallPosition}
            onChange={(e) => set("wallPosition", Number(e.target.value))}
            style={{ ...input, width: 110 }}
            aria-label="Position on the wall (0 = far left)"
          />
          <input
            type="number"
            min={1}
            value={draft.wallCount}
            onChange={(e) => set("wallCount", Number(e.target.value))}
            style={{ ...input, width: 110 }}
            aria-label="Panels on the wall"
          />
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          <label style={{ ...hint, display: "flex", alignItems: "center", gap: 8 }}>
            Gap between panels
            <input
              type="number"
              min={0}
              max={100}
              value={draft.wallGapPct}
              onChange={(e) => set("wallGapPct", Number(e.target.value))}
              style={{ ...input, width: 90 }}
              aria-label="Gap between panels, percent of one panel's width"
            />
            % of one panel
          </label>
          <select
            value={draft.wallBrand}
            onChange={(e) => set("wallBrand", e.target.value as Draft["wallBrand"])}
            style={{ ...input, width: 220 }}
            aria-label="Brand mark on this panel"
          >
            <option value="">Brand mark: from its place on the wall</option>
            <option value="fasttrax">FastTrax</option>
            <option value="headpinz">HeadPinz</option>
            <option value="none">No mark</option>
          </select>
        </div>
        <p style={hint}>
          Several screens hung close enough to read as ONE picture. Give every panel the same wall
          name and its own position — <b>0 is the far left as you face the wall</b> — and each one
          renders its own slice of every scene instead of all five showing the same card.
        </p>
        <p style={hint}>
          <b>All panels of a wall must show the same things.</b> Which scene is up is worked out
          from the clock as <i>slot ÷ number of slots</i>, so a panel with a different set of
          tick-boxes wraps at a different moment and the wall visibly tears. Tick{" "}
          <b>Front desk wall panel</b> on all five and change nothing else.
        </p>
        <p style={hint}>
          The gap is what a wall-long light pass has to travel across — measure it, don&apos;t
          guess. ~6 inches on a ~48 inch picture is about 12%. It is a percentage of{" "}
          <b>one panel&apos;s width</b>, not of the whole wall.
        </p>
        <p style={hint}>
          This is separate from pairing below, and both can be set at once: pairing is which two
          screens share one player PC (it must be exactly two, or the two-monitor launcher
          disappears), while the wall is how many perform together.
        </p>
      </fieldset>

      <fieldset style={fieldset}>
        <legend style={legend}>Pair with another screen (optional)</legend>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            type="text"
            value={draft.pairGroupId}
            placeholder="Group name, e.g. ft-tracks"
            onChange={(e) => set("pairGroupId", e.target.value)}
            style={{ ...input, flex: "1 1 200px" }}
            aria-label="Group name"
          />
          <input
            type="number"
            min={0}
            value={draft.pairPosition}
            onChange={(e) => set("pairPosition", Number(e.target.value))}
            style={{ ...input, width: 110 }}
            aria-label="Position in group"
          />
          <input
            type="number"
            min={1}
            value={draft.pairCount}
            onChange={(e) => set("pairCount", Number(e.target.value))}
            style={{ ...input, width: 110 }}
            aria-label="Screens in group"
          />
        </div>
        <p style={hint}>
          Give two screens the same group name and positions 0 and 1, and they perform as one
          display — used when both tracks combine for a Mega race.
        </p>
      </fieldset>

      <div style={{ display: "flex", gap: 10 }}>
        <button type="button" onClick={onSave} style={primaryBtn} disabled={busy}>
          {busy ? "Saving…" : "Save screen"}
        </button>
        <button type="button" onClick={onCancel} style={btn} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The camera dropdown, grouped by venue/area. Handles its own not-yet-loaded,
 * not-configured and empty states so the form body stays readable. A currently
 * saved id that is not in the list (a camera renamed or removed in Nx) is kept as
 * its own option, so editing a screen never silently drops its camera.
 */
function CameraPicker({
  cameras,
  value,
  onChange,
}: {
  cameras: CameraLoad;
  value: string;
  onChange: (id: string) => void;
}) {
  if (cameras === null) {
    return <p style={hint}>Loading cameras…</p>;
  }
  if (!cameras.configured) {
    return (
      <p style={{ ...hint, color: "#f0b341" }}>
        Camera bridge not configured on this deploy — set NX_CLOUD_SYSTEM_ID, NX_CLOUD_USERNAME and
        NX_CLOUD_PASSWORD, then reload.
      </p>
    );
  }

  const groups = new Map<string, CameraOption[]>();
  for (const c of cameras.list) {
    const g = c.group || "Other";
    const list = groups.get(g) ?? [];
    list.push(c);
    groups.set(g, list);
  }
  const known = cameras.list.some((c) => c.id === value);

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={input}>
      <option value="">Choose a camera…</option>
      {value && !known && (
        // The saved camera is no longer in the list — keep it selectable rather
        // than resetting the board's camera out from under it.
        <option value={value}>Current camera ({value.slice(0, 8)}…)</option>
      )}
      {Array.from(groups.entries()).map(([group, list]) => (
        <optgroup key={group} label={group}>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.status && c.status !== "Recording" ? ` — ${c.status}` : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/* ── small pieces ─────────────────────────────────────────────────────── */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint: hintText,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 12 }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        // The visible text sits two spans deep so the hint can wrap under it;
        // name the control explicitly rather than relying on that nesting.
        aria-label={label}
        style={{ marginTop: 4, width: 18, height: 18 }}
      />
      <span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
        <span style={{ ...hint, display: "block", marginTop: 2 }}>{hintText}</span>
      </span>
    </label>
  );
}

function timeAgo(iso: string, nowMs: number): string {
  const mins = Math.floor((nowMs - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins)) return "unknown";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs} hr ago` : `${Math.floor(hrs / 24)} d ago`;
}

const btn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: `1px solid ${PORTAL_DARK.border}`,
  background: "transparent",
  color: PORTAL_DARK.fg,
  fontSize: 13,
  cursor: "pointer",
};

const primaryBtn: React.CSSProperties = {
  ...btn,
  background: PORTAL_BLUE,
  borderColor: PORTAL_BLUE,
  color: "#fff",
  fontWeight: 600,
};

const dangerBtn: React.CSSProperties = { ...btn, color: "#f87171", borderColor: "#7f1d1d" };

const input: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: `1px solid ${PORTAL_DARK.inputBorder}`,
  background: PORTAL_DARK.inputBg,
  color: PORTAL_DARK.fg,
  fontSize: 14,
  fontFamily: ADMIN_SANS,
};

const hint: React.CSSProperties = { fontSize: 12, color: PORTAL_DARK.muted, margin: "6px 0 0" };

const fieldset: React.CSSProperties = {
  border: `1px solid ${PORTAL_DARK.border}`,
  borderRadius: 8,
  padding: 16,
};

const legend: React.CSSProperties = { fontSize: 13, fontWeight: 700, padding: "0 6px" };

const pill: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 999,
  border: `1px solid ${PORTAL_DARK.border}`,
  color: PORTAL_DARK.muted,
};
