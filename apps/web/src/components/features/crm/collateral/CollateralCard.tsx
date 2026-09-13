"use client";

import { IconEdit, IconEye, IconFile, IconLink, IconTrash } from "@tabler/icons-react";
import type { CollateralItem } from "~/features/crm/collateral/contracts";
import { COLLATERAL_TEST_IDS } from "~/features/crm/collateral/contracts";
import { Chip } from "../primitives/Chip";
import { Pill } from "../primitives/Pill";
import { ICON } from "../primitives/icon-props";
import { collateralCardModel } from "./model";

/**
 * One tile in the library grid, ported from `crm-shared.js:483`: the file
 * glyph, the New chip or the share count, the title, the meta line, the tags,
 * then Copy link · Preview.
 *
 * Differences from the prototype, all of them because this one is real:
 *   · "Preview" is a real link to the stored file, opened in a new tab, so it
 *     is an `<a>` and not a button — a middle-click has to work;
 *   · the prototype's third button ("Editing in PowerPoint online") is not
 *     here: nothing behind it exists, and a screen is done when every action
 *     on it works;
 *   · a file whose season has passed carries an Expired chip. Sharing last
 *     autumn's pricing is the mistake this library exists to prevent, so the
 *     state is on the tile, not buried in an edit sheet.
 *
 * Icon-only controls carry an `aria-label` (R13); the card itself is not
 * clickable, so there is no nested-interactive problem.
 */
export interface CollateralCardProps {
  item: CollateralItem;
  todayYmd: string;
  now: Date;
  canEdit: boolean;
  busy: boolean;
  onShare: (item: CollateralItem) => void;
  onEdit: (item: CollateralItem) => void;
  onArchive: (item: CollateralItem) => void;
}

export function CollateralCard({
  item,
  todayYmd,
  now,
  canEdit,
  busy,
  onShare,
  onEdit,
  onArchive,
}: CollateralCardProps) {
  const model = collateralCardModel(item, todayYmd, now);

  return (
    <div className="card" data-testid={COLLATERAL_TEST_IDS.card(item.id)}>
      <div className="pad stack">
        <div className="hstack between">
          <span className="avatar" style={{ background: "var(--card2)", color: "var(--muted)" }}>
            <IconFile {...ICON} />
          </span>
          {model.isNew ? (
            <Chip kind="open">New</Chip>
          ) : (
            <span className="xs muted">{model.sharesLabel}</span>
          )}
        </div>

        <div className="strong">{item.title}</div>
        <div className="xs muted">{model.meta}</div>

        {model.validityLabel || item.archivedAt ? (
          <div className="hstack">
            {item.archivedAt ? <Chip kind="lost">Archived</Chip> : null}
            {model.validityLabel ? (
              <Chip kind={model.validity === "expired" ? "warn" : "open"}>
                {model.validityLabel}
              </Chip>
            ) : null}
          </div>
        ) : null}

        {item.tags.length > 0 ? (
          <div className="hstack">
            {item.tags.map((t) => (
              <Pill key={t}>{t}</Pill>
            ))}
          </div>
        ) : null}

        <div className="hstack">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onShare(item)}
            disabled={busy || Boolean(item.archivedAt)}
          >
            <IconLink {...ICON} /> Copy link
          </button>
          <a
            className="btn btn-sm"
            href={item.blobUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Preview ${item.title}`}
          >
            <IconEye {...ICON} />
          </a>
          {canEdit ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onEdit(item)}
                disabled={busy}
                aria-label={`Edit ${item.title}`}
              >
                <IconEdit {...ICON} />
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onArchive(item)}
                disabled={busy}
                aria-label={item.archivedAt ? `Restore ${item.title}` : `Archive ${item.title}`}
              >
                <IconTrash {...ICON} />
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
