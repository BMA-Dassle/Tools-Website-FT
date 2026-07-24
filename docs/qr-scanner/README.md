# Hardware QR Scanner — Kiosk Integration

Serial-line QR/barcode scanners driven **in the browser over Web Serial** by
`apps/web/src/features/kiosk/qr-scanner/`. First unit: **Honeywell 3320g** in USB serial
(CDC) mode. Staff surface: **/kiosk/admin → QR scanner tab** (PIN-gated) — model + baud
selects, port grant, live scan feed.

This is a SEPARATE device concept from the keyboard-wedge "QR / barcode scanner" toggle
(`scannerEnabled`, types into focused fields) — that path is untouched. The transport
layer stays semantics-free (`useQrScanner` hands consumers raw payloads); the first
semantic consumer is the **driver's-license scan** (below).

## How the device behaves on the wire

- Read-only: scans stream in unprompted; nothing is ever written to the unit.
- Each scan is one line: `<payload>\r\n` (programmed suffix **990D0A** = CR LF on all
  symbologies). Reader = buffer bytes, split on newline, strip `\r`, trim.
- Line settings **per the vendor guide**: 115200 baud, 8-N-1, no flow control.

## Confirmed on hardware — FILL IN on first provisioning

- [ ] Baud rate: guide says **115200** — NOT yet confirmed on the unit. A read-only device
      can't be probed (no handshake): wrong baud = bytes arrive but never decode into
      lines. The panel shows a wrong-baud warning; step through the baud select and scan
      until the feed decodes, then record the working rate here.
- [ ] USB VID:PID: expected VID **0x0C2E** (Honeywell / Hand Held Products) — NOT yet
      confirmed. The panel's Port row shows the real ids; the panel says whether they
      match. Once confirmed, set `usbIdsConfirmed: true` (and correct `expectedUsbIds` if
      they differ) in `qr-scanner/models.ts` and check this box with the values.
- [ ] Suffix: 990D0A programmed (each scan arrives exactly once, no run-ons).

## Architecture

```
src/features/kiosk/qr-scanner/
  models.ts           scanner-model REGISTRY (pure data; the model-#2 seam)
  line-accumulator.ts pure bytes→payload framing (streaming UTF-8, buffer cap; tested)
  port-matching.ts    pure silent-reopen rule (strict; tested)
  useQrScanner.ts     React hook — mirror of card-reader/useSerialMsr.ts (listen-only)
  aamva.ts            AAMVA license parser + burst regrouping (pure; tested)
  useLicenseScan.ts   guest-flow consumer hook (burst → parsed license)
components/KioskAdminQrScanner.tsx   the staff setup/test panel
```

Config: `KioskConfig.qrScannerEnabled/qrScannerModel/qrScannerBaud/qrScannerPortInfo`,
saved via the admin `persist()` → localStorage + Neon. **Any new field must be added to
`resolveKioskConfig`'s literal in `config.ts` or boot-time re-resolve strips it**
(`config.test.ts` has the strip-guard case).

### Adding scanner model #2

- **Another serial-line model** (different baud/framing): one new data literal in
  `models.ts` (`kind: "serial-line"`, its own `defaultBaudRate`/`baudCandidates`/
  `lineSettings`/`expectedUsbIds`). Zero code changes.
- **A non-serial model** (HID/keyboard-wedge/other): add a new `kind` member to the
  `ScannerModel` union — TypeScript then flags the `switch`/branch sites in
  `useQrScanner.ts` and the panel that must handle it.

## Port independence (three serial devices on one kiosk PC)

The CRT-591, the MSR, and the scanner are all Web Serial grants on the same origin, and
serial opens are **exclusive** — a stolen port blocks the other device. The scanner's
silent reconnect is therefore STRICT (`port-matching.ts`):

- Saved `qrScannerPortInfo` ids → exact VID(+PID) match only; no match → no reconnect.
- **No lone-grant guessing** (unlike `useCardReader`/`useSerialMsr`) unless a consumer
  opts in via `allowLoneGrantFallback` — meant for stations with no other serial hardware
  (e.g. a future check-in-station migration). The kiosk admin panel never opts in.
- Known edge (documented, not fixed): the CRT's own reconnect still lone-grant-falls-back;
  if it holds no saved USB ids and the scanner's grant is the only one, it will open it,
  fail its protocol probe, and settle disconnected — churn, not theft. Neutralized once
  both devices are granted (two grants = no lone-grant). Future hardening if it bites:
  an `excludeUsbIds` option on `useCardReader`.

The Honeywell in CDC mode is a USB device, so `getInfo()` carries ids and strict matching
always works. If a unit ever shows "native COM (no USB ids)" in the panel, silent
reconnect can't match it — the port needs re-picking after reloads (the panel says so).

## Provisioning checklist (per kiosk, per browser profile)

1. Program the 3320g to USB serial (CDC) via the vendor programming barcode; confirm in
   Device Manager → Ports (COM & LPT). (If it types into text fields, it's in keyboard
   mode.)
