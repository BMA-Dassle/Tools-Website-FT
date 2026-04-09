import { redirect } from "next/navigation";
import redis from "@/lib/redis";

export const dynamic = "force-dynamic";

export default async function ShortUrlRedirect({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const url = await redis.get(`short:${code}`);

  if (!url) {
    redirect("/");
  }

  redirect(url);
}
