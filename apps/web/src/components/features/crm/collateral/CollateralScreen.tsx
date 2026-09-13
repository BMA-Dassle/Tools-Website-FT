"use client";

import { IconFile, IconPlus, IconUpload } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, lazy, useMemo, type ComponentType } from "react";
import { createPortal } from "react-dom";
import type {
  CollateralItem,
  MessageTemplate,
  ShareLink,
  TemplateUpsertInput,
} from "~/features/crm/collateral/contracts";
import { COLLATERAL_TEST_IDS } from "~/features/crm/collateral/contracts";
import {
  COLLATERAL_EXTRA_CARDS,
  COLLATERAL_EXTRA_CARD_IDS,
  type CollateralExtraCardProps,
} from "~/features/crm/collateral/extra-cards";
import { collateralKeys } from "~/features/crm/collateral/queries";
import { todayEasternYmd } from "~/features/crm/core/dates";
import type { ScreenProps } from "~/features/crm/core/screens";
import { errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import {
  useCrm,
  useCrmFetch,
  useCrmSheet,
  useCrmToast,
  useCrmUser,
  useTopbarSlot,
} from "../lib/use-crm-user";
import { Folders } from "../primitives/Folders";
import { ICON } from "../primitives/icon-props";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { CollateralCard } from "./CollateralCard";
import { ShareSheet } from "./ShareSheet";
import { TemplateEditor } from "./TemplateEditor";
import { TemplatesCard } from "./TemplatesCard";
import { UploadSheet } from "./UploadSheet";
import {
  collateralMessage,
  folderOptions,
  folderValue,
  selectionFromFolder,
  selectionFromQuery,
} from "./model";
import {
  createShareLink,
  fetchCollateral,
  fetchShares,
  fetchTemplates,
  postCollateral,
  postCollateralItem,
  postTemplates,
  uploadCollateralFile,
} from "./queries";

/**
 * `/admin/crm/collateral` — "Collateral & templates" (prototype
 * `crm-shared.js:481`): the folder strip, the file grid, the extra-card slots,
 * and the message templates.
 *
 * The filters live in the URL (§3.1), so `?centre=HPN` or `?tag=pricing` is a
 * link a director can paste into a chat and a rep lands on the same view.
 *
 * Reps share; directors curate. Upload, edit, archive and the template editor
 * are director-only — the library is guest-facing material, and a stale price
 * sheet reaching a guest is the failure this screen exists to prevent. Copy
 * link and Preview are everyone's.
 *
 * ONE lazy component per extra-card slot, created at MODULE scope for the same
 * reason `CrmApp` does it: a `lazy()` built in a render body remounts the card
 * on every keystroke elsewhere on the screen.
 */

interface ExtraCardEntry {
  id: string;
  Component: ComponentType<CollateralExtraCardProps>;
}

const EXTRA_CARD_COMPONENTS: ExtraCardEntry[] = COLLATERAL_EXTRA_CARD_IDS.flatMap((id) => {
  const load = COLLATERAL_EXTRA_CARDS[id];
  return load ? [{ id, Component: lazy(load) as ComponentType<CollateralExtraCardProps> }] : [];
});

export default function CollateralScreen({ query }: ScreenProps) {
  const { isDirector } = useCrmUser();
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const { openSheet, closeSheet } = useCrmSheet();
  const { token } = useCrm();
  const slot = useTopbarSlot();
  const qc = useQueryClient();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);

  const selection = selectionFromQuery(urlQuery);
  const listParams = { centre: selection.centre, tag: selection.tag };

  const libraryQ = useQuery({
    queryKey: collateralKeys.list(listParams),
    queryFn: () => fetchCollateral(crmFetch, listParams),
  });

  const templatesQ = useQuery({
    queryKey: collateralKeys.templates(),
    queryFn: () => fetchTemplates(crmFetch),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: collateralKeys.all });

  const archive = useMutation({
    mutationFn: (item: CollateralItem) =>
      postCollateralItem(crmFetch, item.id, {
        action: item.archivedAt ? "restore" : "archive",
      }),
    onSuccess: () => invalidate(),
    onError: (err) => toast(collateralMessage(errorMessage(err)), "crit"),
  });

  const saveTemplate = useMutation({
    mutationFn: (template: TemplateUpsertInput) =>
      postTemplates(crmFetch, { action: "upsert", template }),
    onSuccess: () => invalidate(),
  });

  const now = useMemo(() => new Date(), []);
  const todayYmd = todayEasternYmd(now);

  const items = libraryQ.data?.items ?? [];
  const tags = libraryQ.data?.tags ?? [];
  const blobConfigured = libraryQ.data?.blobConfigured ?? false;
  const templates = templatesQ.data?.templates ?? [];
  const busy = archive.isPending;

  const onFolder = (value: string) => {
    const next = selectionFromFolder(value);
    setUrlQuery({ centre: next.centre, tag: next.tag });
  };

  const onShare = async (item: CollateralItem) => {
    let existing: ShareLink[] = [];
    try {
      existing = (await fetchShares(crmFetch, { collateralId: item.id })).shares;
    } catch {
      // The sheet is worth opening without its history; the copy still works.
      existing = [];
    }
    openSheet({
      title: "Share collateral",
      icon: <IconFile {...ICON} />,
      testId: COLLATERAL_TEST_IDS.shareSheet,
      body: (
        <ShareSheet
          item={item}
          lead={urlQuery.deal ?? null}
          existing={existing}
          onCreate={async (input) => {
            const out = await createShareLink(crmFetch, input);
            await invalidate();
            return out.share;
          }}
        />
      ),
    });
  };

  const onUpload = () =>
    openSheet({
      title: "Add to the library",
      icon: <IconUpload {...ICON} />,
      body: (
        <UploadSheet
          blobConfigured={blobConfigured}
          onUpload={async (form) => (await uploadCollateralFile(token, form)).item}
          onCreateByUrl={async (input) => (await postCollateral(crmFetch, input)).item}
          onDone={async (item) => {
            await invalidate();
            closeSheet();
            toast(`${item.title} added to the library`);
          }}
          onCancel={closeSheet}
        />
      ),
    });

  const onEditTemplate = (t?: MessageTemplate) =>
    openSheet({
      title: t ? `Edit template · ${t.name}` : "New template",
      icon: <IconPlus {...ICON} />,
      wide: true,
      body: (
        <TemplateEditor
          initial={t}
          onCancel={closeSheet}
          onSubmit={async (input) => {
            await saveTemplate.mutateAsync(input);
            closeSheet();
            toast(`Template ${input.name} saved`);
          }}
        />
      ),
    });

  const onEditItem = (item: CollateralItem) =>
    openSheet({
      title: `Edit ${item.title}`,
      icon: <IconFile {...ICON} />,
      body: (
        <UploadSheet
          blobConfigured={blobConfigured}
          onUpload={async (form) => (await uploadCollateralFile(token, form)).item}
          onCreateByUrl={async (input) => {
            const out = await postCollateralItem(crmFetch, item.id, {
              action: "update",
              patch: {
                title: input.title,
                centre: input.centre,
                blobUrl: input.blobUrl,
                tags: input.tags,
                validFrom: input.validFrom,
                validUntil: input.validUntil,
              },
            });
            return out.item;
          }}
          onDone={async () => {
            await invalidate();
            closeSheet();
            toast(`${item.title} updated`);
          }}
          onCancel={closeSheet}
        />
      ),
    });

  return (
    <div className="stack" style={{ gap: 16 }} data-testid={COLLATERAL_TEST_IDS.screen}>
      {slot && isDirector
        ? createPortal(
            <>
              <button type="button" className="btn btn-sm" onClick={onUpload}>
                <IconUpload {...ICON} /> <span className="lbl">Upload</span>
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => onEditTemplate()}
              >
                <IconPlus {...ICON} /> <span className="lbl">New template</span>
              </button>
            </>,
            slot,
          )
        : null}

      <Folders
        options={folderOptions(tags)}
        value={folderValue(selection)}
        onChange={onFolder}
        label="Filter the library"
      />

      {libraryQ.isPending ? <LoadingState label="Loading the library…" /> : null}
      {libraryQ.isError ? (
        <ErrorState
          message={collateralMessage(errorMessage(libraryQ.error))}
          onRetry={() => void libraryQ.refetch()}
        />
      ) : null}
      {libraryQ.data && items.length === 0 ? (
        <EmptyState icon={<IconFile {...ICON} />}>
          Nothing here yet{selection.centre || selection.tag ? " in this folder" : ""}.
          {isDirector ? " Use Upload to add the first flyer." : ""}
        </EmptyState>
      ) : null}

      {items.length > 0 ? (
        <div className="grid grid-3" data-testid={COLLATERAL_TEST_IDS.grid}>
          {items.map((item) => (
            <CollateralCard
              key={item.id}
              item={item}
              todayYmd={todayYmd}
              now={now}
              canEdit={isDirector}
              busy={busy}
              onShare={onShare}
              onEdit={onEditItem}
              onArchive={(i) => archive.mutate(i)}
            />
          ))}
        </div>
      ) : null}

      {libraryQ.data?.nextCursor ? (
        <div className="xs muted">
          Showing the newest {items.length}. Narrow it with a folder or the search above.
        </div>
      ) : null}

      {EXTRA_CARD_COMPONENTS.map(({ id, Component }) => (
        <Suspense key={id} fallback={<LoadingState />}>
          <Component centre={selection.centre} />
        </Suspense>
      ))}

      {templatesQ.isPending ? <LoadingState label="Loading templates…" /> : null}
      {templatesQ.isError ? (
        <ErrorState
          message={collateralMessage(errorMessage(templatesQ.error))}
          onRetry={() => void templatesQ.refetch()}
        />
      ) : null}
      {templatesQ.data ? (
        <TemplatesCard templates={templates} canEdit={isDirector} onEdit={onEditTemplate} />
      ) : null}
    </div>
  );
}
