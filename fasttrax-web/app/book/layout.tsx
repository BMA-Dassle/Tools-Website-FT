import type { Metadata } from "next";
import { headers } from "next/headers";

export async function generateMetadata(): Promise<Metadata> {
  const hdrs = await headers();
  const isHeadPinz = hdrs.get("x-brand") === "headpinz";

  if (isHeadPinz) {
    return {
      title: {
        default: "Book Online | HeadPinz",
        template: "%s | HeadPinz",
      },
      description: "Book bowling, laser tag, gel blasters, shuffleboard and more at HeadPinz Fort Myers & Naples.",
      openGraph: {
        title: "Book Online | HeadPinz",
        description: "Book bowling, laser tag, gel blasters, shuffleboard and more at HeadPinz.",
        type: "website",
      },
    };
  }

  return {
    title: {
      default: "Book Online | FastTrax Entertainment",
      template: "%s | FastTrax Entertainment",
    },
    description: "Book go-kart racing, duckpin bowling, shuffleboard and more at FastTrax Fort Myers.",
    openGraph: {
      title: "Book Online | FastTrax Entertainment",
      description: "Book go-kart racing, duckpin bowling, shuffleboard and more at FastTrax Fort Myers.",
      type: "website",
    },
  };
}

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return children;
}
