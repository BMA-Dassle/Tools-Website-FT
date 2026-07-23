/**
 * Silent-reopen port selection for the QR scanner — pure so the rule is
 * unit-tested. The kiosk PC can have THREE serial devices granted on this
 * origin (CRT-591, MSR, QR scanner), so the scanner is STRICTER than the
 * card reader/MSR hooks: it never falls back to "the one granted port"
 * unless the consumer opts in (a station known to have no other serial
 * hardware, e.g. the future check-in migration). Grabbing the wrong port
 * matters: Web Serial opens are exclusive, so a stolen port blocks the
 * other device entirely.
 */

export interface PortLike {
  getInfo(): SerialPortInfo;
}

export function matchScannerPort<P extends PortLike>(
  granted: readonly P[],
  saved: { usbVendorId?: number; usbProductId?: number } | null | undefined,
  allowLoneGrantFallback = false,
): P | null {
  if (saved?.usbVendorId != null) {
    // Exact match only — VID must equal, PID too when one was saved. A saved
    // id NEVER falls back to guessing.
    return (
      granted.find((p) => {
        const info = p.getInfo();
        return (
          info.usbVendorId === saved.usbVendorId &&
          (saved.usbProductId == null || info.usbProductId === saved.usbProductId)
        );
      }) ?? null
    );
  }
  // No saved ids: only an opted-in consumer may take the lone grant.
  if (allowLoneGrantFallback && granted.length === 1) return granted[0];
  return null;
}
