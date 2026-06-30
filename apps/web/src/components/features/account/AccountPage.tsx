"use client";

import type { CSSProperties } from "react";
import { useMe } from "~/features/account/hooks";
import { BRAND_ACCENT } from "~/features/account/brand";
import Spinner from "~/components/ui/Spinner";
import { useBrand } from "./useBrand";
import LoginFlow from "./LoginFlow";
import DashboardTabs from "./DashboardTabs";

/**
 * Entry point for /account. Single page with an internal auth gate: `useMe`
 * decides login-vs-dashboard (no redirect flicker). Sets the per-brand accent.
 */
export default function AccountPage() {
  const me = useMe();
  const brand = useBrand();
  const accentStyle = { "--account-accent": BRAND_ACCENT[brand] } as CSSProperties;

  return (
    <main style={accentStyle} className="mx-auto w-full max-w-3xl px-4 pb-24">
      {me.isLoading ? (
        <div className="flex justify-center py-24 text-white/60">
          <Spinner label="Loading your account" />
        </div>
      ) : me.data?.authenticated ? (
        <DashboardTabs me={me.data} />
      ) : (
        <LoginFlow />
      )}
    </main>
  );
}
