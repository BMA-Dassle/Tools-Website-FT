import { notFound, redirect } from "next/navigation";
import { dailyEventsV2Path } from "@/app/admin/_tools/daily-events/AdminToolPage";
import type { AdminToolQuery } from "@/app/admin/_tools/query";

/**
 * Portal-URL-scheme parity: the employee portal deep-linked event details at
 * `/management/operations/daily-events/{projectId}`. This stub keeps that shape
 * working on the website by redirecting to the board's `?event=` modal deep
 * link (forwarding location/date hints).
 *
 * THE IMPLEMENTATION, ONCE — the sibling of `AdminToolPage` in this directory,
 * and shared for the same reason: `/admin/{token}/daily-events/{projectId}` and
 * `/admin/daily-events/{projectId}` must forward identically or a deep link
 * behaves differently depending on which URL the staff member had saved.
 *
 * `projectId` is validated as digits before it reaches a URL builder. It is a
 * BMI project id, so it is compared and forwarded as TEXT and never parsed:
 * these ids exceed `Number.MAX_SAFE_INTEGER` and `Number()` silently rounds
 * them (see tasks/lessons.md § BMI ID Precision).
 */
export default async function AdminEventDetailPage({
  projectId,
  query,
}: {
  projectId: string;
  query: AdminToolQuery;
  // `Promise<never>` for the same reason as the sibling shim: `redirect()` and
  // `notFound()` both return `never`, and a component that returns `void` is
  // not a valid JSX element type.
}): Promise<never> {
  if (!/^-?\d{1,20}$/.test(projectId)) notFound();

  const location = typeof query.location === "string" ? query.location : "";
  const date = typeof query.date === "string" ? query.date : "";

  // Clean, SAME-ORIGIN staff path — see the sibling shim for both halves: a
  // tokened redirect() target is a browser-visible copy of the permanent admin
  // secret, and a cross-origin one throws away the session the visitor just
  // signed in for and charges them a second Microsoft round-trip.
  redirect(dailyEventsV2Path({ event: projectId, location, date }));
}
