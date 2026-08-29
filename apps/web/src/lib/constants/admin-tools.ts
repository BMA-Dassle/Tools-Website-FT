/**
 * The admin tool registry — the ONE place that answers "which staff tool is
 * behind Microsoft sign-in, and which is still opened by a token in the URL?".
 *
 * Everything that routes, gates or links an admin tool reads its list from
 * here: `middleware.ts`'s SSO branch, the admin-host routing table
 * (`~/features/sso/tools`), and the drift test that pins both lists against the
 * real route directories.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ADDING A TOOL TO SSO IS TWO EDITS. That is deliberate, and it is the point of
 * this file:
 *
 *   1. Move its slug from {@link TOKEN_ONLY_TOOLS} to {@link SSO_ADMIN_TOOLS}.
 *   2. Add `app/admin/<slug>/page.tsx` — three lines that `await
 *      requireSsoAdmin()` and render the same `app/admin/_tools/<slug>`
 *      component the `[token]` page already renders. (If the tool's page body
 *      still lives inside its `[token]/page.tsx`, extracting it into
 *      `_tools/<slug>/AdminToolPage.tsx` first is step 0 — see
 *      `_tools/reservations` for the shape.)
 *
 * MOVING ONE BACK IS THE SAME TWO EDITS IN REVERSE, and it happens — see
 * `camera-assign` below. Move the slug back to {@link TOKEN_ONLY_TOOLS}, delete
 * `app/admin/<slug>/` **and** the now single-consumer `_tools/<slug>/` module,
 * folding its body back into the `[token]` page. `_tools/` holds one directory
 * per SSO tool and nothing else; a module with one caller is indirection that
 * lies about having two.
 *
 * WHAT NEVER CHANGES EITHER WAY: `app/admin/[token]/<slug>/` stays. Every
 * `/admin/{ADMIN_CAMERA_TOKEN}/<tool>` URL keeps working for every tool on
 * every list — staff bookmarks, crons and Teams cards outlive any of these
 * decisions, and a token URL comes down only on an explicit owner "pull it".
 *
 * `admin-tools.test.ts` fails if you do one without the other, and fails if a
 * slug here does not name a real directory under `app/admin/[token]/`.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * The tools a HUMAN signs in to reach: `/admin/<tool>`, no credential in the
 * URL, a Microsoft session holding the `access` role is the credential.
 *
 * THE TEST OF MEMBERSHIP IS THE FURNITURE, NOT THE DATA. Every tool here is a
 * DESK tool: somebody is sitting at a keyboard they own, and an eight-hour
 * sign-in costs them one click a shift. That is a cheap price for taking the
 * credential out of the URL. Where the same click is paid standing at a kiosk
 * between heats, or on a screen nobody types on at all, it is not cheap and the
 * tool keeps its token.
 *
 * OWNER REVISION, 2026-08-28, after a shift on the shipped gate:
 *
 *   - `camera-assign` came OFF this list. It reads as a desk tool and is not
 *     one — it is worked TRACKSIDE, on shared kiosks, one per track, standing
 *     up between heats. A Microsoft sign-in there is a password typed on a
 *     kiosk in front of guests, on a device three people share, in the ninety
 *     seconds before the next heat goes out. It is back on
 *     `/admin/{ADMIN_CAMERA_TOKEN}/camera-assign` (and `/{track}`), where it
 *     was, and where it works.
 */
export const SSO_ADMIN_TOOLS: ReadonlySet<string> = new Set(["checkin", "reservations"]);

/**
 * UNATTENDED DEVICE SURFACES — these keep the token URL PERMANENTLY.
 *
 * OWNER DECISION, 2026-08-28. `pit` is the pit board and `briefing` is the
 * briefing-room wall tablet. Nobody signs in to either: they are screens that
 * are switched on and left running. An eight-hour Microsoft session on a
 * display no human touches means the board is blank every morning until
 * somebody walks over with a keyboard and a password — a daily outage bought
 * with no security, since the failure mode of a wall screen is "staff can't see
 * the heat list", not "a stranger read customer data".
 *
 * This resolves unresolved item #2 in tasks/admin-sso-lockdown.md, which
 * flagged exactly this for the briefing tablet and proposed hoping a cookie
 * would outlive a reboot. It won't, and it shouldn't have to.
 *
 * CONSEQUENCES FOR THE CUTOVER, so PR B cannot forget them:
 *   - PR B MUST NOT delete `app/admin/[token]/pit` or
 *     `app/admin/[token]/briefing`, and must not 308 them to an SSO route.
 *   - PR B MUST NOT rotate `ADMIN_CAMERA_TOKEN` into uselessness for these two
 *     without a device plan first: a device-scoped credential these screens can
 *     hold (a long-TTL signed token in the display's bookmark), rotatable on its
 *     own schedule and killable without touching staff access.
 */
export const DEVICE_TOKEN_TOOLS: ReadonlySet<string> = new Set(["pit", "briefing"]);

/**
 * Everything else: still reached at `/admin/{ADMIN_CAMERA_TOKEN}/<tool>`.
 *
 * Most are here because the migration is deliberately incremental, not because
 * they are special — they are candidates to move to SSO later, two edits at a
 * time.
 *
 * `camera-assign` is here for a REASON, and it is not "not yet". It shipped
 * behind SSO and came back on the owner's first shift with it (2026-08-28): the
 * tool is worked trackside on shared kiosks, standing up between heats, so a
 * per-person Microsoft sign-in is the wrong credential for it in the same way
 * it is wrong for a wall display — just for crowding and shared hardware rather
 * than for nobody being there. It is not a device tool either (a human does
 * work it, and rotating the token must not be blocked on a display plan), so it
 * lives here. Moving it back to SSO needs a new owner decision, not a tidy-up.
 */
export const TOKEN_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "api-docs",
  "camera-assign", // incl. the nested /[track] route — owner decision, see above
  "christmas-in-july",
  "daily-events",
  "daily-events-v2",
  "deals",
  "deposit-failures",
  "discount-codes",
  "e-tickets",
  "group-approvals",
  "group-functions",
  "healthnet",
  "kbf",
  "sales",
  "signage",
  "videos",
  "web-sales",
]);

/**
 * Every staff tool, however it is reached — the union of the three lists above,
 * and exactly the directory listing of `app/admin/[token]/`.
 *
 * This is what the admin host serves at clean URLs: `admin.fasttraxent.com/pit`
 * has to keep working across the shell's retirement, so the host router
 * recognises every slug and only the GATE differs by list.
 */
export const ADMIN_TOOL_SLUGS: ReadonlySet<string> = new Set([
  ...SSO_ADMIN_TOOLS,
  ...DEVICE_TOKEN_TOOLS,
  ...TOKEN_ONLY_TOOLS,
]);

/**
 * The reserved second segment of `/admin/*` that is NOT a tool: the portal's
 * HMAC-gated iframe surface. It must never be mistaken for an SSO tool slug —
 * the portal has no Microsoft session and would be bounced to a sign-in page
 * inside an iframe.
 */
export const ADMIN_EMBED_SEGMENT = "embed";

/** True when `<slug>` is reached by signing in rather than by a token URL. */
export function isSsoAdminTool(slug: string): boolean {
  return SSO_ADMIN_TOOLS.has(slug);
}

/** True when `<slug>` belongs to an unattended display that keeps its token. */
export function isDeviceTokenTool(slug: string): boolean {
  return DEVICE_TOKEN_TOOLS.has(slug);
}
