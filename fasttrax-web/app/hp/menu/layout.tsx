import type { Metadata } from "next";
import HeadPinzNav from "@/components/headpinz/Nav";
import HeadPinzFooter from "@/components/headpinz/Footer";

export const metadata: Metadata = {
  title: "Menu - Nemo's Sports Bistro | HeadPinz",
  description:
    "Full menu for Nemo's Sports Bistro at HeadPinz. Shareables, wings, burgers, flatbreads, entrees, and a full bar. Dine-in or order from the lanes.",
  keywords: [
    "Nemo's Sports Bistro menu",
    "HeadPinz food",
    "bowling alley food",
    "restaurant Fort Myers",
    "sports bar Fort Myers",
    "HeadPinz dining",
  ],
  openGraph: {
    title: "Menu - Nemo's Sports Bistro | HeadPinz",
    description:
      "Shareables, wings, burgers, flatbreads, entrees, and a full bar at Nemo's Sports Bistro.",
    type: "website",
    url: "https://headpinz.com/menu",
  },
  alternates: {
    canonical: "https://headpinz.com/menu",
  },
};

export default function MenuLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <HeadPinzNav />
      <div>{children}</div>
      <HeadPinzFooter />
    </>
  );
}
