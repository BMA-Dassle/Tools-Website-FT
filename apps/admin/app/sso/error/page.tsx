/**
 * The one page a staff member sees when sign-in does not end in a board.
 *
 * It exists to make the next step obvious and the support call short: what
 * went wrong in plain words, the stable code, and — when the gateway gave us
 * one — the request id that finds this exact attempt in the gateway's audit
 * log. A generic "Authentication error" costs someone twenty minutes.
 */

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, { title: string; body: string }> = {
  SSO_E_NO_ROLE: {
    title: "You're signed in, but not yet allowed in here",
    body: "Your Microsoft account works — it just hasn't been given access to the FastTrax admin tools. Ask Eric to add you, then sign in again.",
  },
  SSO_E_CALLBACK_FAILED: {
    title: "Sign-in didn't complete",
    body: "The hand-off back from Microsoft failed. This is usually a stale tab or a browser that blocked the round-trip — close this tab and start again from the link you came from.",
  },
  SSO_E_SESSION_EXPIRED: {
    title: "Your session expired",
    body: "Sessions last eight hours. Sign in again to pick up where you were.",
  },
};

const FALLBACK = {
  title: "Sign-in didn't work",
  body: "Something went wrong on the way in. Try once more; if it happens again, send Eric the code and reference below.",
};

export default async function SsoErrorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  // `code` is ours; `error` is what Auth.js appends on its own failures.
  const code = one(sp.code) || one(sp.error) || "SSO_E_UNKNOWN";
  const requestId = one(sp.requestId) || one(sp.rid);
  const { title, body } = MESSAGES[code] ?? FALLBACK;

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "#0e1729",
        color: "#e8eefc",
        fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
      }}
    >
      <div style={{ maxWidth: 460 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.25, margin: 0 }}>{title}</h1>
        <p style={{ fontSize: 16, lineHeight: 1.55, color: "#9fb0d0", marginTop: 12 }}>{body}</p>
        <p
          style={{
            fontSize: 13,
            color: "#7488ad",
            marginTop: 28,
            fontFamily: "ui-monospace,monospace",
          }}
        >
          {code}
          {requestId ? ` · reference ${requestId}` : ""}
        </p>
        <a
          href="/api/auth/signin"
          style={{
            display: "inline-block",
            marginTop: 20,
            padding: "12px 20px",
            borderRadius: 10,
            background: "#3b82f6",
            color: "#fff",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Try signing in again
        </a>
      </div>
    </main>
  );
}
