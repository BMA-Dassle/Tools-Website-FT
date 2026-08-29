import { notFound, redirect } from "next/navigation";
import { adminToolUrl } from "~/lib/helpers/admin-url";

/**
 * Portal-URL-scheme parity: the employee portal deep-linked event details at
 * /management/operations/daily-events/{projectId}. This stub keeps that
 * shape working on the website by redirecting to the board's ?event= modal
 * deep link (forwarding location/date hints).
 */

export const dynamic = "force-dynamic";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token, projectId } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();
  if (!/^-?\d{1,20}$/.test(projectId)) notFound();

  const sp = await searchParams;
  const location = typeof sp.location === "string" ? sp.location : "";
  const date = typeof sp.date === "string" ? sp.date : "";

  // Clean shell URL — see the sibling shim: a tokened redirect() target is a
  // browser-visible copy of the permanent admin secret.
  redirect(adminToolUrl("daily-events-v2", { event: projectId, location, date }));
}
