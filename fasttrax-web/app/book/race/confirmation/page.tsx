"use client";

import { useEffect } from "react";

/**
 * Legacy race confirmation page — redirects to the shared /book/confirmation.
 * Preserves all URL params (billId, billIds, racerNames, personIds, transactionId, etc.)
 */
export default function RaceConfirmationRedirect() {
  useEffect(() => {
    const params = window.location.search;
    window.location.replace(`/book/confirmation${params}`);
  }, []);

  return (
    <div className="min-h-screen bg-[#000418] flex items-center justify-center">
      <div className="w-10 h-10 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
    </div>
  );
}
