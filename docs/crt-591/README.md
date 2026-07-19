# CRT-591 Card Reader/Dispenser — Kiosk Integration

The Game Zone kiosk's motorized card unit (likely **CRT-591-(R02)HB-HDN**, CREATOR/China).
Two interfaces on the unit:

- **COM (RS-232)** — transport/dispensing: init, status/sensors, move card, dispense from
  stacker, entry gate, capture to error bin, RF/Mifare ops. Driven **in the kiosk's browser
  over Web Serial** by `apps/web/src/features/kiosk/card-reader/`. Protocol:
  [protocol.md](protocol.md) (full transcription of the CRT-591-M001 spec).
- **USB** — card **reading**. Enumerates separately from the COM port (keyboard-wedge or
  PC/SC — confirm in Device Manager). Wedge bursts are parsed by
  `card-reader/wedge.ts` (ISO 7811 tracks → card number).

Staff surface: **/kiosk/admin → Card reader tab** (PIN-gated). Connect/grant port, init
variants, live status + sensors, dispense/eject/capture, entry-gate insert watch,
RF activate → UID, Mifare sector read/write, raw command console, TX/RX hex log with
decoded meanings, decoded error banner with recovery hints.

## Model mismatch — read this first

The only protocol doc on hand is **CRT-591-M001** (RFID/IC only). The HB-HDN unit reads
**magstripe**, and no public doc covers its magnetic command set (searched 2026-07-17; the
M001 PDF is the only CRT-591 protocol doc online). What we rely on is family-shared:
framing (STX F2/ADDR/LEN/TEXT/ETX/BCC), the ACK/NAK/EOT handshake, INIT/STATUS/MOVE/ENTRY,
status bytes, and the e1/e0 error table.

Runtime handling:

- The connect handshake reads the firmware string (INIT response), version (`A4h`),
  config (`A3h`), and serial number (`A2h`). If nothing reports "M001", the panel shows an
  amber **model-mismatch banner** and `info.modelMismatch` is true.
- Errors `"00"` (undefined command) / `"03"` (out of hardware support) decode with a
  model-mismatch hint.
- Undocumented commands go through `client.raw(cm, pm, data)` / the panel's **raw console**.

**Open dependency:** request the model-matched protocol PDF from CREATOR / the unit's
vendor. Magstripe-over-COM support (if the unit has it) lands as an additive
`protocol/commands-mag.ts` + panel section — framing/engine untouched. If card reading is
USB-only (likely), the wedge capture already covers it.

Confirmed on hardware 2026-07-17 (CREATOR debug tool capture + our own connect log):

- [x] Firmware (INIT DATA): **`CRT-591-V1.00`**; version (A4h): **`C591_R02_A_170413`**;
      serial (A2h): **`591R02H2501027509`**; config (A3h): `9V10HRLD2`. No "M001" → the amber
      `modelMismatch` banner shows, which is correct (this is the R02 variant).
- [x] Negative-response head byte: **`0x4E` ('N')**.
- [x] LEN/BCC conventions match the M001 diagrams — verified byte-for-byte against the
      capture (e.g. `F2 00 00 03 43 31 30 03 B0`, BCC `B0` = XOR STX..ETX).
- [x] Baud: **115200**.
- [x] **Magnetic stripe is over the COM protocol**, NOT USB — see below. (The web research's
      wedge/PC-SC theories were superseded by the actual capture.)

### Magnetic stripe (reverse-engineered, not in the M001 doc)

The (R02)HB-HDN reads mag tracks over the serial protocol:

- **Read tracks:** `C` CM=`36h` PM=`37h` (`F2 00 00 03 43 36 37 03 B0`). The reply uses head
  **`N` (4Eh)** — that is its NORMAL reply, not an error — with the track buffer as ASCII in
  the payload, `~`-separated: e.g. `…P6283=7496003776810700729~P6283=0000000001037356~N…`.
  `6283` is the Intercard corp prefix; the account increments per card. The driver reads this
  via `engine.sendRaw` (accept-negative) and `parseMagRead()`; the panel's **Magnetic stripe**
  section shows the decoded tracks, a best-guess card number, all candidates, and raw hex.
- **Position for read (CRITICAL):** the reader only accepts the mag read when the card is at
  the read station (status st0=**2**). `MOVE 31h` (stacker feed) stops at the **gate** (st0=1)
  and a read there returns "undefined command" (`e=00`) — you must `MOVE 34h` (mag position)
  first. An INSERTED card is different: the reader **auto-carries** it to the read station on
  entry (spec 3.1.4), so reload needs no positioning move.
