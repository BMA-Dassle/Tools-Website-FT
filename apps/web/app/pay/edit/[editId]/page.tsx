import type { Metadata } from "next";
import PayEditClient from "./PayEditClient";

/**
 * Self-hosted payment-difference page (reservation edits).
 *
 * Staff send this link when an edit increases the price and no card is on
 * file (or it declined). Token-gated ?t= HMAC; serves BOTH brand domains
 * (middleware lists /pay/ as a shared top-level route — no /hp rewrite).
 * The page renders OUR Square Web Payments form (components/square/
 * PaymentForm) in tokenize mode and completes the pending edit via
 * POST /api/edit-payments/[editId].
 */

export const metadata: Metadata = {
  title: "Complete Your Reservation Update",
  robots: { index: false, follow: false },
};

export default async function PayEditPage(ctx: {
  params: Promise<{ editId: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { editId } = await ctx.params;
  const { t } = await ctx.searchParams;
  return <PayEditClient editId={editId} token={t ?? ""} />;
}
