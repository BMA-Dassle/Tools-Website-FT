"use client";

import "./styles/crm.css";

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type LazyExoticComponent,
  type ReactNode,
} from "react";
import { ADMIN_SANS, PORTAL_SKIN_CSS } from "~/components/features/admin-skin/theme";
import { baThemeCss } from "~/components/features/reservations-admin/theme";
import { CRM_BASE, TEST_IDS, type PublicCrmUser } from "~/features/crm/core/contracts";
import { SCREEN_META, canViewScreen, isScreenId } from "~/features/crm/core/nav";
import { SCREENS, type ScreenComponent } from "~/features/crm/core/screens";
import { SCREEN_IDS, type ScreenId } from "~/features/crm/core/types";
import {
  CrmContext,
  type CrmContextValue,
  type SheetSpec,
  type ToastKind,
} from "./lib/crm-context";
import { createCrmFetch } from "./lib/crm-fetch";
import { useCrmTheme } from "./lib/theme";
import { LoadingState } from "./primitives/States";
import { BottomTabs } from "./shell/BottomTabs";
import { useBadgeCounts } from "./shell/badges";
import { NotForYourRole } from "./shell/NotForYourRole";
import { NotFound } from "./shell/NotFound";
import { Sheet } from "./shell/Sheet";
import { Sidebar } from "./shell/Sidebar";
import { Toast } from "./shell/Toast";
import { Topbar } from "./shell/Topbar";
import { hrefFor, isScreenReady } from "./shell/nav-links";

/**
 * The CRM's client root (brief §3.7, §1.5): the admin skin, the ported shell
 * (sidebar · topbar · content · bottom tabs), the in-app router, and the
 * services every screen reaches through context.
 *
 * What the pages and the Playwright proof depend on, and must survive any
 * later edit:
 *   - props: `token` (the signed 8 h API credential the page minted — it lives
 *     in context only, never in a URL or storage), `user` (PublicCrmUser),
 *     `view` (URL segments after `/admin/crm`), `initialSearch`;
 *   - the root `<div data-testid={TEST_IDS.app} data-ba-theme className="portal-skin crm-root">`;
 *   - routing: `view[0] ?? "today"` through `SCREENS` with `React.lazy`; an
 *     unknown id → in-app NotFound; a director-only id for a rep →
 *     `TEST_IDS.notForRole` — always HTTP 200, never Next's 404;
 *   - `TEST_IDS.sidebar / navGroup / navItem / bottomTabs / screen / themeToggle / toast`.
 *
 * Theme: dark by default, toggled in the sidebar footer, remembered in
 * `localStorage("crm.theme")` through `useCrmTheme` (an external store, so no
 * set-state-in-effect and no hydration mismatch). Overlays (sheet, drawer,
 * toast) render as SIBLINGS of the shell at this root — never inside a
 * transformed ancestor.
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
 * change. `React.lazy` does not call the loader until first render.
 */
const LAZY_SCREENS = Object.fromEntries(SCREEN_IDS.map((id) => [id, lazy(SCREENS[id])])) as Record<
  ScreenId,
  LazyExoticComponent<ScreenComponent>
>;

/** Where the topbar's back arrow points for the prototype's "back" screens. */
const BACK_HREF: Partial<Record<ScreenId, (view: string[]) => string>> = {
  deal: () => hrefFor("pipeline"),
  account: () => hrefFor("history"),
  goals: () => hrefFor("kpi"),
  availability: (view) => (view[0] ? `${CRM_BASE}/deal/${view[0]}` : hrefFor("pipeline")),
  builder: (view) => (view[0] ? `${CRM_BASE}/deal/${view[0]}` : hrefFor("pipeline")),
};

const TOAST_MS = 2600;

interface ToastState {
  text: string;
  kind: ToastKind;
}

export default function CrmApp(props: CrmAppProps) {
  const { token, user, view, initialSearch } = props;

  // ---- hooks above every early return (react-hooks/rules-of-hooks) ----
  const [theme, setTheme] = useCrmTheme();
  const [toastState, setToastState] = useState<ToastState | null>(null);
  const [sheet, setSheet] = useState<SheetSpec | null>(null);
  const [overlayRoot, setOverlayRoot] = useState<HTMLElement | null>(null);
  const [topbarSlot, setTopbarSlot] = useState<HTMLElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const crmFetch = useMemo(() => createCrmFetch(token), [token]);
  const badges = useBadgeCounts(crmFetch, user.role);

  const toast = useCallback((text: string, kind: ToastKind = "ok") => {
    setToastState({ text, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastState(null), TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const openSheet = useCallback((spec: SheetSpec) => setSheet(spec), []);
  const closeSheet = useCallback(() => setSheet(null), []);

  const ctx = useMemo<CrmContextValue>(
    () => ({ token, user, crmFetch, toast, openSheet, closeSheet, overlayRoot, topbarSlot }),
    [token, user, crmFetch, toast, openSheet, closeSheet, overlayRoot, topbarSlot],
  );

  // ---- routing ----
  const requested = view[0] ?? "today";
  const known = isScreenId(requested);
  const screenId: ScreenId = known ? requested : "today";
  const allowed = known && canViewScreen(user.role, screenId);
  const Screen = LAZY_SCREENS[screenId];
  const rest = view.slice(1);
  const title = known ? SCREEN_META[screenId].title : "Not found";
  const sub =
    known && allowed && isScreenReady(screenId) ? SCREEN_META[screenId].description : undefined;
  const backHref = known ? BACK_HREF[screenId]?.(rest) : undefined;
  const activeId: ScreenId | null = known ? screenId : null;

  let body: ReactNode;
  if (!known) {
    body = <NotFound requested={requested} />;
  } else if (!allowed) {
    body = <NotForYourRole screen={screenId} />;
  } else {
    body = (
      <section data-testid={TEST_IDS.screen(screenId)} className="stack" style={{ gap: 16 }}>
        <Suspense fallback={<LoadingState />}>
          <Screen screen={screenId} view={rest} query={initialSearch} />
        </Suspense>
      </section>
    );
  }

  return (
    <div
      data-testid={TEST_IDS.app}
      data-ba-theme={theme}
      className="portal-skin crm-root"
      style={{ fontFamily: ADMIN_SANS, minHeight: "100vh" }}
    >
      {/* Theme CSS variables — static strings built from module constants. */}
      <style dangerouslySetInnerHTML={{ __html: baThemeCss(theme) + PORTAL_SKIN_CSS }} />
      <CrmContext.Provider value={ctx}>
        <div className="shell">
          <Sidebar
            user={user}
            activeId={activeId}
            badges={badges}
            theme={theme}
            onTheme={setTheme}
          />
          <div className="main">
            <Topbar
              title={title}
              sub={sub}
              backHref={backHref}
              user={user}
              theme={theme}
              onTheme={setTheme}
              actionsRef={setTopbarSlot}
            />
            <div className="content">{body}</div>
            <BottomTabs user={user} activeId={activeId} badges={badges} />
          </div>
        </div>
        {/* Overlays: siblings of the shell, inside the themed root. */}
        <div className="overlay-root" ref={setOverlayRoot} />
        {sheet ? (
          <Sheet
            open
            title={sheet.title}
            icon={sheet.icon}
            wide={sheet.wide}
            foot={sheet.foot}
            testId={sheet.testId}
            onClose={closeSheet}
          >
            {sheet.body}
          </Sheet>
        ) : null}
        {toastState ? <Toast text={toastState.text} kind={toastState.kind} /> : null}
      </CrmContext.Provider>
    </div>
  );
}
