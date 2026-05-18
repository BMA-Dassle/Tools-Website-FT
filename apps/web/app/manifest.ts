import type { MetadataRoute } from "next";
import { headers } from "next/headers";

/**
 * Web App Manifest — brand-aware. Same Next app serves fasttraxent.com and
 * headpinz.com, so we read the host header at request time and return the
 * matching manifest so iOS/Android "Add to Home Screen" picks up the right
 * branding for whichever site the visitor saved.
 *
 * Reading headers() opts this route out of the default cache, which is the
 * intended behavior here — manifest must vary per host.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const hdrs = await headers();
  const host = (hdrs.get("host") || "").toLowerCase();
  const isHeadPinz = host.includes("headpinz.com");

  if (isHeadPinz) {
    return {
      name: "HeadPinz Entertainment",
      short_name: "HeadPinz",
      description:
        "Premier bowling, laser tag, gel blasters, arcade & dining. Fort Myers & Naples, FL.",
      start_url: "/",
      display: "standalone",
      background_color: "#0a1628",
      theme_color: "#0a1628",
      icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }],
    };
  }

  return {
    name: "FastTrax Entertainment",
    short_name: "FastTrax",
    description:
      "Florida's largest indoor go-kart racing destination. Fort Myers, FL.",
    start_url: "/",
    display: "standalone",
    background_color: "#000418",
    theme_color: "#E41C1D",
    icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }],
  };
}
