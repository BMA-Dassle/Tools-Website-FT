"use client";

/**
 * Render-crash guard around the event-detail body — port of the portal's
 * DetailErrorBoundary (ReservationDetailPage.tsx). BMI detail payloads are
 * loosely shaped; a bad field must degrade to a red panel, not a white page.
 */
import { Component, type ReactNode } from "react";

export default class DetailErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }

  static getDerivedStateFromError(err: Error) {
    return { hasError: true, error: err.message || "Unknown render error" };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            backgroundColor: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 8,
            padding: 16,
            color: "#f87171",
            fontSize: "0.875rem",
          }}
        >
          Failed to display event details: {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}
