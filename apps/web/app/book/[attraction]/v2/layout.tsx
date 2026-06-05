import { QueryProvider } from "~/context/QueryProvider";

/**
 * v2 booking layout — wraps per-activity /v2 pages with QueryProvider.
 * Nav is rendered by the root layout — NOT duplicated here.
 */
export default function BookActivityV2Layout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <div className="min-h-screen pt-32 sm:pt-36">{children}</div>
    </QueryProvider>
  );
}
