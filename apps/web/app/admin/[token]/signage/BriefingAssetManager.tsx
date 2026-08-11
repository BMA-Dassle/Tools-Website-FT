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
    hint: "The full safety briefing. Plays for Starter sessions — and for Pro sessions too, which have no film of their own.",
    accept: "video/mp4",
    kind: "video",
  },
  {
    key: "briefing-video:intermediate",
    label: "Intermediate briefing video",
    hint: "The shorter briefing for racers who have been out before.",
    accept: "video/mp4",
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
        // Length first: if the browser cannot read the file's metadata it is not
        // a video this player will be able to decode either, so failing here
        // saves a ten-minute upload of an unusable file.
        let durationMs: number | null = null;
        if (row.kind === "video") {
          durationMs = await readVideoDurationMs(file);
          if (durationMs == null) {
            setNote(
              "✕ Could not read that video's length. It needs to be an MP4 (H.264) — re-encode it and try again.",
            );
            return;
          }
        }

        const result = await upload(`briefing/${fileSlug(row.key, file.name)}`, file, {
          access: "public",
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

/**
 * A video's length, read from the file itself.
 *
 * Resolves null rather than throwing for anything the browser cannot decode —
 * which is also the check that catches the most likely bad upload: an HEVC file
 * straight off a phone or a GoPro, which Edge cannot play without a paid
 * extension and would otherwise fail silently on the wall.
 */
function readVideoDurationMs(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const el = document.createElement("video");
    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(objectUrl);
      resolve(value);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () =>
      done(Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration * 1000) : null);
    el.onerror = () => done(null);
    // A file the browser will not even open metadata for must not hang the form.
    setTimeout(() => done(null), 15_000);
    el.src = objectUrl;
  });
}

/** A readable, collision-free pathname. The store adds its own random suffix. */
function fileSlug(key: BriefingAssetKey, filename: string): string {
  const base = key.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const ext = (filename.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
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
