"use client";

import { useState, useEffect, useRef } from "react";

export default function ApiDocsPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  function handleAuth(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) { setError("Enter an API key"); return; }
    // Validate by making a test call
    fetch(`/api/booking-record?billId=test`, { headers: { "x-api-key": apiKey.trim() } })
      .then(res => {
        if (res.status === 401) { setError("Invalid API key"); return; }
        // 404 is fine — means auth passed but no record
        setAuthenticated(true);
        setError("");
      })
      .catch(() => setError("Connection failed"));
  }

  useEffect(() => {
    if (!authenticated || !containerRef.current) return;

    // Load Swagger UI from CDN
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css";
    document.head.appendChild(link);

    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js";
    script.onload = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).SwaggerUIBundle({
        url: "/api/booking-record/openapi.json",
        dom_id: "#swagger-ui",
        presets: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).SwaggerUIBundle.presets.apis,
        ],
        requestInterceptor: (req: { headers: Record<string, string> }) => {
          req.headers["x-api-key"] = apiKey;
          return req;
        },
        tryItOutEnabled: true,
      });
    };
    document.body.appendChild(script);

    return () => {
      document.head.removeChild(link);
      document.body.removeChild(script);
    };
  }, [authenticated, apiKey]);

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
            autoFocus
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
      <div id="swagger-ui" ref={containerRef} />
    </div>
  );
}
