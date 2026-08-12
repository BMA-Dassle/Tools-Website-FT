"use client";

/**
 * Upload the briefing films and the helmet-sizing poster.
 *
 * THE FILES GO STRAIGHT TO THE STORE, not through our server: a serverless
 * request body is capped at 4.5 MB and a briefing video is hundreds of megabytes.
 * `upload()` asks our token route for a scoped credential and streams the file
 * itself, in ~8 MB parts with per-part retry (`multipart: true` — this is NOT the
 * default and a large upload will fail without it).
 *
 * VIDEO LENGTH IS READ IN THE BROWSER, BEFORE the upload, and sent with the
 * confirm-POST. The room TVs derive their whole sequence — video, then helmet
 * board, then qualifiers — from the send time plus this number, so it is not
 * decoration: without it a screen falls back to a nominal five minutes and the
 * helmet board arrives at the wrong moment.
 */
import { useCallback, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import { BRIEFING_ASSET_KEYS, type BriefingAssetKey } from "~/features/signage/briefing/types";

interface AssetRow {
  key: BriefingAssetKey;
  label: string;
  hint: string;
  accept: string;
  kind: "video" | "image";
}

const ROWS: AssetRow[] = [
  {
    key: "briefing-video:starter",
    label: "Starter briefing video",
    hint: "The full safety briefing, for Starter sessions. MP4 or MOV, as long as it is H.264 — the check below will tell you before it uploads.",
    accept: "video/mp4,video/quicktime,.mp4,.mov",
    kind: "video",
  },
  {
    key: "briefing-video:pro",
    label: "Pro briefing video",
    hint: "Optional. Pro sessions play this when it exists — and fall back to the Intermediate film when it doesn't, so nothing breaks while it is missing.",
    accept: "video/mp4,video/quicktime,.mp4,.mov",
    kind: "video",
  },
  {
    key: "briefing-video:intermediate",
    label: "Intermediate briefing video",
    hint: "The shorter briefing for racers who have been out before. MP4 or MOV (H.264).",
    accept: "video/mp4,video/quicktime,.mp4,.mov",
    kind: "video",
  },
  {
    key: "briefing-helmet-poster",
    label: "Helmet sizes poster",
    hint: "Shown for about 30 seconds after the video, and whenever a room is idle. A tall or wide graphic is fine — it is fitted to the screen without cropping.",
    accept: "image/png,image/jpeg,image/webp",
    kind: "image",
  },
];

export interface BriefingAssetState {
  videos: {
    starter: { url: string; durationMs: number | null } | null;
    intermediate: { url: string; durationMs: number | null } | null;
    pro: { url: string; durationMs: number | null } | null;
  };
  helmetPosterUrl: string | null;
}

export default function BriefingAssetManager({
  token,
  assets,
  onChanged,
}: {
  token: string;
  assets: BriefingAssetState | null;
  onChanged: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const currentUrl = useCallback(
    (key: BriefingAssetKey): string | null => {
      if (!assets) return null;
      if (key === "briefing-video:starter") return assets.videos.starter?.url ?? null;
      if (key === "briefing-video:intermediate") return assets.videos.intermediate?.url ?? null;
      // EXPLICIT per key — the old two-video fallthrough made the new Pro slot
      // display the HELMET POSTER's url, so the row claimed a Pro film was
      // uploaded when none was (owner 2026-08-11: "says there is one uploaded
      // and there is not").
      if (key === "briefing-video:pro") return assets.videos.pro?.url ?? null;
      return assets.helmetPosterUrl;
    },
    [assets],
  );

  const currentDuration = useCallback(
    (key: BriefingAssetKey): number | null => {
      if (!assets) return null;
      if (key === "briefing-video:starter") return assets.videos.starter?.durationMs ?? null;
      if (key === "briefing-video:intermediate")
        return assets.videos.intermediate?.durationMs ?? null;
      if (key === "briefing-video:pro") return assets.videos.pro?.durationMs ?? null;
      return null;
    },
    [assets],
  );

  const handleFile = useCallback(
    async (row: AssetRow, file: File) => {
      setBusyKey(row.key);
      setNote(null);
      setProgress((p) => ({ ...p, [row.key]: 0 }));
      try {
        // DECODE PROBE FIRST — before a ten-minute upload of a file the wall
        // could never play.
        //
        // This is what makes accepting .mov safe. The extension says nothing
        // about the codec: a .mov holding H.264 plays fine, the same .mov holding
        // ProRes or HEVC does not, and a master export out of an editor is often
        // one of those. The probe runs in the SAME browser engine as the players,
        // so "it decoded here" genuinely means "it will decode there".
        let durationMs: number | null = null;
        if (row.kind === "video") {
          const meta = await readVideoMeta(file);
          if (!meta.ok) {
            setNote(`✕ ${describeVideoFailure(meta.reason, file)}`);
            return;
          }
          durationMs = meta.durationMs;
          setNote(
            `Checked: ${meta.width}×${meta.height}, ${formatDuration(meta.durationMs)} — uploading…`,
          );
        }

        const result = await upload(`briefing/${fileSlug(row.key, file.name)}`, file, {
          access: "public",
          // SERVE A .MOV AS video/mp4. Chromium refuses `video/quicktime` as media
          // outright — canPlayType returns "" — so a .mov briefing film played
          // BLACK in the room even though its bytes were plain H.264 (owner
          // 2026-08-11). QuickTime and MP4 are both ISO base-media formats, so the
          // MP4 demuxer handles the file fine; it just has to be asked. This is not
          // a lie about the payload: the decode probe above has already proved this
          // browser can decode it, and the browser is the same engine as the
          // players'.
          contentType: row.kind === "video" ? "video/mp4" : undefined,
          handleUploadUrl: `/api/admin/signage/briefing-upload?token=${encodeURIComponent(token)}`,
          clientPayload: row.key,
          // REQUIRED for large files — see the header.
          multipart: true,
          onUploadProgress: ({ percentage }) =>
            setProgress((p) => ({ ...p, [row.key]: Math.round(percentage) })),
        });

        // Only NOW is it the current file. The upload landing in the store and
        // the manifest pointing at it are two steps on purpose: a tab closed
        // mid-upload leaves an orphan blob, never a half-published briefing.
        const res = await fetch(`/api/admin/briefing?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "save-asset",
            assetKey: row.key,
            url: result.url,
            size: file.size,
            durationMs,
          }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) {
          setNote(`✕ Uploaded, but could not publish it — ${json.error ?? res.status}`);
          return;
        }
        setNote(
          `✓ ${row.label} published${durationMs ? ` · ${formatDuration(durationMs)}` : ""}. Screens pick it up within about 15 seconds and download it once.`,
        );
        onChanged();
      } catch (err) {
        setNote(`✕ Upload failed${err instanceof Error ? ` — ${err.message}` : ""}`);
      } finally {
        setBusyKey(null);
        setProgress((p) => {
          const next = { ...p };
          delete next[row.key];
          return next;
        });
      }
    },
    [token, onChanged],
  );

  const remove = useCallback(
    async (row: AssetRow) => {
      if (!window.confirm(`Remove ${row.label}? Screens fall back to the sizing board.`)) return;
      setBusyKey(row.key);
      try {
        const res = await fetch(`/api/admin/briefing?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "delete-asset", assetKey: row.key }),
        });
        if (res.ok) {
          setNote(`✓ ${row.label} removed.`);
          onChanged();
        }
      } finally {
        setBusyKey(null);
      }
    },
    [token, onChanged],
  );

  return (
    <section
      style={{
        marginTop: 28,
        border: `1px solid ${PORTAL_DARK.border}`,
        background: PORTAL_DARK.card,
        borderRadius: 10,
        padding: 20,
        maxWidth: 860,
      }}
    >
      <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>Briefing room files</h2>
      <p style={{ color: PORTAL_DARK.muted, fontSize: 13, marginTop: 6 }}>
        Used by any screen set to <strong>Briefing room</strong>. Each player downloads a file once
        and replays it from its own disk, so a new upload costs one download per room and nothing
        after that. Large files are fine — upload from a wired PC if you can.
      </p>

      {note && (
        <div
          role="status"
          style={{
            margin: "14px 0",
            padding: "10px 14px",
            borderRadius: 8,
            border: `1px solid ${PORTAL_DARK.border}`,
            fontSize: 13,
          }}
        >
          {note}
        </div>
      )}

      <div style={{ display: "grid", gap: 14, marginTop: 12 }}>
        {ROWS.map((row) => (
          <AssetSlot
            key={row.key}
            row={row}
            url={currentUrl(row.key)}
            durationMs={currentDuration(row.key)}
            progress={progress[row.key]}
            busy={busyKey === row.key}
            disabled={busyKey !== null && busyKey !== row.key}
            onPick={(file) => void handleFile(row, file)}
            onRemove={() => void remove(row)}
          />
        ))}
      </div>
    </section>
  );
}

