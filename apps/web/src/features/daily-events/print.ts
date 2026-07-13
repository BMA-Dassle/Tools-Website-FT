/**
 * Popup-blocker-safe report viewing — ported verbatim from the portal's
 * utils/printHtml.ts (only openHtmlReport is used by the detail view; the
 * hidden-iframe printHtml variant was unused by these pages).
 */
export function openHtmlReport(html: string): void {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (!win) {
    alert("Please allow popups to view the report, or try again.");
    URL.revokeObjectURL(url);
    return;
  }
  // Revoke after a delay so the tab has time to load
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
