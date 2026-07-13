"use client";

/**
 * Food-out time panel — faithful port of the portal's EventMetadataPanel.tsx.
 *
 * Same behavior: GET the metadata row on mount; auto-POST AI extraction once
 * when the loaded row isn't manually set (one-shot ref, reset when the
 * project/date changes — the server returns a manual row untouched when one
 * exists); pencil-edit with a forgiving time parser, Enter/Escape keys,
 * quick-pick half-hour slots; AI (purple) / Manual (blue) source chip with
 * the portal's tooltip text.
 *
 * Visual translation only: shadcn Button/Input → styled natives on `--ba-*`
 * vars (board idiom).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INPUT_STYLE } from "~/components/features/reservations-admin/theme";
import {
  extractEventMetadata,
  fetchEventMetadata,
  saveEventMetadata,
} from "~/features/daily-events/api";
import { buildTimeSlots, parseTime } from "~/features/daily-events/food-time";
import type { EventMetadata, ProjectLog } from "~/features/daily-events/types";
import { Spinner } from "../badges";

const CARD_STYLE: React.CSSProperties = {
  backgroundColor: "var(--ba-bg2)",
  border: "1px solid var(--ba-border)",
  borderRadius: 12,
  padding: 16,
};

const SMALL_BTN: React.CSSProperties = {
  borderRadius: 6,
  fontSize: "0.72rem",
  fontWeight: 600,
  padding: "5px 10px",
  cursor: "pointer",
  background: "none",
};

export default function EventMetadataPanel({
  token,
  projectId,
  locationId,
  eventDate,
  startTime,
  eventName,
  persons,
  logs,
  onFoodOutTimeChange,
}: {
  token: string;
  projectId: string;
  locationId: number;
  eventDate: string;
  startTime: string;
  eventName: string;
  persons: number;
  logs: ProjectLog[];
  onFoodOutTimeChange?: (time: string | null) => void;
}) {
  const [metadata, setMetadata] = useState<EventMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const extractTriggered = useRef(false);

  const timeSlots = useMemo(() => buildTimeSlots(startTime), [startTime]);

  // GET the metadata row (portal parity: reset the one-shot extraction
  // trigger whenever the project/date identity changes).
  useEffect(() => {
    if (!projectId || !locationId || !eventDate) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    extractTriggered.current = false;

    fetchEventMetadata(token, projectId, locationId, eventDate)
      .then((data) => {
        if (!cancelled) setMetadata(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load metadata");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, projectId, locationId, eventDate]);

  // Lift the current food-out value to the detail view (used for print).
  const hasMetadata = metadata != null;
  const foodOutTime = metadata?.foodOutTime ?? null;
  useEffect(() => {
    if (hasMetadata) onFoodOutTimeChange?.(foodOutTime);
  }, [hasMetadata, foodOutTime, onFoodOutTimeChange]);

  const triggerExtraction = useCallback(async () => {
    setExtracting(true);
    setError(null);

    const notesText = logs
      .map((l) => l.memo || "")
      .filter(Boolean)
      .join("\n---\n");

    try {
      const data = await extractEventMetadata(token, projectId, locationId, eventDate, {
        eventName: eventName || "",
        startTime: startTime || "",
        persons: persons || 0,
        notes: notesText,
      });
      setMetadata(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "AI extraction failed");
    } finally {
      setExtracting(false);
    }
  }, [token, projectId, locationId, eventDate, eventName, startTime, persons, logs]);

  // Auto-extract once when the loaded row isn't manually set (portal parity;
  // the server returns a manual row untouched when one exists).
  useEffect(() => {
    if (loading || extracting || extractTriggered.current) return;
    if (!metadata) return;
    if (metadata.foodOutSource === "manual") return;

    extractTriggered.current = true;
    void triggerExtraction();
  }, [metadata, loading, extracting, triggerExtraction]);

  const handleSave = async (overrideValue?: string) => {
    const raw = overrideValue ?? editValue;
    setValidationError(null);

    let normalizedTime: string | null = null;
    if (raw.trim()) {
      normalizedTime = parseTime(raw);
      if (!normalizedTime) {
        setValidationError('Invalid time format. Try "4:30 PM" or "16:30".');
        return;
      }
    }

    setSaving(true);
    setError(null);

    try {
      const data = await saveEventMetadata(token, projectId, locationId, eventDate, normalizedTime);
      setMetadata(data);
      setEditing(false);
      setEditValue("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const startEditing = () => {
    setEditValue(metadata?.foodOutTime || "");
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setEditValue("");
    setValidationError(null);
  };

  if (loading) {
    return (
      <div style={CARD_STYLE}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: "0.875rem",
            color: "var(--ba-muted)",
          }}
        >
          <Spinner size={16} />
          Loading event data...
        </div>
      </div>
    );
  }

  if (extracting) {
    return (
      <div style={CARD_STYLE}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: "0.875rem",
            color: "var(--ba-muted)",
          }}
        >
          <Spinner size={16} />
          <span>Analyzing event notes...</span>
        </div>
      </div>
    );
  }

  const hasFoodTime = metadata?.foodOutTime != null;
  const isAI = metadata?.foodOutSource === "ai";
  const isManual = metadata?.foodOutSource === "manual";

  return (
    <section>
      <div
        style={{
          fontSize: "0.72rem",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--ba-muted)",
          marginBottom: 8,
        }}
      >
        Event Data
      </div>
      <div style={CARD_STYLE}>
        {error && (
          <div style={{ fontSize: "0.75rem", color: "#f87171", marginBottom: 8 }}>{error}</div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <span style={{ fontSize: "1.125rem", flexShrink: 0 }} title="Food Out Time">
              &#127869;
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: "0.75rem", color: "var(--ba-muted)", marginBottom: 2 }}>
                Food Out Time
              </div>
              {editing ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="text"
                      value={editValue}
                      onChange={(e) => {
                        setEditValue(e.target.value);
                        setValidationError(null);
                      }}
                      placeholder="e.g. 4:30 PM"
                      // eslint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                      style={{
                        ...INPUT_STYLE,
                        padding: "0.25rem 0.5rem",
                        width: 128,
                        height: 32,
                        ...(validationError ? { borderColor: "rgba(239,68,68,0.5)" } : {}),
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleSave();
                        if (e.key === "Escape") {
                          // Cancel the edit only — don't let Escape bubble to
                          // the modal backdrop and close the whole modal.
                          e.stopPropagation();
                          cancelEditing();
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void handleSave()}
                      disabled={saving}
                      style={{
                        ...SMALL_BTN,
                        border: "1px solid rgba(96,165,250,0.4)",
                        color: "#60a5fa",
                        ...(saving ? { opacity: 0.5, cursor: "default" } : {}),
                      }}
                    >
                      {saving ? "..." : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEditing}
                      style={{
                        ...SMALL_BTN,
                        border: "1px solid transparent",
                        color: "var(--ba-muted)",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                  {validationError && (
                    <div style={{ fontSize: "0.75rem", color: "#f87171" }}>{validationError}</div>
                  )}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {timeSlots.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => void handleSave(t)}
                        disabled={saving}
                        style={{
                          fontSize: 11,
                          padding: "2px 6px",
                          backgroundColor: "var(--ba-muted2)",
                          border: "1px solid var(--ba-border)",
                          borderRadius: 4,
                          color: "var(--ba-muted)",
                          cursor: "pointer",
                          ...(saving ? { opacity: 0.5, cursor: "default" } : {}),
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {hasFoodTime ? (
                    <span style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--ba-fg)" }}>
                      {metadata?.foodOutTime}
                    </span>
                  ) : (
                    <span
                      style={{
                        fontSize: "0.875rem",
                        color: "var(--ba-muted)",
                        fontStyle: "italic",
                      }}
                    >
                      No food timing found
                    </span>
                  )}
                  {metadata?.foodOutSource && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "1px 6px",
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 500,
                        backgroundColor: isAI ? "rgba(168,85,247,0.2)" : "rgba(59,130,246,0.2)",
                        color: isAI ? "#c084fc" : "#60a5fa",
                      }}
                      title={
                        isAI
                          ? `AI (${metadata.foodOutConfidence || "unknown"} confidence)${
                              metadata.foodOutReasoning ? ": " + metadata.foodOutReasoning : ""
                            }`
                          : "Manually set"
                      }
                    >
                      {isAI ? "AI" : isManual ? "Manual" : ""}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {!editing && (
            <button
              type="button"
              onClick={startEditing}
              title="Edit food out time"
              aria-label="Edit food out time"
              style={{
                flexShrink: 0,
                padding: 6,
                background: "none",
                border: "none",
                color: "var(--ba-muted)",
                cursor: "pointer",
                borderRadius: 6,
              }}
            >
              <svg
                style={{ width: 16, height: 16 }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
