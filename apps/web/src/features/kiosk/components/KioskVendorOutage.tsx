"use client";

/**
 * Full-screen kiosk notice for a surface whose VENDOR is down (maintenance mode).
 *
 * Used where a whole SCREEN has to be withdrawn rather than a tile locked — the
 * group/online waiver flow while BMI is dark, since a waiver signs onto a Pandora
 * person and there is no person to sign for. A guest must never get as far as
 * drawing a signature that lands nowhere.
 *
 * Kiosk-native rather than a redirect to the web /service-notice: this screen
 * lives inside the 1080×1920 canvas, keeps the kiosk chrome, and speaks the
 * guest's chosen language (LocaleProvider comes from KioskShell, which wraps
 * every /kiosk route).
 */
import { useRouter } from "next/navigation";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useT } from "../i18n";

export function KioskVendorOutage() {
  const router = useRouter();
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center px-[96px] text-center">
      <IconAlertTriangle size={96} stroke={1.5} color="#e8b14c" aria-hidden="true" />
      <h1 className="k-display mt-[40px] text-[68px] leading-[1.1]">{t("outage.heading")}</h1>
      <p className="mt-[28px] text-[32px] leading-[1.45] text-white/70">{t("outage.body")}</p>
      <button
        type="button"
        onClick={() => router.push("/kiosk")}
        className="k-btn-ghost k-tap mt-[64px] h-[112px] px-[64px] text-[32px]"
      >
        {t("outage.back")}
      </button>
    </div>
  );
}
