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
import {
  SIGNAGE_VENUES,
  VENUE_INFO,
  TEST_SCREEN_NUMBER,
  type SignageVenue,
} from "~/features/signage/constants";
import { ROLE_PRESETS, rolePreset, type ScreenRole } from "~/features/signage/defaults";
import { startupInstructions, startupScriptFileName } from "~/features/signage/startup-script";
import type { ScreenConfig, SignageScreen } from "~/features/signage/types";

interface LoadState {
  screens: SignageScreen[];
  seen: Record<string, string | null>;
}

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

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/signage?token=${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      if (res.ok) setData((await res.json()) as LoadState);
      // One clock read per load, passed down — so a row's "online" dot is not
      // an impure Date.now() call during render.
      setLoadedAt(Date.now());
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
    // Keep the online dots honest without a manual refresh.
    const iv = setInterval(() => void load(), 30_000);
    return () => clearInterval(iv);
  }, [load]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
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
          setNote(json.error ?? "Something went wrong");
          return false;
        }
        return true;
      } catch {
        setNote("Could not reach the server");
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
            onClick={() => setEditing(newDraft())}
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
                token={token}
                lastSeen={data.seen[s.screenId] ?? null}
                nowMs={loadedAt}
                onEdit={() => setEditing(draftFromScreen(s))}
                onDelete={() => remove(s.screenId)}
                onTest={() => post({ action: "test-celebration", center: s.center })}
                onSimulate={(action, extra) =>
                  post({ action, center: s.center, firstName: "Marcus", ...extra })
                }
                onSimulateScan={(track, opts) =>
                  post({
                    action: "simulate-scan",
                    center: s.center,
                    track,
                    firstName: "Marcus",
                    ...opts,
                  })
                }
                busy={busy}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ── row ──────────────────────────────────────────────────────────────── */

function ScreenRow({
  screen,
  token,
  lastSeen,
  nowMs,
  onEdit,
  onDelete,
  onTest,
  onSimulateScan,
  onSimulate,
  busy,
}: {
  screen: SignageScreen;
  token: string;
  lastSeen: string | null;
  /** Clock read once per load by the parent — never Date.now() during render. */
  nowMs: number;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onSimulateScan: (track: string, opts: { vip?: boolean; birthday?: boolean }) => void;
  onSimulate: (action: string, extra?: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [showSetup, setShowSetup] = useState(false);
  const online = lastSeen ? nowMs - Date.parse(lastSeen) < 60_000 : false;
  const scopedTrack = screen.config.scope?.resourceIds?.[0];
  const trackName =
    TRACK_OPTIONS.find((t) => t.resourceId === scopedTrack)
      ?.label.split(" ")[0]
      .toLowerCase() ?? "blue";
  const url = `${typeof window !== "undefined" ? window.location.origin : ""}/tv?screen=${encodeURIComponent(screen.screenId)}`;
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
            : lastSeen
              ? `last seen ${timeAgo(lastSeen, nowMs)}`
              : "never seen"}
        </p>
        <p style={{ color: PORTAL_DARK.muted, fontSize: 13, margin: "4px 0 0" }}>
          Shows: {scenes.length ? scenes.join(", ") : "ads"}
        </p>
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
        <button type="button" onClick={() => setShowSetup((v) => !v)} style={btn}>
          {showSetup ? "Hide setup" : "Setup steps"}
        </button>
        <button type="button" onClick={onTest} style={btn} disabled={busy}>
          Fire test celebration
        </button>
        <button
          type="button"
          onClick={() => onSimulateScan(trackName, {})}
          style={btn}
          disabled={busy}
          title="Publishes a racer-scanned event on the real rail"
        >
          Simulate scan
        </button>
        <button
          type="button"
          onClick={() => onSimulateScan(trackName, { birthday: true })}
          style={{ ...btn, borderColor: "#ec4899", color: "#ec4899" }}
          disabled={busy}
          title="Fires the full birthday takeover on BOTH karting boards"
        >
          Simulate birthday
        </button>
        <button
          type="button"
          onClick={() => onSimulate("simulate-wrong-race", { track: trackName })}
          style={{ ...btn, borderColor: "#f0b341", color: "#f0b341" }}
          disabled={busy}
          title="Somebody scanned for a heat that is not the one checking in"
        >
          Simulate wrong race
        </button>
        <button
          type="button"
          onClick={() => onSimulate("preview", { screenId: screen.screenId, mode: "race" })}
          style={btn}
          disabled={busy}
          title="Show a live-looking session ON THIS SCREEN for 90 seconds"
        >
          Preview session
        </button>
        <button
          type="button"
          onClick={() => onSimulate("preview", { screenId: screen.screenId, mode: "vip" })}
          style={{ ...btn, borderColor: "#d4af37", color: "#d4af37" }}
          disabled={busy}
          title="Show the VIP takeover on this screen"
        >
          Preview VIP
        </button>
        <button
          type="button"
          onClick={() => onSimulate("preview", { screenId: screen.screenId, mode: "event" })}
          style={btn}
          disabled={busy}
          title="Show the party welcome board on this screen"
        >
          Preview welcome
        </button>
        <button
          type="button"
          onClick={() => onSimulate("preview", { screenId: screen.screenId, mode: "off" })}
          style={btn}
          disabled={busy}
          title="Return this screen to normal now"
        >
          End preview
        </button>
        <button type="button" onClick={onEdit} style={btn} disabled={busy}>
          Edit
        </button>
        <button type="button" onClick={onDelete} style={dangerBtn} disabled={busy}>
          Remove
        </button>
      </div>

      {showSetup && <SetupSteps screenId={screen.screenId} />}
    </div>
  );
}

/** How to get this screen running on a Windows player. Generated from the same
 *  module that writes the script, so the steps and the file cannot drift. */
function SetupSteps({ screenId }: { screenId: string }) {
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
      <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>Setting up the player PC</p>
      <ol
        style={{
          margin: 0,
          paddingLeft: 22,
          fontSize: 13,
          lineHeight: 1.75,
          color: PORTAL_DARK.muted,
        }}
      >
        {startupInstructions(screenId).map((step) => (
          <li key={step} style={{ marginBottom: 8 }}>
            {step}
          </li>
        ))}
      </ol>
      <p style={{ margin: "14px 0 0", fontSize: 12, color: PORTAL_DARK.muted }}>
        The script waits for the network, opens Edge in true kiosk mode with its own profile, and
        relaunches automatically if Edge is ever closed or crashes.
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
  vipEnabled: boolean;
  vipLeadMins: number;
  celebrationEnabled: boolean;
  crownEnabled: boolean;
  showNextAvailable: boolean;
  trackResourceId: string;
  pairGroupId: string;
  pairPosition: number;
  pairCount: number;
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
    vipEnabled: true,
    vipLeadMins: 10,
    celebrationEnabled: true,
    crownEnabled: true,
    showNextAvailable: false,
    trackResourceId: "",
    pairGroupId: "",
    pairPosition: 0,
    pairCount: 2,
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
    showAds: scenes.has("ads") || scenes.size === 0,
    showRaceCheckin: scenes.has("race-checkin"),
    vipEnabled: c.interrupts?.["vip-welcome"]?.enabled !== false,
    vipLeadMins: c.interrupts?.["vip-welcome"]?.leadMins ?? 10,
    celebrationEnabled: c.interrupts?.celebration?.enabled !== false,
    crownEnabled: c.interrupts?.["billboard-crown"]?.enabled === true,
    showNextAvailable: c.showNextAvailable === true,
    trackResourceId: c.scope?.resourceIds?.[0] ?? "",
    pairGroupId: c.pairing?.groupId ?? "",
    pairPosition: c.pairing?.position ?? 0,
    pairCount: c.pairing?.count ?? 2,
  };
}

