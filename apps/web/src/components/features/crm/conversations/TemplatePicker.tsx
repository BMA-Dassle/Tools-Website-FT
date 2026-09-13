"use client";

import { useQuery } from "@tanstack/react-query";
import { smsKeys } from "~/features/crm/sms/queries";
import { SMS_TEST_IDS } from "~/features/crm/sms/types";
import { useCrmFetch } from "../lib/use-crm-user";
import { fetchTemplates } from "./queries";

/**
 * The template strip (`tpl-row`, crm-shared.js:330): one button per SMS
 * template, which fills the composer with the MERGED body.
 *
 * The merge happens SERVER-SIDE (`/api/admin/crm/templates?key=`), so the text
 * a rep sees is the text that will be sent — including the GSM-7 normalisation
 * the service would apply anyway. A token we could not fill stays visible
 * (`{{contract.link}}`) and the button's tooltip names it, so nothing goes out
 * with a hole in it that nobody noticed.
 */
export function TemplatePicker({
  conversationKey,
  disabled,
  onPick,
}: {
  conversationKey: string;
  disabled?: boolean;
  onPick: (text: string) => void;
}) {
  const crmFetch = useCrmFetch();
  const q = useQuery({
    queryKey: smsKeys.templates("sms", conversationKey),
    queryFn: () => fetchTemplates(crmFetch, { kind: "sms", key: conversationKey }),
    staleTime: 5 * 60_000,
  });

  const templates = q.data?.templates ?? [];
  if (templates.length === 0) return null;

  return (
    <div className="tpl-row" data-testid={SMS_TEST_IDS.templatePicker}>
      {templates.map((t) => (
        <button
          key={t.id}
          type="button"
          className="btn btn-sm"
          disabled={disabled}
          title={
            t.missing.length > 0
              ? `Fill in: ${t.missing.map((m) => `{{${m}}}`).join(", ")}`
              : undefined
          }
          onClick={() => onPick(t.rendered)}
        >
          {t.name}
        </button>
      ))}
    </div>
  );
}
