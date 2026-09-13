import { adminPoppins } from "~/components/features/admin-skin/font";
import CrmApp from "~/components/features/crm/CrmApp";
import { publicUser, requireCrmUser } from "~/features/crm/core/identity";
import { ensureCrmSchema } from "~/features/crm/core/schema";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * The Sales CRM — the ONE server component behind `/admin/crm` and
 * `/admin/crm/[...view]`.
 *
 * `requireCrmUser()` is the page's gate (brief §3.3): the middleware already
 * refused anyone without an `access` session, and this asks the STRICTER
 * question — does the session carry `sales` or `sales-director`? — 404ing
 * everyone else, the same opaque answer `requireSsoAdmin()` gives. The user it
 * returns is projected through `publicUser()` before it reaches the client: no
 * DIDs, chat ids, Office usernames or the SSO subject.
 *
 * The token handed to the client is the SIGNED 8-hour API credential
 * (`mintAdminApiToken`), never `ADMIN_CAMERA_TOKEN`; the client sends it back
 * as `x-admin-token` and every `/api/admin/crm/*` handler re-checks it AND the
 * session (`withCrmRoute`). Pinned by scripts/check-admin-token-leak.mjs.
 *
 * Unlike the other `_tools` modules this one is rendered by ONE route family
 * only: the `[token]/crm` shim never renders it (it cannot know who acted) and
 * 307s to `/admin/crm` instead.
 */

export type PageQuery = Record<string, string | string[] | undefined>;

/** First value per key — what the client keeps in its URL state. */
export function flattenQuery(query: PageQuery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (typeof first === "string") out[k] = first;
  }
  return out;
}

export default async function AdminToolPage({ view, query }: { view: string[]; query: PageQuery }) {
  // The tool's own tables, created and seeded on first use (brief §3.8). This
  // is the ONLY path that runs on a plain page load: crons never fire on a
  // preview, and a rep cannot press "Run job". Without it a fresh database
  // renders an empty Statuses screen and resolves every signed-in rep to
  // `rep: null`. Memoised per process, so this is one pass, not one per view.
  //
  // It never fails the page: the schema is infrastructure, and every screen
  // already renders its own empty state. A failure is logged and the shell
  // still comes up — a sign-in that 500s teaches a rep nothing.
  await ensureCrmSchema().catch((err: unknown) => {
    console.error("[crm] ensureCrmSchema failed on page load", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const user = await requireCrmUser();
  const apiToken = await mintAdminApiToken();

  return (
    <div className={adminPoppins.variable}>
      <CrmApp
        token={apiToken}
        user={publicUser(user)}
        view={view}
        initialSearch={flattenQuery(query)}
      />
    </div>
  );
}
