"use client";

/**
 * Guest tab — contact person, waiver-registration status, and the attendee
 * list. Content lifted unchanged from the pre-tab DailyEventDetail body.
 */
import {
  DEFAULT_WAIVER_THRESHOLDS,
  WAIVER_RESOURCE_KEYWORDS,
} from "~/features/daily-events/constants";
import { personDisplayName } from "~/features/daily-events/format";
import { safe } from "~/features/daily-events/print-html";
import type { Person, ReservationDetail } from "~/features/daily-events/types";
import DetailSection from "../DetailSection";

export default function GuestTab({ detail }: { detail: ReservationDetail }) {
  const waiverThresholds = DEFAULT_WAIVER_THRESHOLDS;

  // Waiver Registration Warning (same detection as the pre-tab layout)
  const stateLC = (detail.state || "").toLowerCase();
  const resourceNames = (detail.schedules || []).map((s) => (s.resourceName || "").toLowerCase());
  const isWaiver =
    stateLC.includes("waiver") ||
    resourceNames.some((rn) => WAIVER_RESOURCE_KEYWORDS.some((kw) => rn.includes(kw)));
  const total = detail.persons || 0;
  const registered = Array.isArray(detail.persons_list) ? detail.persons_list.length : 0;

  let waiverPanel: React.ReactNode = null;
  if (isWaiver && total) {
    const pct = (registered / total) * 100;
    const color =
      pct < waiverThresholds.red ? "red" : pct <= waiverThresholds.yellow ? "yellow" : "green";
    const panel =
      color === "red"
        ? {
            backgroundColor: "rgba(239,68,68,0.15)",
            border: "1px solid rgba(239,68,68,0.4)",
            color: "#f87171",
          }
        : color === "yellow"
          ? {
              backgroundColor: "rgba(234,179,8,0.15)",
              border: "1px solid rgba(234,179,8,0.4)",
              color: "#facc15",
            }
          : {
              backgroundColor: "rgba(34,197,94,0.15)",
              border: "1px solid rgba(34,197,94,0.4)",
              color: "#4ade80",
            };
    const label =
      color === "red"
        ? "Low Registration"
        : color === "yellow"
          ? "Moderate Registration"
          : "Good Registration";
    waiverPanel = (
      <div style={{ ...panel, borderRadius: 12, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: "1.125rem" }}>
            {color === "red" ? "⚠️" : color === "yellow" ? "⚠" : "✅"}
          </span>
          <div>
            <div style={{ fontWeight: 600 }}>
              {label} — {registered} of {total} people registered ({Math.round(pct)}%)
            </div>
            <div style={{ fontSize: "0.75rem", opacity: 0.75, marginTop: 2 }}>
              {color === "red"
                ? `Less than ${waiverThresholds.red}% of expected attendees have registered waivers`
                : color === "yellow"
                  ? `Between ${waiverThresholds.red}-${waiverThresholds.yellow}% of expected attendees have registered waivers`
                  : `Over ${waiverThresholds.yellow}% of expected attendees have registered waivers`}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {waiverPanel}

      {/* Contact Person */}
      {detail.contactPerson && (
        <DetailSection id="contact" title="Contact Person">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontWeight: 500, color: "var(--ba-fg)", fontSize: "0.9rem" }}>
              {personDisplayName(detail.contactPerson) || "Unknown"}
            </div>
            {Array.isArray(detail.contactPerson.addresses) &&
              detail.contactPerson.addresses.map((addr, i) => {
                const email = safe(addr.email);
                const mobile = safe(addr.mobile);
                const phone = safe(addr.phone);
                const city = safe(addr.city);
                if (!email && !mobile && !phone && !city) return null;
                return (
                  <div
                    key={i}
                    style={{
                      fontSize: "0.875rem",
                      color: "var(--ba-muted)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}
                  >
                    {email && (
                      <div>
                        Email: <span style={{ color: "var(--ba-fg)" }}>{email}</span>
                      </div>
                    )}
                    {mobile && (
                      <div>
                        Mobile: <span style={{ color: "var(--ba-fg)" }}>{mobile}</span>
                      </div>
                    )}
                    {phone && (
                      <div>
                        Phone: <span style={{ color: "var(--ba-fg)" }}>{phone}</span>
                      </div>
                    )}
                    {city && (
                      <div>
                        City: <span style={{ color: "var(--ba-fg)" }}>{city}</span>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </DetailSection>
      )}

      {/* Persons */}
      {Array.isArray(detail.persons_list) && detail.persons_list.length > 0 ? (
        <DetailSection
          id="persons"
          title={`Persons (${detail.persons_list.length}${detail.persons ? ` / ${detail.persons}` : ""})`}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            {detail.persons_list.map((p: Person, i: number) => (
              <div
                key={safe(p.id) || safe(p.personId) || i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "6px 0",
                  borderTop: i > 0 ? "1px solid var(--ba-border)" : undefined,
                }}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    backgroundColor: "var(--ba-muted2)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "0.75rem",
                    fontWeight: 500,
                    color: "var(--ba-muted)",
                    flexShrink: 0,
                  }}
                >
                  {(safe(p.firstName) || "?")[0]}
                </div>
                <div>
                  <div style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--ba-fg)" }}>
                    {personDisplayName(p) || "Unknown"}
                  </div>
                  {safe(p.addresses?.[0]?.email) && (
                    <div style={{ fontSize: "0.75rem", color: "var(--ba-muted)" }}>
                      {safe(p.addresses?.[0]?.email)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </DetailSection>
      ) : (
        !detail.contactPerson && (
          <div style={{ fontSize: "0.85rem", color: "var(--ba-muted)" }}>
            No contact person or registered attendees on this event.
          </div>
        )
      )}
    </div>
  );
}
