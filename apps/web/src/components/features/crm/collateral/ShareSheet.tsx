"use client";

import { IconCheck, IconCopy, IconMail, IconMessage } from "@tabler/icons-react";
import { useState } from "react";
import type { CollateralItem, ShareLink } from "~/features/crm/collateral/contracts";
import { COLLATERAL_TEST_IDS, SHARE_DELIVERY_REASON } from "~/features/crm/collateral/contracts";
import { fStamp } from "~/features/crm/core/dates";
import { errorMessage } from "../lib/crm-fetch";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { collateralMessage } from "./model";

/**
 * "Share collateral" — the prototype's `attach-collateral` sheet
 * (`crm-shared.js:282`), made real.
 *
 * IT LIVES UNDER `collateral/`, NOT `components/crm/deal/`. The deal folder is
 * B3's; a sheet in it would collide on every rebase. The deal drawer opens
 * THIS component with a `lead` prop when B3 lands — the seam is the prop, not
 * the file's location.
 *
 * WHAT WORKS TODAY AND WHAT DOES NOT, stated on the sheet rather than implied:
 * "Copy link" mints a real tokenised link, writes `crm_share_links`, bumps the
 * file's share count and files a timeline row. Text and email are C1's and
 * C2's rails; their buttons are rendered DISABLED with the reason
 * `SHARE_DELIVERY_REASON` ("arrives with texting and email") rather than
 * hidden — a rep who cannot see the button assumes the CRM cannot do it, and
 * asks; a rep who sees it greyed with a reason knows it is coming.
 *
 * The clipboard write is best-effort: an iframe or a browser without
 * permission simply leaves the URL in a read-only input the rep can select, so
 * the link is never lost behind a failed copy.
 */
export interface ShareSheetProps {
  item: CollateralItem;
  /** A lead public id (`L-1042`) or numeric id when shared from a deal. */
  lead?: string | null;
  existing: ShareLink[];
  onCreate: (input: { collateralId: string; lead?: string | null }) => Promise<ShareLink>;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ShareSheet({ item, lead, existing, onCreate }: ShareSheetProps) {
  const [link, setLink] = useState<ShareLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const url = link?.url ?? "";

  const create = async () => {
    setPending(true);
    setError(null);
    try {
      const share = await onCreate({ collateralId: item.id, lead: lead ?? null });
      setLink(share);
      setCopied(await copyToClipboard(share.url));
    } catch (err) {
      setError(collateralMessage(errorMessage(err)));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="stack" data-testid={COLLATERAL_TEST_IDS.shareSheet}>
      <div className="opt">
        <span className="avatar sm" style={{ background: "var(--card2)", color: "var(--muted)" }}>
          <IconCopy {...ICON} />
        </span>
        <div>
          <div className="strong">{item.title}</div>
          <div className="why">
            {(item.centre ?? "All") + " · " + item.type}
            {lead ? ` · for ${lead}` : ""}
          </div>
        </div>
      </div>

      {error ? <Banner tone="crit">{error}</Banner> : null}

      {link ? (
        <div className="field">
          <label htmlFor="crm-share-url">Link · opens are tracked</label>
          <input id="crm-share-url" className="input" readOnly value={url} />
          <div className="xs muted">
            {copied ? "Copied to your clipboard. " : "Select the link above to copy it. "}
            {link.expiresAt ? `Stops working ${fStamp(link.expiresAt)}.` : ""}
          </div>
        </div>
      ) : null}

      <div className="hstack">
        <button type="button" className="btn btn-primary" onClick={create} disabled={pending}>
          {copied ? <IconCheck {...ICON} /> : <IconCopy {...ICON} />}{" "}
          {link ? "New link" : "Copy link"}
        </button>
        <button
          type="button"
          className="btn"
          disabled
          title={SHARE_DELIVERY_REASON}
          aria-label={`Text this file — ${SHARE_DELIVERY_REASON}`}
        >
          <IconMessage {...ICON} /> Text
        </button>
        <button
          type="button"
          className="btn"
          disabled
          title={SHARE_DELIVERY_REASON}
          aria-label={`Email this file — ${SHARE_DELIVERY_REASON}`}
        >
          <IconMail {...ICON} /> Email
        </button>
      </div>
      <div className="xs muted">Sending it straight to the guest {SHARE_DELIVERY_REASON}.</div>

      {existing.length > 0 ? (
        <div className="stack" style={{ gap: 6 }}>
          <div className="eyebrow">Earlier links</div>
          {existing.slice(0, 5).map((s) => (
            <div key={s.token} className="hstack between small">
              <span className="muted">{fStamp(s.createdAt)}</span>
              <span>
                {s.openCount === 0
                  ? "not opened yet"
                  : `${s.openCount} open${s.openCount === 1 ? "" : "s"}`}
                {s.expiredAt ? " · expired" : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
