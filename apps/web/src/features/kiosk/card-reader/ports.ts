/**
 * Human label for a Web Serial port in a picker/dropdown. Web Serial NEVER
 * exposes the OS "COM3" name — only USB vendor/product ids — so we label by a
 * 1-based index plus the USB id (and a friendly adapter name for the common
 * USB-serial chips). Native COM ports (no USB id) just show the index. Pair with
 * `navigator.serial.getPorts()` (which, once the SerialAllowAllPortsForUrls
 * policy is set, returns every port with no chooser) to build a "pick a port"
 * list that auto-connects on select.
 */

const USB_VENDORS: Record<number, string> = {
  0x0c2e: "Honeywell",
  0x0403: "FTDI",
  0x067b: "Prolific",
  0x1a86: "CH340",
  0x10c4: "CP210x",
  0x2341: "Arduino",
  0x1fc9: "NXP",
  0x0483: "STMicro",
};

export function describePort(port: SerialPort, index: number): string {
  const info = port.getInfo();
  if (info.usbVendorId != null) {
    const vid = info.usbVendorId.toString(16).padStart(4, "0");
    const pid = (info.usbProductId ?? 0).toString(16).padStart(4, "0");
    const name = USB_VENDORS[info.usbVendorId];
    return `Port ${index + 1} — USB ${vid}:${pid}${name ? ` (${name})` : ""}`;
  }
  return `Port ${index + 1} — native COM`;
}
