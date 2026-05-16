import { QueryProvider } from "~/context/QueryProvider";

/**
 * v2 booking layout — wraps every per-activity /v2 page with the React
 * Query provider so hooks can read server state. Scope is intentionally
 * tight: only /book/[activity]/v2 routes pay the React Query cost.
 */
export default function BookActivityV2Layout({ children }: { children: React.ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}
