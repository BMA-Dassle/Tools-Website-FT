/** `~/features/crm/sms` — DDL only in PR1; C1 adds `service/send.ts`, `inbound.ts`, `threads.ts`. */
export { ensureSmsThreadsSchema } from "./data/threads-db";
export { ensureSmsMessagesSchema } from "./data/messages-db";
