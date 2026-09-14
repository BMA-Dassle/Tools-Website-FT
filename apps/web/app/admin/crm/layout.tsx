import type { Metadata } from "next";
import { QueryProvider } from "~/context/QueryProvider";

/**
 * Scopes React Query to the CRM. There is no QueryProvider anywhere under
 * `/admin` today and `useQuery` throws without one; mirrors
 * `app/(account)/layout.tsx` minus the brand nav (the admin gate's
 * `x-admin-route` header already strips site chrome and Clarity).
 */
/**
 * The CRM installs as its OWN app, not as the marketing site.
 *
 * `manifest` overrides the root layout's `/manifest.webmanifest`, which serves
 * HeadPinz or FastTrax depending on host — installing from here has to give a
 * CRM app with a CRM icon that opens on My Day.
 *
 * `appleWebApp` is not a duplicate of it: iOS ignores the manifest entirely
 * and reads these tags, so without them an iPhone saves a screenshot of the
 * page under the site's name.
 */
export const metadata: Metadata = {
  manifest: "/admin/crm/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Sales CRM",
    statusBarStyle: "black-translucent",
  },
  icons: {
    apple: [{ url: "/admin/crm/icon-180.png", sizes: "180x180" }],
    icon: [{ url: "/admin/crm/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
};

export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}
