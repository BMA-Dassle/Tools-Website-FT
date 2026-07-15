"use client";

import { useQuery, useMutation } from "@tanstack/react-query";
import { apiPost } from "./api";
import { gameCardKeys } from "./queries";
import type { VerifyResult, PurchaseResult } from "./types";
import type { PurchaseInput } from "./schemas";

/**
 * Read-only card lookup (exists + Tokens/Bonus/Time). Enabled once we have a
 * candidate account number (from the QR `?id` or typed entry).
 */
export function useCardBalance(accountNumber: string, locationCode?: number, enabled = true) {
  return useQuery({
    queryKey: gameCardKeys.verify(accountNumber),
    queryFn: () => apiPost<VerifyResult>("/api/game-cards/verify", { accountNumber, locationCode }),
    enabled: enabled && /^\d{1,19}$/.test(accountNumber),
    staleTime: 30_000,
    retry: false,
  });
}

/** Charge + load in one server round-trip. */
export function usePurchase() {
  return useMutation({
    mutationFn: (input: PurchaseInput) =>
      apiPost<PurchaseResult>("/api/game-cards/purchase", input),
  });
}
