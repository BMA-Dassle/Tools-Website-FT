/** `~/features/crm/collateral` — DDL + template seed in PR1; C6 adds `service/{merge,share}.ts`. */
export { ensureCollateralSchema } from "./data/collateral-db";
export {
  archiveTemplate,
  ensureTemplatesSchema,
  getTemplate,
  listTemplates,
  mapTemplateRow,
  mergeFieldsOf,
  seedTemplates,
  upsertTemplate,
  type TemplateFilter,
  type TemplateRowRaw,
  type TemplateSeed,
  type TemplateUpsert,
} from "./data/templates-db";
export { ensureShareLinksSchema } from "./data/share-links-db";
