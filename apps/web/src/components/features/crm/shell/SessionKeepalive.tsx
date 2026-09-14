"use client";

import { useEffect } from "react";
import { useCrmFetch } from "../lib/use-crm-user";

/**
 * KEEPS THE SIGN-IN ALIVE WHILE THE APP IS IN USE.
 *
 * Owner, 2026-09-14: "persisent pwa login", and then the pointer that settled
 * the design — "Portal has persicent pwa sessions if you need to look at that".
 * It does, and this is its pattern: refresh on mount, refresh when the app
 * comes to the FOREGROUND, and a slow interval behind that
 * (`Tools-Team-Member-Portal/src/context/AuthContext.tsx`, "Session refresh —
 * extend Redis TTL on app open / foreground / interval").
 *
 * WHY A ROLLING `maxAge` IS NOT ENOUGH ON ITS OWN. Auth.js re-issues the cookie
 * when `auth()` runs somewhere that can set one — every CRM API route does. But
 * an installed app spends most of its life BACKGROUNDED, making no requests at
 * all, and a rep who opens it on Monday after a quiet weekend would otherwise
 * discover the session died at whatever moment they last used it. Pinging on
 * foreground turns "it logged me out again" into a request nobody sees.
 *
 * `/me` IS THE PING: it is the cheapest authenticated route the CRM has, it is
 * already the shell's own identity read, and — the point — it runs `auth()`,
 * which is what actually rolls the cookie. No new endpoint, no new surface.
 *
 * A FAILURE IS SILENT, DELIBERATELY. `crmFetch` already turns a dead session
 * into a reload that the edge gate answers with `/sso/signin?callbackUrl=…`,
 * so the recovery exists and is not this component's job. If the ping fails for
 * any other reason — offline on a phone, which is the common one — the right
 * answer is to do nothing and try again on the next foreground. Signing
 * somebody out because their train went into a tunnel is the failure this
 * catch prevents.
 */

/** Slow on purpose: the foreground event does the real work. */
const KEEPALIVE_MS = 10 * 60 * 1000;

export function SessionKeepalive() {
  const crmFetch = useCrmFetch();

  useEffect(() => {
    const ping = () => {
      // Only when the app is actually on screen — a backgrounded tab pinging
      // every ten minutes is the "keepalive" that drains a phone battery.
      if (document.visibilityState !== "visible") return;
      void crmFetch("/me").catch(() => {
        // See the header: offline is the common case and is not a sign-out.
      });
    };

    ping();
    const onVisible = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(ping, KEEPALIVE_MS);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [crmFetch]);

  return null;
}
