"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import "swagger-ui-react/swagger-ui.css";

const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false });

export default function ApiDocsPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");

  function handleAuth(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) { setError("Enter an API key"); return; }
    fetch(`/api/booking-record?billId=test`, { headers: { "x-api-key": apiKey.trim() } })
      .then(res => {
        if (res.status === 401) { setError("Invalid API key"); return; }
        setAuthenticated(true);
        setError("");
      })
      .catch(() => setError("Connection failed"));
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
        <form onSubmit={handleAuth} className="bg-gray-900 rounded-xl border border-gray-800 p-8 max-w-md w-full space-y-4">
          <h1 className="text-white text-2xl font-bold">FastTrax Booking API</h1>
          <p className="text-gray-400 text-sm">Enter your API key to access documentation.</p>
          <input
            type="password"
            value={apiKey}
            onChange={e => { setApiKey(e.target.value); setError(""); }}
            placeholder="API Key"
            className="w-full px-4 py-3 rounded-lg bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500"
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button type="submit" className="w-full py-3 rounded-lg bg-cyan-500 text-gray-950 font-bold hover:bg-cyan-400 transition-colors">
            Authenticate
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <SwaggerUI
        url="/api/booking-record/openapi.json"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        requestInterceptor={((req: any) => { req.headers["x-api-key"] = apiKey; return req; }) as any}
        tryItOutEnabled
      />
    </div>
  );
}
