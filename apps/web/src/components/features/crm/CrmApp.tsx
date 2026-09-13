"use client";

import { Suspense, lazy, type LazyExoticComponent } from "react";
import { ADMIN_SANS, PORTAL_SKIN_CSS } from "~/components/features/admin-skin/theme";
import { CRM_BASE, TEST_IDS, type PublicCrmUser } from "~/features/crm/core/contracts";
import {
  SCREEN_META,
  canViewScreen,
  isScreenId,
  navForRole,
  tabsForRole,
} from "~/features/crm/core/nav";
import { SCREENS, type ScreenComponent } from "~/features/crm/core/screens";
import { SCREEN_IDS, type ScreenId } from "~/features/crm/core/types";

/**
 * The CRM's client root — CONTRACT-STAGE STUB.
 *
 * The UI agent replaces this file with the ported shell (sidebar, topbar,
 * bottom tabs, sheet, drawer, toast, theme toggle, `styles/crm.css`). What is
 * fixed here and must survive that replacement, because the pages and the
 * Playwright proof depend on it:
 *
 *   - the props: `token`, `user` (PublicCrmUser), `view` (URL segments after
 *     `/admin/crm`), `initialSearch` (the query string at mount)
 *   - the root `<div data-testid={TEST_IDS.app} data-ba-theme className="portal-skin crm-root">`
 *   - routing: `view[0] ?? "today"` resolved through `SCREENS` with
 *     `React.lazy`; unknown id → in-app not-found; a director-only id for a rep
 *     → `TEST_IDS.notForRole`; never Next's 404
 *   - `TEST_IDS.sidebar` / `navGroup(id)` / `navItem(id)` / `bottomTabs` /
 *     `screen(id)` on the corresponding elements
 *
 * `token` is the signed 8-hour API credential the pages mint; the UI agent's
 * `lib/crm-fetch.ts` takes it from context. It is never `ADMIN_CAMERA_TOKEN`
 * (scripts/check-admin-token-leak.mjs scans this tree).
 */

export interface CrmAppProps {
  token: string;
  user: PublicCrmUser;
  view: string[];
  initialSearch: Record<string, string>;
}

/**
 * One lazy component per screen id, created ONCE at module scope — never in
 * render, where a fresh `lazy()` would remount the screen on every state
 * change. `React.lazy` does not call the loader until first render, so this
 * costs nothing for the nineteen screens a visit never opens.
 */
const LAZY_SCREENS = Object.fromEntries(SCREEN_IDS.map((id) => [id, lazy(SCREENS[id])])) as Record<
  ScreenId,
  LazyExoticComponent<ScreenComponent>
>;

function hrefFor(id: ScreenId): string {
  return id === "today" ? CRM_BASE : `${CRM_BASE}/${id}`;
}

export default function CrmApp(props: CrmAppProps) {
  const { user, view, initialSearch } = props;
  const requested = view[0] ?? "today";
  const known = isScreenId(requested);
  const screenId: ScreenId = known ? requested : "today";
  const allowed = known && canViewScreen(user.role, screenId);
  const Screen = LAZY_SCREENS[screenId];
  const title = known ? SCREEN_META[screenId].title : "Not found";

  return (
    <div
      data-testid={TEST_IDS.app}
      data-ba-theme="dark"
      className="portal-skin crm-root"
      style={{ fontFamily: ADMIN_SANS, minHeight: "100vh", display: "flex" }}
    >
      <style dangerouslySetInnerHTML={{ __html: PORTAL_SKIN_CSS }} />
      <aside
        data-testid={TEST_IDS.sidebar}
        aria-label="CRM navigation"
        style={{ width: 232, padding: 16, borderRight: "1px solid var(--ba-border)" }}
      >
        <div style={{ fontWeight: 700, marginBottom: 12 }}>
          Sales CRM
          <small style={{ display: "block", fontWeight: 400, color: "var(--ba-muted)" }}>
            HeadPinz · FastTrax
          </small>
        </div>
        <nav>
          {navForRole(user.role).map((group) => (
            <div key={group.id} data-testid={TEST_IDS.navGroup(group.id)}>
              {group.label ? (
                <div
                  style={{
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 0.6,
                    color: "var(--ba-muted)",
                    margin: "12px 0 4px",
                  }}
                >
                  {group.label}
                </div>
              ) : null}
              {group.items.map((item) => (
                <a
                  key={item.id}
                  data-testid={TEST_IDS.navItem(item.id)}
                  href={hrefFor(item.id)}
                  aria-current={item.id === screenId && known ? "page" : undefined}
                  style={{ display: "block", padding: "6px 8px", color: "inherit" }}
                >
                  {item.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div style={{ marginTop: 24, fontSize: 12, color: "var(--ba-muted)" }}>
          {user.name} · {user.role === "director" ? "Director" : "Sales"}
        </div>
      </aside>

      <main style={{ flex: 1, padding: 20, minWidth: 0 }}>
        <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>{title}</h1>
        {!known ? (
          <section data-testid={TEST_IDS.screen("not-found")}>
            <p>There is no screen called “{requested}”.</p>
            <a href={CRM_BASE}>Back to My Day</a>
          </section>
        ) : !allowed ? (
          <section data-testid={TEST_IDS.notForRole}>
            <p>This screen is for the sales director.</p>
            <a href={CRM_BASE}>Back to My Day</a>
          </section>
        ) : (
          <section data-testid={TEST_IDS.screen(screenId)}>
            <Suspense fallback={<p aria-busy="true">Loading…</p>}>
              <Screen screen={screenId} view={view.slice(1)} query={initialSearch} />
            </Suspense>
          </section>
        )}

        <nav data-testid={TEST_IDS.bottomTabs} aria-label="Quick tabs" style={{ marginTop: 24 }}>
          {tabsForRole(user.role).map((tab) => (
            <a key={tab.id} href={hrefFor(tab.id)} style={{ marginRight: 12, color: "inherit" }}>
              {tab.label}
            </a>
          ))}
        </nav>
      </main>
    </div>
  );
}
