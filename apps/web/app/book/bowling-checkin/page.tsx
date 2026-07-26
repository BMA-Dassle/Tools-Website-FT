import BowlingCheckin from "@/components/bowling/BowlingCheckin";

/**
 * FastTrax duckpin standalone check-in, served on fasttraxent.com under /book
 * (not /hp) so the duckpin confirmation's "Check In" button keeps the guest on
 * the FastTrax domain. The /hp check-in route cross-domain-redirects off
 * fasttraxent.com (and that redirect dropped the ?neonId=, which produced
 * "Invalid reservation link"). Renders the SAME shared BowlingCheckin as
 * HeadPinz — it reads ?neonId= and self-brands via BrandNav from the host. A
 * distinct hyphenated path (not /book/bowling/checkin) so it never hits the
 * HeadPinz /book/bowling/* → /hp rewrite.
 */
export default function DuckpinCheckinPage() {
  return <BowlingCheckin />;
}
