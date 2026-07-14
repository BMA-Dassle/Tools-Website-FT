"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import "swagger-ui-react/swagger-ui.css";

import { adminPoppins } from "~/components/features/admin-skin/font";
import {
  ADMIN_MONO,
  ADMIN_SANS,
  PORTAL_BLUE_SOFT,
  PORTAL_DARK,
} from "~/components/features/admin-skin/theme";

const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false });

/**
 * Swagger UI for the FastTrax Admin API (Sales + Videos + E-Tickets).
 *
 * Routing: lives under `/admin/{token}/api-docs` so middleware's
 * admin-token check guards the page itself. Search engines can't crawl
 * — `/admin/*` returns 404 without a valid token, and `noindex` is
 * set in the layout. The OpenAPI spec it loads is at
 * `/api/admin/sales/openapi.json`, exposed without auth so the UI's
 * fetch can resolve. Endpoints documented in the spec still require
 * `x-api-key`.
 *
 * Spec URL kept at `/api/admin/sales/openapi.json` for back-compat
 * with the HeadPinz portal devs (predates the Videos + E-Tickets
 * expansion). Spec content covers the full admin surface.
 *
 * The "Authorize" form prompts for the API key (separate from the
 * admin token used to load this page) — operators paste the key
 * issued for their integration and use the "Try it out" buttons.
 */
export default function AdminApiDocsPage() {
  const [apiKey, setApiKey] = useState("");

  return (
    <div
      className={`${adminPoppins.variable} min-h-screen`}
      style={{
        fontFamily: ADMIN_SANS,
        background: PORTAL_DARK.bodyGradient,
        color: PORTAL_DARK.fg,
      }}
    >
      <div
        className="px-4 sm:px-6 py-4 flex items-center justify-between flex-wrap gap-3"
        style={{
          backgroundColor: PORTAL_DARK.card,
          borderBottom: `1px solid ${PORTAL_DARK.border}`,
        }}
      >
        <div>
          <h1 className="tracking-tight" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
            FastTrax Admin API
            <span
              className="ml-2 text-xs font-normal uppercase tracking-wider"
              style={{ color: PORTAL_BLUE_SOFT }}
            >
              v1.1 · OpenAPI 3.0
            </span>
          </h1>
          <p className="text-xs mt-0.5" style={{ color: PORTAL_DARK.muted }}>
            Sales reporting · Videos pipeline · E-Tickets log. Auth via{" "}
            <code style={{ fontFamily: ADMIN_MONO, color: PORTAL_BLUE_SOFT }}>x-api-key</code>{" "}
            header.
          </p>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste API key for Try-It-Out"
            className="px-3 py-1.5 text-xs w-72 max-w-full placeholder:text-[#98a2b3]/60 focus:outline-none focus:ring-1 focus:ring-[#60a5fa]"
            style={{
              backgroundColor: PORTAL_DARK.inputBg,
              border: `1px solid ${PORTAL_DARK.inputBorder}`,
              borderRadius: 8,
              color: PORTAL_DARK.fg,
            }}
          />
        </div>
      </div>
      <div className="p-3 sm:p-6">
        {/* Swagger UI ships light-themed CSS — keep it on a white card so the
            third-party content stays readable against the portal navy. */}
        <div
          style={{
            backgroundColor: "#ffffff",
            border: `1px solid ${PORTAL_DARK.border}`,
            borderRadius: 8,
            overflowX: "auto",
          }}
        >
          <SwaggerUI
            url="/api/admin/sales/openapi.json"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            requestInterceptor={
              ((req: any) => {
                if (apiKey.trim()) {
                  req.headers["x-api-key"] = apiKey.trim();
                }
                return req;
              }) as unknown as never
            }
            tryItOutEnabled
            deepLinking
          />
        </div>
      </div>
    </div>
  );
}
