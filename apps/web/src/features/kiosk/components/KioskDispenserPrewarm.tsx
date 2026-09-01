"use client";

/**
 * Ambient dispenser PRE-WARM — the null-rendering component that opens the
 * CRT-591 connection BEFORE a guest asks for it.
 *
 * WHY. The reader connection was only ever created when a screen that uses it
 * mounted, and the first such screen in the guest flow is Game Zone itself. So
 * tapping "Game Zone" paid for the whole handshake — open the COM port, EOT
 * line-clear, INIT (the device answers in seconds), then three identity reads —
 * behind a full-screen "Connecting to the card dispenser…" loader. Owner
 * 2026-09-01: "we often click game zone and have to wait for this to connect."
 *
 * HOW. `useCardReader` already PARKS its live client module-scoped on unmount so
 * the next screen adopts it instantly (the 2026-07-21 park-and-adopt fix). That
 * handoff is all this needs: connect early anywhere in the flow, unmount when
 * Game Zone opens, and Game Zone adopts a connection that is already up. Web
 * Serial only demands a user gesture for `requestPort()` (the picker) — reopening
 * an ALREADY-GRANTED port needs none, which is what the existing silent
 * auto-reconnect relies on, so an ambient connect is legitimate here.
 *
 * PORT EXCLUSIVITY. Serial opens are exclusive and three devices (the CRT-591,
 * the MSR, the scanner) share this origin's grants. `EntryScanListener` holds the
 * scanner's port on exactly the screens this mounts on, so the pre-warm runs
 * `hintedPortsOnly` — it tries only ports it can NAME (remembered/saved index,
 * saved USB ids, or a lone grant) and never blind-probes the rest, because a
 * blind probe opens each granted port and sits on it for up to 12s per baud.
 * A named port that turns out to be wrong is still probe-verified and released.
 *
 * NEVER MOUNT THIS ALONGSIDE A SCREEN THAT USES THE READER. The busy mutex in
 * `useCardReader` is per hook INSTANCE, not per client, so two live instances
 * sharing the parked client are not serialized against each other. The caller
 * gates on that (KioskFlow: not while `gzOpen`); this component deliberately
 * issues no commands of its own — it only connects.
 */
import { useKioskConfig } from "../KioskConfigContext";
import { useGameCardDispenser } from "../card-reader";
import { gameZoneCapability } from "../config";

function DispenserPrewarmActive() {
  const { config } = useKioskConfig();
  // Connect-only. Nothing is read off the hook: its mount IS the pre-warm, and
  // whatever it connects parks itself for the next screen to adopt.
  useGameCardDispenser({ config, hintedPortsOnly: true });
  return null;
}

export function KioskDispenserPrewarm({ enabled = true }: { enabled?: boolean }) {
  const { config } = useKioskConfig();
  // Only a kiosk with a DISPENSER has anything to warm. An MSR-only ("swipe")
  // kiosk reads cards through a different device entirely, and a kiosk with no
  // card hardware must not touch the serial stack at all.
  const hasDispenser = gameZoneCapability(config) === "full";
  // The hook has to live behind this gate rather than inside a disabled branch
  // of itself: mounting it is what starts the connect, so not rendering the
  // child is the off switch.
  if (!enabled || !hasDispenser) return null;
  return <DispenserPrewarmActive />;
}
