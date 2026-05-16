"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useState, type ReactNode } from "react";

/**
 * React Query provider for v2 booking surfaces.
 *
 * Scoped to `/book/**\/v2` routes via the `(v2)` route group layout so
 * v1 pages incur zero SSR / hydration cost. Defaults per the v2
 * conventions in tasks/restructure-plan.md § React Query:
 *
 *   staleTime: 30s        — most server reads are cheap to refetch but
 *                           we don't want stampedes on tab focus.
 *   retry: 1              — one retry, then surface the error. Network
 *                           glitches recover; real errors should be visible.
 *   refetchOnWindowFocus: false  — admin pages refetched on every tab
 *                           switch felt noisy; can opt in per-query.
 *
 * Devtools mount only when NODE_ENV !== "production". They add ~50KB
 * gzipped and only matter for engineers.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  // Create the client ONCE per mount — calling new QueryClient() inline on
  // every render would discard the cache. useState's lazy init runs the
  // factory exactly once, even under Strict Mode double-invoke.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      {children}
      {process.env.NODE_ENV !== "production" && (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-right" />
      )}
    </QueryClientProvider>
  );
}
