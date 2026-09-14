/**
 * The Sales CRM's OWN web app manifest.
 *
 * Owner, 2026-09-14: "create the pwa app on my list with icon recommend
 * installing it when going into the page." Reps live on their phones and the
 * browser chrome costs roughly a third of the screen on a board that is
 * already columns-in-a-row.
 *
 * SEPARATE FROM `app/manifest.ts`, which serves the marketing sites. Installing
 * from the CRM must give a CRM app: its own name, its own icon, and a
 * `start_url` that lands on My Day rather than the HeadPinz home page. A
 * manifest is also what decides what an install IS — same file, different
 * answer per brand, so this cannot be folded into that one.
 *
 * A ROUTE HANDLER, not Next's `manifest.ts` convention: that convention is
 * root-only, and this manifest has to live under `/admin/crm` so its `scope`
 * can be the CRM and nothing else. Scope matters — with the site's scope, a tap
 * on any headpinz.com link from the installed app would stay inside the CRM
 * window.
 *
 * NOT CACHED AT THE EDGE. `/admin/*` is behind the SSO gate and a manifest is
 * fetched with credentials; a shared cache entry here would be a small way to
 * leak which tools exist. It is a few hundred bytes.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const manifest = {
    id: "/admin/crm",
    name: "HeadPinz Sales CRM",
    // What actually shows under the icon on a home screen. Anything longer
    // than about 12 characters is truncated by both platforms.
    short_name: "Sales CRM",
    description: "Group-event sales: leads, the pipeline, contracts and the day's events.",
    // My Day, not the board: a rep opening the app wants what they owe today.
    start_url: "/admin/crm/today?src=pwa",
    scope: "/admin/crm",
    display: "standalone",
    orientation: "portrait-primary",
    // The shell's own ground and accent, so the splash and the status bar match
    // the app rather than flashing white before it paints.
    background_color: "#0b1220",
    theme_color: "#0b1220",
    categories: ["business", "productivity"],
    icons: [
      { src: "/admin/crm/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/admin/crm/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Android crops a maskable icon to the launcher's shape; the artwork is
      // full-bleed with everything important inside the middle 60% so the trim
      // never eats it.
      { src: "/admin/crm/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "My Day",
        url: "/admin/crm/today?src=pwa",
        icons: [{ src: "/admin/crm/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Pipeline",
        url: "/admin/crm/pipeline?src=pwa",
        icons: [{ src: "/admin/crm/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Lead queue",
        url: "/admin/crm/queue?src=pwa",
        icons: [{ src: "/admin/crm/icon-192.png", sizes: "192x192" }],
      },
    ],
  };

  return new Response(JSON.stringify(manifest), {
    headers: {
      "content-type": "application/manifest+json",
      "cache-control": "no-store",
    },
  });
}