- **Permit mag card in:** `ENTRY` PM=`32h` (`permitEntry()`) — the vendor's reload permit
  (M001 documents only 30h/31h; 32h is the mag-variant extension). The reader auto-carries the
  inserted card to the read station.
- **Stop allowing cards in:** `ENTRY` PM=`30h` (`prohibitEntry()`) — sent after a reload
  dispenses so the gate stops accepting further cards.
- **Present to customer:** `MOVE 30h` (holding → card at the gate, st0=1). **NOT `MOVE 39h`**
  ("out of gate") — on this unit 39h behaves differently and sent the card to the error bin.
- **End-to-end flows** (`client.ts`, exposed as the panel's "Card flows" buttons), mirrored
  from the vendor debug tool's captured sequences:
  - **Buy (new card):** `MOVE 34h` (dispenses a blank straight from the stacker to the read
    station, st0=2 — no front poke) → mag read → _pause for confirm_ → `MOVE 30h` (present).
    Falls back to `31h → 34h` only if the direct feed ever reads nothing.
  - **Reload (existing card):** `ENTRY 32h` (permit) → wait until the auto-carried card is at
    the read station (st0=2) → mag read → _pause for confirm_ → `MOVE 30h` (return card) →
    `ENTRY 30h` (stop allowing further cards in).
  - **Auto-retract:** a presented card left uncollected is retracted to the error bin by the
    unit's own timer — expected dispenser behavior; in production the customer takes the card.
- **Account number = track 2's 16-digit field** (confirmed against a printed card
  2026-07-17). `parseMagRead` returns that as `cardNumber`; track 1's longer field and any
  others are kept in `candidates` for reference.
- **Write:** out of scope — not needed for the Game Zone use case (owner decision
  2026-07-17). If it's ever needed, capture the debug tool's TX/RX for a mag write and add
  `magWrite()` alongside the read.

## Architecture

```
src/features/kiosk/card-reader/
  protocol/       pure codec + commands + errors (no DOM; fully unit-tested)
    constants.ts  control bytes, CM table, INIT/MOVE PMs, timeout classes
    frame.ts      buildCommandFrame / FrameAccumulator (STX-resync recovery)
    status.ts     st0/st1/st2 + sensor parsing
    errors.ts     e1/e0 table → CrtErrorInfo {category, staff hint}; error classes
    commands.ts   typed builders/parsers (dispenser, RF/Mifare, identity, bin counter)
  engine/         ACK/NAK/EOT half-duplex state machine (single-flight FIFO)
  transport/      ByteTransport seam; Web Serial adapter (8N1, re-open per baud)
  client.ts       connect() = auto-baud probe + EOT line-clear + INIT + discovery;
                  typed methods; B0 auto-reinit for idempotent reads ONLY
  useCardReader.ts React hook (connection state machine, polling, log ring)
  wedge.ts        USB keyboard-wedge burst parsing (ISO 7811)
components/KioskAdminCardReader.tsx   the staff test panel
```

Key protocol rules encoded in the engine (spec 1.4):

- Command → device ACK within **300 ms**, else resend (≤3); NAK → resend.
- Response validated (BCC/ETX/ADDR); corrupt → we NAK for a device resend (≤2).
- Execution timeouts by command class: quick 2 s · cardIo 8 s · move 15 s · init 30 s.
  Timeout/cancel runs the **EOT line-clear** exchange; a response crossing our EOT
  (spec Case 7) still resolves the command.
- Spec "Case 4" resend-after-ACK applies to **quick commands only** — never motion
  (double-execution risk on a motor op).
- `B0` ("not reset", the power-cycle signature) auto-recovers with one INIT(leaveCard) +
  retry for idempotent reads; motion/writes surface it with a Re-init action instead.
- Auto-baud: **115200** → 9600 → 38400 → 19200 → 57600 (persisted working baud tried first).
  The kiosk's CRT-591-(R02)HB-HDN runs at **115200** (confirmed on hardware 2026-07-17) —
  note the M001 doc only lists up to 57600, so this variant is faster than documented.

Config: `KioskConfig.cardReaderEnabled/cardReaderBaud/cardReaderPortInfo` (+ the unit's
serial number auto-fills `dispenserId`). Saved via the admin `persist()` → localStorage +
Neon `kiosk_devices`. **Any new field must be added to `resolveKioskConfig`'s literal in
`config.ts` or boot-time re-resolve strips it.**

## Provisioning checklist (per kiosk, per browser profile)

