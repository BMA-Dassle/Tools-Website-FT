"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "./api";
import { accountKeys } from "./queries";
import type { AccountSubscription, ContactType, SavedCard } from "./types";

export interface MeResponse {
  authenticated: boolean;
  contactMasked?: string;
  contactType?: ContactType;
  customerCount?: number;
  csrf?: string;
}

export interface SubscriptionsResponse {
  subscriptions: AccountSubscription[];
  cards: SavedCard[];
}

export interface RequestOtpResponse {
  ok: boolean;
  channel: "email" | "phone";
  maskedDestination: string;
}

export interface VerifyOtpResponse {
  ok: boolean;
  hasCustomers?: boolean;
  error?: string;
  attemptsLeft?: number;
}

export interface AddCardResponse {
  ok: boolean;
  card: { id: string; brand: string; last4: string; customerId: string };
}

export interface SetCardResponse {
  ok: boolean;
  subscription: { id: string; cardBrand: string | null; cardLast4: string | null; version: number };
}

function csrfOf(qc: QueryClient): string | undefined {
  return qc.getQueryData<MeResponse>(accountKeys.me)?.csrf;
}

export function useMe() {
  return useQuery({
    queryKey: accountKeys.me,
    queryFn: () => apiGet<MeResponse>("/api/account/session/me"),
  });
}

export function useSubscriptions(enabled: boolean) {
  return useQuery({
    queryKey: accountKeys.subscriptions,
    queryFn: () => apiGet<SubscriptionsResponse>("/api/account/subscriptions"),
    enabled,
  });
}

export function useRequestOtp() {
  return useMutation({
    mutationFn: (contact: string) =>
      apiPost<RequestOtpResponse>("/api/account/request-otp", { contact }),
  });
}

export function useVerifyOtp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { contact: string; code: string }) =>
      apiPost<VerifyOtpResponse>("/api/account/verify-otp", v),
    onSuccess: (data) => {
      if (data.ok) {
        qc.invalidateQueries({ queryKey: accountKeys.me });
        qc.invalidateQueries({ queryKey: accountKeys.subscriptions });
      }
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost("/api/account/logout"),
    onSuccess: () => {
      // Set the value (notifies observers → AccountPage re-renders to login)
      // rather than qc.clear(), which wipes the cache WITHOUT re-rendering
      // mounted queries — that left the dashboard on screen after logout.
      qc.setQueryData<MeResponse>(accountKeys.me, { authenticated: false });
      qc.removeQueries({ queryKey: accountKeys.subscriptions });
    },
  });
}

export function useAddCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      cardToken: string;
      verificationToken?: string;
      forSubscriptionId?: string;
    }) => apiPost<AddCardResponse>("/api/account/cards", v, csrfOf(qc)),
    onSuccess: () => qc.invalidateQueries({ queryKey: accountKeys.subscriptions }),
  });
}

export function useChangeSubscriptionCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { subscriptionId: string; cardId: string }) =>
      apiPost<SetCardResponse>(
        `/api/account/subscriptions/${encodeURIComponent(v.subscriptionId)}/card`,
        { cardId: v.cardId },
        csrfOf(qc),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: accountKeys.subscriptions }),
  });
}
