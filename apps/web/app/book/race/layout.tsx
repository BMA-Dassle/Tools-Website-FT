import type { Metadata } from "next";
import { headers } from "next/headers";

export async function generateMetadata(): Promise<Metadata> {
  const hdrs = await headers();
  const isHeadPinz = hdrs.get("x-brand") === "headpinz";

  // Don't index racing pages on headpinz.com
  if (isHeadPinz) {
    return {
      title: "Book a Race | FastTrax",
      robots: { index: false, follow: false },
    };
  }

  return {
    title: "Book a Race | FastTrax",
  };
}

export default function RaceBookLayout({ children }: { children: React.ReactNode }) {
  return children;
}
