"use client";

import { useRef, useState } from "react";
import CardCaptureForm, { type CardCaptureHandle } from "@/components/square/CardCaptureForm";
import Modal from "~/components/ui/Modal";
import Button from "~/components/ui/Button";
import ErrorBox from "~/components/ui/ErrorBox";
import { AccountApiError } from "~/features/account/api";
import { buildVerificationDetails } from "@/lib/square-verification-details";
import { useAddCard, useChangeSubscriptionCard } from "~/features/account/hooks";
import type { AccountSubscription, SavedCard } from "~/features/account/types";

function tokenError(
  tok: Awaited<ReturnType<CardCaptureHandle["tokenize"]>> | undefined,
): string | null {
  if (tok && "error" in tok) return tok.error || "Could not read the card";
  if (!tok) return "Could not read the card";
  return null;
}

/** Standalone "add a card" — attaches to the primary bound customer (server-derived). */
export function AddCardModal({
  onClose,
  locationId,
}: {
  onClose: () => void;
  locationId?: string;
}) {
  const cardRef = useRef<CardCaptureHandle>(null);
  const addCard = useAddCard();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const tok = await cardRef.current?.tokenize(buildVerificationDetails({ intent: "STORE" }));
      const tErr = tokenError(tok);
      if (tErr || !tok || "error" in tok) {
        setError(tErr);
        return;
      }
      await addCard.mutateAsync({ cardToken: tok.token });
      onClose();
    } catch (e) {
      setError(e instanceof AccountApiError ? e.message : "Could not save the card");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Add a card" onClose={onClose}>
      <CardCaptureForm ref={cardRef} locationId={locationId} />
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} loading={saving}>
          Save card
        </Button>
      </div>
    </Modal>
  );
}

/** Change which saved card pays a subscription (existing card or a new one). */
export function ChangeCardModal({
  sub,
  cards,
  onClose,
}: {
  sub: AccountSubscription;
  cards: SavedCard[];
  onClose: () => void;
}) {
  const eligible = cards.filter((c) => c.customerId === sub.customerId);
  const defaultSel =
    sub.cardId && eligible.some((c) => c.id === sub.cardId && !c.expired)
      ? sub.cardId
      : (eligible.find((c) => !c.expired)?.id ?? "new");

  const [selected, setSelected] = useState<string>(defaultSel);
  const cardRef = useRef<CardCaptureHandle>(null);
  const addCard = useAddCard();
  const changeCard = useChangeSubscriptionCard();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      let cardId = selected;
      if (selected === "new") {
        const tok = await cardRef.current?.tokenize(buildVerificationDetails({ intent: "STORE" }));
        const tErr = tokenError(tok);
        if (tErr || !tok || "error" in tok) {
          setError(tErr);
          return;
        }
        const res = await addCard.mutateAsync({ cardToken: tok.token, forSubscriptionId: sub.id });
        cardId = res.card.id;
      }
      await changeCard.mutateAsync({ subscriptionId: sub.id, cardId });
      onClose();
    } catch (e) {
      setError(e instanceof AccountApiError ? e.message : "Could not update the card");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Change payment card" onClose={onClose}>
      <fieldset className="space-y-2">
        <legend className="sr-only">Choose a card for this subscription</legend>
        {eligible.map((c) => (
          <label
            key={c.id}
            className={`flex items-center gap-3 rounded-lg border border-white/10 px-3 py-2.5 text-sm ${
              c.expired ? "opacity-50" : "cursor-pointer hover:border-white/25"
            }`}
          >
            <input
              type="radio"
              name="acct-card"
              value={c.id}
              checked={selected === c.id}
              disabled={c.expired}
              onChange={() => setSelected(c.id)}
              className="accent-[color:var(--account-accent)]"
            />
            <span className="text-white/80">
              {c.brand} •••• {c.last4}
              {c.expired ? " (expired)" : ""}
            </span>
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-white/10 px-3 py-2.5 text-sm hover:border-white/25">
          <input
            type="radio"
            name="acct-card"
            value="new"
            checked={selected === "new"}
            onChange={() => setSelected("new")}
            className="accent-[color:var(--account-accent)]"
          />
          <span className="text-white/80">Use a new card</span>
        </label>
      </fieldset>

      {selected === "new" && (
        <div className="mt-3">
          <CardCaptureForm ref={cardRef} locationId={sub.locationId || undefined} />
        </div>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} loading={saving}>
          Save
        </Button>
      </div>
    </Modal>
  );
}
