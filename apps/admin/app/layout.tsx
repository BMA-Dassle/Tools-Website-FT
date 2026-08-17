import type { ReactNode } from "react";

/**
 * Required root layout. Practically unreachable: proxy.ts intercepts every
 * path — forwarding staff-tool URLs to the main deployment and 404ing the
 * rest — so no route here ever renders in normal operation.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