2. `/kiosk/admin` → PIN → **QR scanner** tab.
3. Pick the scanner's port from the **Granted COM ports** dropdown (with the "allow all
   serial" policy no chooser is needed), or tap **Grant COM port & listen…** and choose it
   (choosing IS the grant). The Honeywell is labelled `USB 0c2e (Honeywell)`; don't pick
   the CRT-591's or MSR's port — the panel warns if you do.
4. LISTENING → scan a test code. Garbage/no-decode warning → step the baud select, scan
   again, repeat until the feed decodes cleanly. Model/baud/port save automatically.
5. Record the confirmed baud + VID:PID (section above) and flip `usbIdsConfirmed`.
6. Verify: rapid-fire scans each appear once; reload the page → reconnects silently; the
   Device tab's "QR scanner (COM)" toggle is ON; Diagnostics row shows model + baud.
7. Dual-device check: with the CRT-591 (and MSR, if present) provisioned, reload → every
   device reattaches to its own port; run a card-reader op while scanning — no cross-talk.

Chrome/Edge serial grants are per **origin + profile** — a re-imaged kiosk or new profile
needs step 3 again. "Forget saved port" (panel) drops the browser grant + saved ids.

## Dev loop & chooser troubleshooting

Same as the CRT-591 — see [docs/crt-591/README.md](../crt-591/README.md) (§ Dev loop, §
Provisioning) for the Edge `--unsafely-treat-insecure-origin-as-secure` LAN flag and the
blocked-chooser layers (Permissions-Policy `serial=(self)`, site permission, management
policy, spent gesture). The panel's grant button names the blocking layer via
`serialBlockedMessage`, exactly like the card reader tab.

| Symptom                                 | Meaning                            | Do                                                               |
| --------------------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| Scanner types into text fields          | Unit is in keyboard-wedge mode     | Scan the USB-serial (CDC) programming barcode                    |
| No COM port in Device Manager           | Wrong mode or cable                | Re-program mode; check USB lead                                  |
| LISTENING but feed shows bytes, 0 scans | Wrong baud (or no 990D0A suffix)   | Step the baud select + rescan; re-program the suffix             |
| LISTENING, no bytes at all              | Wrong port picked, or unit asleep  | Pick the 0c2e port; pull the trigger; check the panel's Port row |
| "port is in use by another tab"         | Another tab/program owns the port  | Close the other consumer                                         |
| Chooser never opens                     | Policy/permission/gesture layer    | The grant button's message names the layer; see crt-591 README   |
| Reload doesn't reconnect                | No USB ids saved, or grant revoked | Re-pick the port; check the saved-for-reconnect line             |

## License scans (first semantic consumer, 2026-07-23)

A US driver's license / state ID carries an AAMVA PDF417 barcode the 3320g reads.
**Transport fact:** the AAMVA payload separates elements with LF, so ONE physical scan
arrives as ~35 separate `onScan` lines inside the same millisecond (verified on a real FL
license) — `AamvaBurst` regroups them and a 350 ms quiet gap ends the burst
(`useLicenseScan`).

- `aamva.ts` extracts **name + DOB only** (owner privacy stance: address, sex, license
  number, document dates are never extracted, stored, transmitted, or logged).
- Consumers (`KioskPeopleStep`, `KioskPartyManager`, `KioskBowlingPeopleStep`): a scan on
  the roster looks the guest up by last name + DOB — `POST /api/kiosk/license-lookup`,
  backed by the **BMI Office token search with a combined `"LastName M/D/YYYY"` token**
  (no leading zeros; raw `https.get` — the endpoint 500s under undici; ~1 s live, vs
  ~8.5 s for Pandora's person search) — and signs a match in through the existing
  `handleVerified` rail. EVERY record of the guest is returned (duplicates included):
  one → direct sign-in, several → the returning-racer account cards via
  `LicenseMatchPicker`; no match → the new-player form opens prefilled. Waiver status
  resolves right after sign-in via importLinked ("Checking waiver…"), exactly like the
  phone OTP path. An already-open form is just filled. Bowling adds a name-only row.
- **SMS-Timing member QR** (2026-07-24): the app's personal QR scans as ONE line —
  `https://smstim.in?["<clientKey>","<code>"]` (`member-qr.ts`). The code as an Office
  search token returns exactly the member's record (~1 s) → same sign-in rail, no
  name/DOB confirmation (possession of the QR = the member's app). Foreign clientKeys
  yield no matches.
- The physical ID / personal QR is the identity proof; `phoneVerified` is never set by
  these paths — OTP-gated flows (rewards) still re-verify.
- Port exclusivity: only ONE surface mounts `useLicenseScan` at a time (the kiosk shows
  one step/screen at once; `/kiosk/admin` is a separate route). The reconnect backoff
  covers the close/open race when surfaces hand the port off.

## What's deliberately NOT here yet

- Check-in station migration (`app/admin/[token]/checkin/CheckInClient.tsx` has its own
  inline reader; `useQrScanner` covers its needs — baud override, `allowLoneGrantFallback`,
  `onScan` — when that migration is scheduled).
- Scanner model #2 (unknown hardware; see "Adding scanner model #2").
