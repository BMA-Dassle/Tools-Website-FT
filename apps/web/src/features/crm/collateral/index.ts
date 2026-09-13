/**
 * `~/features/crm/collateral` — the library of files reps share, the message
 * templates a guest actually receives, and the tokenised share links (C6).
 *
 * The SERVER barrel: it pulls in Neon and `@vercel/blob`, so a client
 * component imports `./contracts`, `./queries` or a pure `./service/*` module
 * by path instead (the reps sub sets the same precedent).
 */

export {
  ensureCollateralSchema,
  bumpCollateralShares,
  createCollateral,
  getCollateral,
  listCollateral,
  listCollateralTags,
  setCollateralArchived,
  updateCollateral,
  type CollateralCreateInput,
  type CollateralListFilter,
  type CollateralPage,
  type CollateralPatch,
} from "./data/collateral-db";

export {
  ensureTemplatesSchema,
  getTemplate,
  listTemplates,
  mergeFieldsOf,
  reorderTemplates,
  seedTemplates,
  setTemplateArchived,
  upsertTemplate,
  type TemplateSeed,
  type TemplateWriteInput,
} from "./data/templates-db";

export {
  ensureShareLinksSchema,
  getShareLink,
  getShareLinkForOpen,
  recordShareOpen,
} from "./data/share-links-db";

export { findShareLead, type ShareLeadRef } from "./data/lead-lookup-db";

export {
  CRM_SHARE_PATH,
  DEFAULT_SHARE_DAYS,
  MAX_SHARE_DAYS,
  ShareError,
  createShare,
  expireShareLinks,
  isShareExpired,
  listSharesFor,
  mintShareToken,
  openKeyFor,
  openShare,
  revokeShare,
  sharePathFor,
  shareUrlFor,
  type CreateShareInput,
  type CreateShareResult,
  type ShareOpenOutcome,
} from "./service/share";

export {
  BLOB_NOT_CONFIGURED,
  CollateralUploadError,
  UPLOAD_ERRORS,
  blobConfigured,
  blobPathFor,
  uploadCollateralFile,
} from "./service/blob";

export {
  MERGE_FIELDS,
  MERGE_FIELD_KEYS,
  gsm7Verdict,
  mergeFieldsIn,
  renderSegments,
  renderTemplate,
  sampleValues,
  smsSegments,
  type MergeFieldDef,
  type MergeSegment,
  type MergeValues,
} from "./service/merge";

export {
  COLLATERAL_ACCEPT,
  COLLATERAL_MAX_BYTES,
  collateralTypeFromName,
  collateralTypeFromUrl,
  normaliseTags,
  parseTagInput,
  sizeLabel,
  titleFromFilename,
  validityOf,
} from "./service/library";

export { shareLinkExpireHandler, shareLinkExpireIdempotencyKey } from "./service/jobs";