1. Plug the unit's COM (USB-serial) and USB leads into the kiosk PC.
2. `/kiosk/admin` → PIN → **Card reader** tab.
3. Tap **Prompt for permissions** → pick the USB-serial adapter in the chooser (one-time per
   profile+origin). Choosing a port IS the grant — Web Serial has no separate Allow popup.
4. Wait for CONNECTED — firmware/serial/baud appear and save to config automatically.
5. Verify: Refresh status (stacker/bin chips sane) → Dispense → Eject → insert-watch a card.
6. Device tab: confirm the "CRT-591 card reader (COM)" toggle is ON.

Chrome serial grants are per **origin + profile**: a re-imaged kiosk, a new Chrome profile,
or a different URL (e.g. a dev laptop's IP) needs step 3 again.

If the chooser never opens ("browser blocked serial access" / SecurityError), the **Prompt
for permissions** button's message names the blocking layer — mirrors the camera admin's
button (2026-07-18 incident):

- **Our own header** — production must send `Permissions-Policy: … serial=(self)`
  (`next.config.ts`); the button checks `document.featurePolicy` and says so explicitly.
- **Edge site permission** — address-bar padlock → Permissions → "Serial ports", or
  `edge://settings/content/serialPorts` (site must not be under Block).
- **Management policy** — `edge://policy`: `DefaultSerialGuardSetting` /
  `SerialBlockedForUrls` on company-managed browsers.
- **Spent gesture** — stale kiosk builds entered fullscreen on the same tap, consuming the
  transient activation serial needs; `/kiosk/admin` skips fullscreen since 2026-07-18, so
  reload the page to pick up a current build.

## Dev loop (laptop dev server + kiosk hardware)

1. Laptop: `npm run dev -w fasttrax-web`; note its LAN IP → `http://<laptop-ip>:3000`.
2. Kiosk PC (reader attached) runs **Edge** — same Chromium flag applies. A separate
   user-data-dir is required or an already-running Edge instance eats the flag:

   ```
   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --unsafely-treat-insecure-origin-as-secure=http://<laptop-ip>:3000 --user-data-dir=C:\edge-kiosk-dev http://<laptop-ip>:3000/kiosk/admin
   ```

   (Chrome works identically: `chrome.exe` + the same flags. Without the trailing URL it
   opens the start page — the flag is still active in that window; just type the URL.)

3. On the admin page: PIN → Card reader → Connect (grant the port — new origin = new
   grant). If the tab shows the amber "Web Serial isn't available" warning, the flag didn't
   apply — close ALL windows using that user-data-dir and re-run the command.
4. Iterate from the laptop; hot reload applies; the TX/RX log is the debug surface.
5. Production (HTTPS) needs no flag.

Without the flag, `navigator.serial` is `undefined` on plain-HTTP LAN origins and the panel
shows its "unsupported" guidance.

## Troubleshooting (decoded from e1/e0 — full table in protocol.md § 2.2)

| Symptom / code                  | Meaning                                       | Do                                                                    |
| ------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| No response at any baud         | Wrong COM cable/port, no power, ADDR DIP ≠ 00 | Check wiring/power/DIP, power-cycle, reconnect                        |
| `B0`                            | Power-cycled, not initialized                 | Panel auto-reinits reads; tap Re-init otherwise                       |
| `10`                            | Card jam                                      | Clear the transport, then Init                                        |
| `A0`                            | Stacker empty                                 | Refill blanks (watch the "few" amber chip pre-emptively)              |
| `A1` / bin FULL chip            | Error bin full                                | Empty bin, Reset counter                                              |
| `45`                            | Card moved manually                           | Init so the device re-finds the card                                  |
| `00` / `03`                     | Command unknown/unsupported                   | Likely model mismatch — see banner + this README                      |
| "in use by another tab"         | Second tab/program owns the port              | Close the other consumer                                              |
| "browser blocked serial access" | Chooser refused: header/site/policy/gesture   | Tap **Prompt for permissions** — it names the layer; see Provisioning |
| Repeated `badFrame(bcc)` in log | Line noise or framing mismatch                | Check cable; capture log; compare protocol.md                         |

## PCI note

Wedge parsing is for **Intercard game cards only**. Raw payment-card track data must never
be parsed in our JS (house rule, `config.ts`) — payment swipes go through Square's own
entry paths. Don't run bank cards through the test panel.

## What's deliberately NOT here yet

- Guest Game Zone flow wiring (replace `simDispense()`; insert-to-reload) — follow-up PR.
- Intercard new-account issuance (no API for it in `features/game-cards/` yet) — required
  before real new-card sales.
- Magstripe-over-COM commands — blocked on the vendor doc (see above).
