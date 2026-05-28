import { headers } from "next/headers";
import RacePackFlow from "~/components/features/booking/RacePackFlow";

export default async function RacePackV2Page() {
  const hdrs = await headers();
  const brand = (hdrs.get("x-brand") as "fasttrax" | "headpinz") || "fasttrax";
  return <RacePackFlow brand={brand} />;
}
