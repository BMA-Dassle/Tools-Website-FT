/** `~/features/crm/collateral` — DDL + template seed in PR1; C6 adds `service/{merge,share}.ts`. */
export { ensureCollateralSchema } from "./data/collateral-db";
export {
  ensureTemplatesSchema,
  mergeFieldsOf,
  seedTemplates,
  type TemplateSeed,
} from "./data/templates-db";
export { ensureShareLinksSchema } from "./data/share-links-db";
