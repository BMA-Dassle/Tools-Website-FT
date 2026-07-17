"use client";

/**
 * Device-config context for /kiosk routes.
 *
 * Config is read through useSyncExternalStore over the tiny store in
 * config.ts — SSR renders the null snapshot, the client hydrates from
 * localStorage, and saveKioskConfig() notifies every subscriber. No
 * setState-in-effect hydration dance.
 */
import { createContext, useContext, useSyncExternalStore } from "react";
import {
  loadKioskConfig,
  saveKioskConfig,
  serverKioskConfig,
  subscribeKioskConfig,
  type KioskConfig,
} from "./config";

interface KioskConfigContextValue {
  config: KioskConfig | null;
  setConfig: (config: KioskConfig) => void;
}

const KioskConfigContext = createContext<KioskConfigContextValue>({
  config: null,
  setConfig: saveKioskConfig,
});

export function KioskConfigProvider({ children }: { children: React.ReactNode }) {
  const config = useSyncExternalStore(subscribeKioskConfig, loadKioskConfig, serverKioskConfig);
  return (
    <KioskConfigContext.Provider value={{ config, setConfig: saveKioskConfig }}>
      {children}
    </KioskConfigContext.Provider>
  );
}

export function useKioskConfig(): KioskConfigContextValue {
  return useContext(KioskConfigContext);
}
