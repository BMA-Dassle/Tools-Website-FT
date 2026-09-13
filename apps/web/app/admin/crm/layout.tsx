import { QueryProvider } from "~/context/QueryProvider";

/**
 * Scopes React Query to the CRM. There is no QueryProvider anywhere under
 * `/admin` today and `useQuery` throws without one; mirrors
 * `app/(account)/layout.tsx` minus the brand nav (the admin gate's
 * `x-admin-route` header already strips site chrome and Clarity).
 */
export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}
