import { NextResponse } from "next/server";

const THREECX_URL = "https://bma.3cx.us";
const CALL_CENTER_QUEUE_ID = 282; // Call Center queue

// Cache token in memory (server-side only)
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const res = await fetch(`${THREECX_URL}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.THREECX_CLIENT_ID || "",
      client_secret: process.env.THREECX_CLIENT_SECRET || "",
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const data = await res.json();

  cachedToken = {
    token: data.access_token,
    // Token expires in 60s, refresh at 50s to be safe
    expiresAt: Date.now() + 50_000,
  };

  return cachedToken.token;
}

export async function GET() {
  try {
    const token = await getToken();
    const headers = { Authorization: `Bearer ${token}` };

    // 1. Get Call Center queue agents
    const queueRes = await fetch(
      `${THREECX_URL}/xapi/v1/Queues(${CALL_CENTER_QUEUE_ID})?$expand=Agents`,
      { headers, cache: "no-store" },
    );

    if (!queueRes.ok) {
      return NextResponse.json({ available: false }, { status: 200 });
    }

    const queue = await queueRes.json();
    const agents = (queue.Agents || []) as Array<{ Number: string }>;

    if (agents.length === 0) {
      return NextResponse.json({ available: false }, {
        headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
      });
    }

    // 2. Check those agents' status
    const filter = agents.map((a) => `Number eq '${a.Number}'`).join(" or ");
    const usersRes = await fetch(
      `${THREECX_URL}/xapi/v1/Users?$select=Number,CurrentProfileName,IsRegistered&$filter=${encodeURIComponent(filter)}`,
      { headers, cache: "no-store" },
    );

    if (!usersRes.ok) {
      return NextResponse.json({ available: false }, { status: 200 });
    }

    const users = await usersRes.json();
    const available = (users.value || []).some(
      (u: { CurrentProfileName: string; IsRegistered: boolean }) =>
        u.IsRegistered && u.CurrentProfileName === "Available",
    );

    return NextResponse.json({ available }, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch {
    // On any error, default to not showing the button
    return NextResponse.json({ available: false }, { status: 200 });
  }
}
