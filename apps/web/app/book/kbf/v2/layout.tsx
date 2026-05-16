import { QueryProvider } from "~/context/QueryProvider";

/**
 * KBF v2 layout — its own QueryProvider scope (mirrors the [activity]/v2
 * layout). KBF lives outside the [activity] dynamic segment because it has
 * a distinct SEO surface, legal/COPPA story, and brand pinning (HeadPinz only).
 */
export default function KbfV2Layout({ children }: { children: React.ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}
