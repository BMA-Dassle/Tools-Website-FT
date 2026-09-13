/**
 * Voxtelesys SMS — `lib/sms-retry.ts` `voxSendOnce`.
 *
 *   POST https://smsapi.voxtelesys.net/api/v2/sms
 *        body {to, from, body, status_callback:{url, method}} → {id, status, …}
 *
 * `voxSendOnce` reads `id` off the response to correlate the delivery
 * callback; the fixture carries one. `VOX_MO` is the INBOUND (mobile-
 * originated) payload Vox posts to `/api/sms-webhook/vox/inbound` —
 * `{type:"mo", id, to, from, body, received_at}` — exported for the C1 tests
 * that replay it through `handleInbound`; it is not a handler.
 */

import { http, rawJson } from "../server";
import { fixtureText } from "./fixture";

export const VOX_SEND_URL = "https://smsapi.voxtelesys.net/api/v2/sms";

export const voxFixtures = {
  send: () => fixtureText("vox-send.json.txt"),
  mo: () => fixtureText("vox-mo.json.txt"),
};

/** Every body the fake Vox accepted, in order — for "what did we send" assertions. */
export const voxSent: unknown[] = [];

export const voxHandlers = [
  http.post(VOX_SEND_URL, async ({ request }) => {
    voxSent.push(await request.json());
    return rawJson(voxFixtures.send());
  }),
];