/** Draft → the config blob the TV actually reads. */
function draftToConfig(d: Draft): ScreenConfig {
  const playlist: NonNullable<ScreenConfig["playlist"]> = [];
  if (d.showRaceCheckin) playlist.push({ scene: "race-checkin", slots: 3 });
  if (d.showEventWelcome) playlist.push({ scene: "event-welcome", slots: 2, requiresData: true });
  if (d.showAds) playlist.push({ scene: "ads", slots: 1 });
  // A screen with everything unticked still shows house ads — a blank wall is
  // never an acceptable outcome of a form.
  if (playlist.length === 0) playlist.push({ scene: "ads", slots: 1 });

  return {
    playlist,
    interrupts: {
      "vip-welcome": { enabled: d.vipEnabled, leadMins: d.vipLeadMins },
      celebration: { enabled: d.celebrationEnabled },
      "billboard-crown": { enabled: d.crownEnabled },
    },
    showNextAvailable: d.showNextAvailable,
    scope: d.trackResourceId ? { resourceIds: [d.trackResourceId] } : {},
    ...(d.pairGroupId
      ? { pairing: { groupId: d.pairGroupId, position: d.pairPosition, count: d.pairCount } }
      : {}),
  };
}

function ScreenForm({
  draft,
  onChange,
  onSave,
  onCancel,
  busy,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
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
          hint="What the kiosks below can sell. Never advertises a product that's currently paused."
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
      </fieldset>

      <fieldset style={fieldset}>
        <legend style={legend}>What interrupts it</legend>
        <Check
          checked={draft.vipEnabled}
          onChange={(v) => set("vipEnabled", v)}
          label="VIP welcome"
          hint="Takes over the screen ahead of a VIP party's bowling leg."
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
