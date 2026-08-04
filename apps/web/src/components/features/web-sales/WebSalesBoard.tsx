"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { ADMIN_SANS, PORTAL_BLUE, PORTAL_DARK, PORTAL_SKIN_CSS } from "~/components/features/admin-skin/theme";
import { usePortalAutoHeight } from "~/components/features/admin-skin/usePortalAutoHeight";
import { baThemeCss } from "~/components/features/reservations-admin/theme";
import {
  defaultRange,
  todayEasternYmd,
  type SaleDetail,
  type SaleSummary,
  type WebSaleRow,
} from "~/features/web-sales";
import FilterBar, { type SourceMeta } from "./FilterBar";
import SaleCardList from "./SaleCardList";
import SaleDetailDrawer from "./SaleDetailDrawer";
import SaleTable from "./SaleTable";
import SummaryCards from "./SummaryCards";
import WebSaleResendModal from "./modals/WebSaleResendModal";
import { isProblemRow } from "./format";
import { parseFilters, serializeFilters, toApiQuery, type BoardFilters } from "./filters";

/**
 * Responsive rules the inline-style components cannot express.
 *
 * The board is styled inline to match the reservations board, but a media query
 * has to be real CSS. Scoped under `.ws-board` so it cannot leak into the portal
 * iframe's host page.
 */
const BOARD_RESPONSIVE_CSS = `
  .ws-board .ws-desktop { display: none; }
  .ws-board .ws-mobile  { display: grid; }
  @media (min-width: 768px) {
    .ws-board .ws-desktop { display: block; }
    .ws-board .ws-mobile  { display: none; }
  }
`;

interface ApiResponse {
  ok: boolean;
  error?: string;
  detail?: string;
  range: { from: string; to: string };
  rows: WebSaleRow[];
  nextCursor: string | null;
  summary: SaleSummary;
  bySource: Array<{ source: string; label: string; summary: SaleSummary }>;
  sources: SourceMeta[];
  errors: Array<{ source: string; message: string }>;
}

