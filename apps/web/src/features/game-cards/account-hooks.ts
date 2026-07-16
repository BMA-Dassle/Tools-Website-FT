"use client";

import { useCallback, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "./account-api";

/**
 * Owns the reload page's signed-in layer: session, selected Square customer,
 * that customer's linked game cards + saved payment cards, and all the
 * mutations. One instance lives in ReloadFlow and is passed down, so the pay
 * step and the account panel share a single source of truth.
 */
export function useGameCardAccount() {
  const qc = useQueryClient();
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);

  const session = useQuery({
    queryKey: ["gc", "session"],
    queryFn: api.getGcSession,
    staleTime: 60_000,
    retry: false,
  });
  const csrf = session.data?.csrf;
  const authed = session.data?.authenticated === true;

  const myCards = useQuery({
    queryKey: ["gc", "my-cards", selectedCustomerId],
    queryFn: () => api.fetchMyCards(selectedCustomerId ?? undefined),
    enabled: authed,
    staleTime: 15_000,
    retry: false,
  });

  // Default the selected customer to the first once cards load.
  const effectiveCustomerId = selectedCustomerId ?? myCards.data?.customerId ?? null;

  const refreshCards = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["gc", "my-cards"] });
  }, [qc]);

  const requestOtp = useMutation({ mutationFn: (contact: string) => api.requestOtp(contact) });
  const verifyOtp = useMutation({
    mutationFn: (v: { contact: string; code: string }) => api.verifyOtp(v.contact, v.code),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gc", "session"] }),
  });
  const logout = useMutation({
    mutationFn: () => api.logout(csrf),
    onSuccess: () => {
      setSelectedCustomerId(null);
      qc.invalidateQueries({ queryKey: ["gc"] });
    },
  });
  const createAccount = useMutation({
    mutationFn: () => api.createRewardsAccount(csrf),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["gc", "session"] });
      refreshCards();
    },
  });
  const linkCard = useMutation({
    mutationFn: (accountNumber: string) =>
      api.linkCard({ customerId: effectiveCustomerId!, accountNumber }, csrf),
    onSuccess: refreshCards,
  });
  const unlinkCard = useMutation({
    mutationFn: (accountNumber: string) =>
      api.unlinkCard({ customerId: effectiveCustomerId!, accountNumber }, csrf),
    onSuccess: refreshCards,
  });
  const renameCard = useMutation({
    mutationFn: (v: { accountNumber: string; nickname: string }) =>
      api.renameCard({ customerId: effectiveCustomerId!, ...v }, csrf),
    onSuccess: refreshCards,
  });
  const removeSavedCard = useMutation({
    mutationFn: (cardId: string) =>
      api.disableSavedCard({ customerId: effectiveCustomerId!, cardId }, csrf),
    onSuccess: refreshCards,
  });

  return {
    session,
    authed,
    csrf,
    selectedCustomerId: effectiveCustomerId,
    setSelectedCustomerId,
    myCards,
    savedCards: myCards.data?.savedCards ?? [],
    gameCards: myCards.data?.gameCards ?? [],
    customerIds: myCards.data?.customerIds ?? [],
    counts: myCards.data?.counts ?? {},
    requestOtp,
    verifyOtp,
    logout,
    createAccount,
    linkCard,
    unlinkCard,
    renameCard,
    removeSavedCard,
  };
}

export type GameCardAccount = ReturnType<typeof useGameCardAccount>;
