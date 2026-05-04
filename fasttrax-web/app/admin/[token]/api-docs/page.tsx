"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import "swagger-ui-react/swagger-ui.css";

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
    <div className="min-h-screen bg-white">
      <div className="bg-[#050b1d] text-white px-6 py-4 flex items-center justify-between flex-wrap gap-3 border-b border-white/10">
        <div>
          <h1 className="text-lg font-extrabold tracking-tight">
            FastTrax Admin API
            <span className="ml-2 text-xs font-normal text-cyan-400 uppercase tracking-wider">
              v1.1 · OpenAPI 3.0
            </span>
          </h1>
          <p className="text-white/45 text-xs mt-0.5">
            Sales reporting · Videos pipeline · E-Tickets log. Auth via <code className="text-cyan-400">x-api-key</code> header.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste API key for Try-It-Out"
            className="px-3 py-1.5 text-xs bg-white/5 border border-white/15 rounded-lg text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/50 w-72"
          />
        </div>
      </div>
      <SwaggerUI
        url="/api/admin/sales/openapi.json"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        requestInterceptor={((req: any) => {
          if (apiKey.trim()) {
            req.headers["x-api-key"] = apiKey.trim();
          }
          return req;
        }) as unknown as never}
        tryItOutEnabled
        deepLinking
      />
    </div>
  );
}