export default function WebSalesBoard({
  token,
  initialSearch,
  embedded = false,
}: {
  token: string;
  /** Query string from the server component, so first paint matches the URL. */
  initialSearch: string;
  embedded?: boolean;
}) {
  const today = useMemo(() => todayEasternYmd(), []);
  const fallback = useMemo(() => defaultRange(), []);

  const [filters, setFilters] = useState<BoardFilters>(() =>
    parseFilters(new URLSearchParams(initialSearch), fallback),
  );
  const [rows, setRows] = useState<WebSaleRow[]>([]);
  const [summary, setSummary] = useState<SaleSummary | null>(null);
  const [bySource, setBySource] = useState<ApiResponse["bySource"]>([]);
  const [sources, setSources] = useState<SourceMeta[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sourceErrors, setSourceErrors] = useState<ApiResponse["errors"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  /** `?sale=deals:412` — deep-linkable, so a staff alert can point at one sale. */
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(
    () => new URLSearchParams(initialSearch).get("sale"),
  );
  const [resendTarget, setResendTarget] = useState<SaleDetail | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** Bumped after an action so the drawer refetches what it changed. */
  const [detailNonce, setDetailNonce] = useState(0);

  const anyOverlayOpen = selectedSaleId !== null || resendTarget !== null;

  // Modals are position:fixed and contribute nothing to scrollHeight, so the
  // portal iframe would collapse under one without this.
  usePortalAutoHeight("web-sales-resize", embedded, anyOverlayOpen);

  // The URL is the source of truth for filters, so a filtered board is linkable
  // and survives a reload. `replaceState` rather than a router push: typing in
  // the search box must not stack fifty history entries.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(serializeFilters(filters, fallback));
    // The open sale rides in the URL too, so a drawer can be linked directly —
    // which is what `notifyStaffDealSale` will point at.
    if (selectedSaleId) params.set("sale", selectedSaleId);
    const qs = params.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, "", next);
    }
  }, [filters, fallback, selectedSaleId]);

  /**
   * `filters` is a fresh object every render, so the fetch effect keys off a
   * STRING. Depending on the object would refetch on every keystroke-induced
   * re-render even when nothing that reaches the API changed.
   */
  const apiQuery = toApiQuery(filters, token);

  /**
   * Rebuilt whenever the query changes, which is safe for the poller:
   * `useVisibleInterval` stashes the newest callback in its own ref and keys its
   * effect on `(delayMs, enabled)` only, so a new identity is picked up on the
   * next tick without tearing down and re-arming the timer.
   */
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(`/api/admin/web-sales?${apiQuery}`, {
          signal,
          cache: "no-store",
        });
        const data = (await res.json()) as ApiResponse;
        if (signal?.aborted) return;
        if (!res.ok || !data.ok) throw new Error(data.detail || data.error || "Could not load sales.");
        setRows(data.rows);
        setSummary(data.summary);
        setBySource(data.bySource);
        setSources(data.sources);
        setNextCursor(data.nextCursor);
        setSourceErrors(data.errors);
        setError(null);
      } catch (err) {
        if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        setError(err instanceof Error ? err.message : "Could not load sales.");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [apiQuery],
  );

  // Debounced reload whenever anything that reaches the API changes. 250ms is
  // the same beat the videos board uses for its search box.
  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      void load(controller.signal);
    }, 250);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [apiQuery, load]);

  // Visibility-aware refresh. Paused while paging (a poll would wipe out rows
  // the operator just loaded) and while any overlay is open (the list must not
  // shift under a drawer someone is reading).
  useVisibleInterval(load, 30_000, !loadingMore && !anyOverlayOpen);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/admin/web-sales?${toApiQuery(filters, token, { cursor: nextCursor })}`,
        { cache: "no-store" },
      );
      const data = (await res.json()) as ApiResponse;
      if (!res.ok || !data.ok) throw new Error(data.detail || data.error || "Could not load more.");
      // Append, de-duplicating by id. The keyset should never hand back a row
      // twice, but a board that renders a duplicate sale is a support call and
      // the guard is one line.
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...data.rows.filter((r) => !seen.has(r.id))];
      });
      setNextCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more.");
    } finally {
      setLoadingMore(false);
    }
  }, [filters, nextCursor, token]);

  // "Needs attention" is derived from the projected row, not from any source's
  // native status vocabulary — so it filters here rather than in every adapter's
  // SQL, where the judgement would inevitably drift between sources.
  const visible = filters.problemsOnly ? rows.filter(isProblemRow) : rows;

  const themeStyle = baThemeCss("dark") + PORTAL_SKIN_CSS + BOARD_RESPONSIVE_CSS;

  return (
    <div
      data-ba-theme="dark"
      className="portal-skin ws-board"
      style={{
        minHeight: embedded ? undefined : "100vh",
        color: "var(--ba-fg)",
        fontFamily: ADMIN_SANS,
        padding: "1rem",
      }}
    >
      {/* Theme CSS variables — a static string built from module constants. */}
      <style dangerouslySetInnerHTML={{ __html: themeStyle }} />

      {!embedded && (
        <header style={{ marginBottom: 16 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Web sales</h1>
          <p style={{ fontSize: 13, color: PORTAL_DARK.muted, marginTop: 2 }}>
            Everything sold on the website that isn&apos;t a reservation
          </p>
        </header>
      )}

      <FilterBar
        filters={filters}
        sources={sources}
        todayYmd={today}
        busy={loading}
        onChange={setFilters}
        onRefresh={() => void load()}
        csvHref={`/api/admin/web-sales?${toApiQuery(filters, token, { format: "csv" })}`}
      />

      <div style={{ marginTop: 16 }}>
        {summary && (
          <SummaryCards
            summary={summary}
            bySource={bySource}
            problemsOnly={filters.problemsOnly}
            onToggleProblems={() => setFilters({ ...filters, problemsOnly: !filters.problemsOnly })}
          />
        )}
      </div>

      {error && (
        <div
          role="alert"
          style={{
            marginTop: 16,
            padding: 12,
            borderRadius: 10,
            fontSize: 13,
            color: "#fecaca",
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.35)",
          }}
        >
          {error}
        </div>
      )}

      {/* A source that failed is named, never silently dropped — otherwise a
          shorter list looks like a complete one. */}
      {sourceErrors.length > 0 && (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 10,
            fontSize: 13,
            display: "flex",
            gap: 8,
            color: "#fde68a",
            background: "rgba(245,158,11,0.1)",
            border: "1px solid rgba(245,158,11,0.35)",
          }}
        >
          <IconAlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden />
          <div>
            {sourceErrors.map((e) => (
              <div key={e.source}>
                <strong>{e.source}</strong> could not be read — these sales are missing from the list
                below. ({e.message})
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <div className="ws-desktop">
          <SaleTable rows={visible} onSelect={setSelectedSaleId} />
        </div>
        <div className="ws-mobile">
          <SaleCardList rows={visible} onSelect={setSelectedSaleId} />
        </div>

        {loading && rows.length === 0 && (
          <p style={{ padding: "40px 0", textAlign: "center", color: PORTAL_DARK.muted }}>Loading…</p>
        )}
        {!loading && visible.length === 0 && (
          <p style={{ padding: "40px 0", textAlign: "center", color: PORTAL_DARK.muted }}>
            {filters.problemsOnly && rows.length > 0
              ? "Nothing needs attention in this range."
              : "No sales in this range."}
          </p>
        )}

        {nextCursor && !filters.problemsOnly && (
          <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              style={{
                fontSize: 13,
                fontWeight: 600,
                padding: "9px 20px",
                borderRadius: 8,
                cursor: loadingMore ? "default" : "pointer",
                color: "#fff",
                background: PORTAL_BLUE,
                border: "none",
                opacity: loadingMore ? 0.6 : 1,
              }}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
        {/* Paging a client-side filter would silently hide matches on later
            pages, so say why the button is gone rather than just removing it. */}
        {nextCursor && filters.problemsOnly && (
          <p style={{ marginTop: 16, textAlign: "center", fontSize: 12, color: PORTAL_DARK.muted }}>
            More sales exist in this range. Clear &ldquo;Needs attention&rdquo; to page through them.
          </p>
        )}
      </div>

      {selectedSaleId && (
        <SaleDetailDrawer
          // Remount on a different sale or a forced refetch, so the drawer's
          // state starts clean without a setState in its effect body.
          key={`${selectedSaleId}:${detailNonce}`}
          saleId={selectedSaleId}
          token={token}
          refreshKey={detailNonce}
          supportedActions={
            sources.find((s) => s.id === selectedSaleId.split(":")[0])?.actions ?? []
          }
          onClose={() => setSelectedSaleId(null)}
          onAction={(action, detail) => {
            if (action === "resend") setResendTarget(detail);
          }}
        />
      )}

      {resendTarget && (
        <WebSaleResendModal
          detail={resendTarget}
          token={token}
          channels={
            sources.find((s) => s.id === resendTarget.row.source)?.resendChannels ?? ["email"]
          }
          onClose={() => setResendTarget(null)}
          onSent={(note) => {
            setToast(note);
            setTimeout(() => setToast(null), 5000);
            setDetailNonce((n) => n + 1);
            void load();
          }}
        />
      )}

      {toast && (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 20,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 60,
            maxWidth: "90vw",
            padding: "10px 18px",
            borderRadius: 10,
            fontSize: 13,
            color: "#bbf7d0",
            background: "rgba(20,60,40,0.96)",
            border: "1px solid rgba(34,197,94,0.4)",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
