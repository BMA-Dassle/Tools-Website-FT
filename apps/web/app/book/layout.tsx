import type { Metadata } from "next";
import { headers } from "next/headers";
import { FASTTRAX_OG, HEADPINZ_OG } from "@/lib/seo";

export async function generateMetadata(): Promise<Metadata> {
  const hdrs = await headers();
  const isHeadPinz = hdrs.get("x-brand") === "headpinz";

  if (isHeadPinz) {
    return {
      title: "Book Online | HeadPinz",
      description:
        "Book bowling, laser tag, gel blasters, shuffleboard and more at HeadPinz Fort Myers & Naples.",
      openGraph: {
        title: "Book Online | HeadPinz",
        description: "Book bowling, laser tag, gel blasters, shuffleboard and more at HeadPinz.",
        type: "website",
        images: [...HEADPINZ_OG],
      },
    };
  }

  return {
    title: "Book Online | FastTrax",
    description:
      "Book go-kart racing, duckpin bowling, shuffleboard and more at FastTrax Fort Myers.",
    openGraph: {
      title: "Book Online | FastTrax",
      description:
        "Book go-kart racing, duckpin bowling, shuffleboard and more at FastTrax Fort Myers.",
      type: "website",
      images: [...FASTTRAX_OG],
    },
  };
}

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return children;
}
