import type { Metadata } from "next";
import { AccountPage } from "~/components/features/account";

export const metadata: Metadata = {
  title: "Your Account",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AccountPage />;
}
