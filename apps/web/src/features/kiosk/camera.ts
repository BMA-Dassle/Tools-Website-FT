"use client";

/**
 * Camera permission probes (Permissions API). Kiosk rule: a GUEST must never
 * be shown the browser's own Allow/Block dialog — permission is granted once
 * by staff in admin ("Prompt for permissions"). These helpers let the waiver
 * photo step auto-skip when the grant is missing, and let admin + the device
 * check display the live state so staff can see WHY guests are being skipped.
 */

/** "unknown" = Permissions API missing or it rejected the "camera" name —
 *  callers should fall back to attempting getUserMedia directly. */
export type CameraPermission = PermissionState | "unknown";

export async function cameraPermissionState(): Promise<CameraPermission> {
  try {
    // "camera" is a Chromium extension to PermissionName — cast, don't trust.
    const status = await navigator.permissions.query({ name: "camera" as PermissionName });
    return status.state;
  } catch {
    return "unknown";
  }
}

/**
 * Subscribe to the camera permission state: fires `onState` immediately with
 * the current value, then again whenever it changes (e.g. staff clicks Allow
 * in Edge's dialog, or unblocks the site). Returns an unsubscribe function.
 */
export function watchCameraPermission(onState: (state: CameraPermission) => void): () => void {
  let status: PermissionStatus | null = null;
  const handler = () => {
    if (status) onState(status.state);
  };
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    onState("unknown");
  } else {
    navigator.permissions
      .query({ name: "camera" as PermissionName })
      .then((s) => {
        status = s;
        onState(s.state);
        s.addEventListener("change", handler);
      })
      .catch(() => onState("unknown"));
  }
  return () => status?.removeEventListener("change", handler);
}
