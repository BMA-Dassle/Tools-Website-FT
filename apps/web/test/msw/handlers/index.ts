/** Every transport's handlers, for a test that wants the whole fake world at once. */
export {
  OFFICE_BASE,
  OFFICE_OVERBOOK_REFUSAL,
  OFFICE_PROJECT_BILL_ID,
  OFFICE_PROJECT_ID,
  OFFICE_PROJECT_PERSON_ID,
  officeFixtures,
  officeHandlers,
} from "./office";
export {
  PANDORA_BASE,
  PANDORA_PERSON_ID,
  PANDORA_PROJECT_ID,
  pandoraFixtures,
  pandoraHandlers,
} from "./pandora";
export { QAMF_BASE, QAMF_TOKEN_URL, qamfFixtures, qamfHandlers } from "./qamf";
export { VOX_SEND_URL, voxFixtures, voxHandlers, voxSent } from "./vox";
export {
  GRAPH_BASE,
  GRAPH_DRAFT_ID,
  GRAPH_INBOUND_ID,
  GRAPH_LOGIN,
  GRAPH_SENT_ID,
  graphFixtures,
  graphHandlers,
} from "./graph";
export {
  SEVEN_SHIFTS_BASE,
  SEVEN_SHIFTS_COMPANY_ID,
  sevenShiftsFixtures,
  sevenShiftsHandlers,
} from "./sevenshifts";
export { THREECX_BASE, threecxFixtures, threecxHandlers } from "./threecx";
export { fixtureText } from "./fixture";

import { graphHandlers } from "./graph";
import { officeHandlers } from "./office";
import { pandoraHandlers } from "./pandora";
import { qamfHandlers } from "./qamf";
import { sevenShiftsHandlers } from "./sevenshifts";
import { threecxHandlers } from "./threecx";
import { voxHandlers } from "./vox";

export const allHandlers = [
  ...officeHandlers,
  ...pandoraHandlers,
  ...qamfHandlers,
  ...voxHandlers,
  ...graphHandlers,
  ...sevenShiftsHandlers,
  ...threecxHandlers,
];