function AssetSlot({
  row,
  url,
  durationMs,
  progress,
  busy,
  disabled,
  onPick,
  onRemove,
}: {
  row: AssetRow;
  url: string | null;
  durationMs: number | null;
  progress: number | undefined;
  busy: boolean;
  disabled: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div
      style={{
        border: `1px solid ${PORTAL_DARK.border}`,
        borderRadius: 8,
        padding: 14,
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>{row.label}</strong>
        <span
          style={{
            fontSize: 12,
            padding: "2px 10px",
            borderRadius: 999,
            border: `1px solid ${url ? "#14532d" : PORTAL_DARK.border}`,
            color: url ? "#4ade80" : PORTAL_DARK.muted,
          }}
        >
          {url ? "uploaded" : "not uploaded"}
        </span>
        {durationMs != null && (
          <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
            {formatDuration(durationMs)}
          </span>
        )}
      </div>

      <p style={{ fontSize: 12, color: PORTAL_DARK.muted, margin: 0 }}>{row.hint}</p>

      {busy && (
        <div style={{ display: "grid", gap: 4 }}>
          <div
            style={{
              height: 8,
              borderRadius: 999,
              background: "rgba(255,255,255,0.1)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progress ?? 0}%`,
                height: "100%",
                background: "#4ade80",
                transition: "width 200ms linear",
              }}
            />
          </div>
          <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
            Uploading… {progress ?? 0}% — keep this tab open.
          </span>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          ref={inputRef}
          type="file"
          accept={row.accept}
          style={{ display: "none" }}
          aria-label={row.label}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onPick(file);
            // Reset so picking the same filename twice still fires a change.
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy || disabled}
          style={slotBtn}
        >
          {url ? "Replace…" : "Upload…"}
        </button>
        {url && (
          <>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              style={{ ...slotBtn, lineHeight: "1.9" }}
            >
              Open
            </a>
            <button
              type="button"
              onClick={onRemove}
              disabled={busy || disabled}
              style={{ ...slotBtn, color: "#f87171", borderColor: "#7f1d1d" }}
            >
              Remove
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────────────────────── */

type VideoProbe =
  | { ok: true; durationMs: number; width: number; height: number }
  | {
      ok: false;
      reason: "undecodable" | "no-video-track" | "no-duration" | "no-frame" | "timeout";
    };

/**
 * Can this browser actually decode this file, and how long is it?
 *
 * THE POINT IS THE VIDEO TRACK, not the container. Three distinct failures get
 * distinguished, because the fix differs for each and a staff member holding a
 * 900 MB file deserves to be told which one they have:
 *
 *   - `undecodable`     the engine refused it outright. ProRes, or a codec Edge
 *                       has no decoder for.
 *   - `no-video-track`  metadata loaded but the picture is 0×0. Classic HEVC on
 *                       a machine without the paid Microsoft extension, and the
 *                       nastiest case, because it would have "uploaded fine" and
 *                       then played as a black rectangle on the wall.
 *   - `no-duration`     no readable length. The room timeline is derived from
 *                       duration, so this cannot be waved through.
 *
 * `videoWidth` is the load-bearing assertion: it is only non-zero once a frame
 * has genuinely been decoded.
 */
function readVideoMeta(file: File): Promise<VideoProbe> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const el = document.createElement("video");
    let settled = false;
    const done = (value: VideoProbe) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(objectUrl);
      el.removeAttribute("src");
      resolve(value);
    };
    // `metadata` is not enough. A QuickTime container holding HEVC parses fine and
    // reports width, height and duration — and then paints BLACK on a player with no
    // HEVC decoder, which is exactly what reached the Blue room (owner 2026-08-11:
    // "in blue I'm getting briefing starting then it blacks out… that's a .mov").
    // Metadata proved the container was readable, never that a frame could be
    // decoded. So load enough to seek, then require an actual decoded frame.
    el.preload = "auto";
    el.muted = true;

    el.onloadedmetadata = () => {
      if (!el.videoWidth || !el.videoHeight) return done({ ok: false, reason: "no-video-track" });
      if (!Number.isFinite(el.duration) || el.duration <= 0) {
        return done({ ok: false, reason: "no-duration" });
      }
      // Seek a little way in: frame 0 of a film is often a black fade, which would
      // make a legitimate file look undecodable.
      try {
        el.currentTime = Math.min(2, el.duration / 4);
      } catch {
        /* not seekable — the readyState check below still has to pass */
      }
    };

    // A decoded frame has arrived and is drawable.
    const onDecodable = () => {
      if (el.readyState < 2) return; // HAVE_CURRENT_DATA
      done({
        ok: true,
        durationMs: Math.round(el.duration * 1000),
        width: el.videoWidth,
        height: el.videoHeight,
      });
    };
    el.onseeked = onDecodable;
    el.onloadeddata = onDecodable;
    el.onerror = () => done({ ok: false, reason: "undecodable" });
    // No frame within the window ⇒ the container parses but the codec does not
    // decode. That is the HEVC case, and it raises no error event at all, so a
    // timeout IS the signal rather than a fallback.
    setTimeout(() => {
      done(
        el.videoWidth && el.readyState >= 2
          ? {
              ok: true,
              durationMs: Math.round(el.duration * 1000),
              width: el.videoWidth,
              height: el.videoHeight,
            }
          : { ok: false, reason: el.videoWidth ? "no-frame" : "timeout" },
      );
    }, 30_000);
    el.src = objectUrl;
  });
}

/** Say what is wrong AND what to do about it — this is the message that decides
 *  whether a staff member can fix it themselves. */
function describeVideoFailure(reason: string, file: File): string {
  const isMov = /\.mov$/i.test(file.name);
  const reencode =
    "Export it as MP4 / H.264 and try again" +
    (isMov
      ? " — a .MOV is fine in itself, but only when what is inside it is H.264, not ProRes or HEVC."
      : ".");
  switch (reason) {
    case "no-video-track":
      return `This browser loaded the file but cannot decode its picture — almost always HEVC, which Edge will not play without a paid extension. It would upload and then show black on the wall. ${reencode}`;
    case "no-frame":
      return `The file opens and reports its size, but no actual picture could be decoded — the classic HEVC-in-a-.MOV case. It would have uploaded happily and then played BLACK in the briefing room. ${reencode}`;
    case "undecodable":
      return `This browser cannot play that file at all — most likely ProRes or another editing codec. ${reencode}`;
    case "no-duration":
      return `That file has no readable length, and the briefing rooms time the helmet board off the video's length. ${reencode}`;
    case "timeout":
      return "Gave up reading that file (30s). If it is on a network drive, copy it locally first and retry.";
    default:
      return `Could not verify that video. ${reencode}`;
  }
}

/** A readable, collision-free pathname. The store adds its own random suffix. */
function fileSlug(key: BriefingAssetKey, filename: string): string {
  const base = key.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const ext = (filename.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  // A video always lands as .mp4 whatever it arrived as, so the store's own
  // extension-based type inference agrees with the contentType above rather than
  // fighting it. The bytes are untouched — only the name and the header.
  if (key.startsWith("briefing-video:")) return `${base}.mp4`;
  return `${base}.${ext}`;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

const slotBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: `1px solid ${PORTAL_DARK.border}`,
  background: "transparent",
  color: PORTAL_DARK.fg,
  fontSize: 13,
  cursor: "pointer",
  textDecoration: "none",
};

/** Re-exported so the parent page can render the slots without importing the
 *  key list twice. */
export { BRIEFING_ASSET_KEYS };
