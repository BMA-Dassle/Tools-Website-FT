import { normalizePhoneE164, recordOptOut } from "~/features/marketing";

/**
 * GET /marketing/unsubscribe?phone=<E.164>
 *
 * Email-footer unsubscribe target. Writes an opt-out row in
 * marketing_consent so future campaigns skip this phone (transactional
 * SMS like booking confirmations and lane-ready notifications are
 * NOT gated by this registry — they continue to send).
 *
 * Idempotent: a second visit is a no-op (recordOptOut upserts to
 * opted_in=false; re-applying the same state is fine).
 *
 * Renders a minimal HeadPinz-branded confirmation page — no client
 * JavaScript, no auth, no form. The opt-out happens on first GET so
 * email clients that pre-fetch the link still trigger it (the worst
 * case is over-pruning, which is the safer side of consent).
 */
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string }>;
}) {
  const params = await searchParams;
  const phoneRaw = params.phone ?? "";

  let phoneE164: string | null = null;
  let optedOut = false;
  let error: string | null = null;

  if (!phoneRaw) {
    error = "Missing phone parameter.";
  } else {
    try {
      phoneE164 = normalizePhoneE164(phoneRaw);
    } catch {
      error = "Couldn't recognize that phone number.";
    }
    if (phoneE164) {
      try {
        await recordOptOut({ phoneE164, source: "email_unsubscribe" });
        optedOut = true;
      } catch (err) {
        console.error("[marketing/unsubscribe] failed:", err);
        error = "Something went wrong saving your preference. Please try again.";
      }
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f7fb",
        color: "#0a1628",
        padding: "32px 16px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: "100%",
          background: "#ffffff",
          borderRadius: 14,
          boxShadow: "0 4px 14px rgba(10,22,40,0.08)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            background: "#0a1628",
            color: "#ffffff",
            padding: "20px 24px",
            fontSize: 18,
            fontWeight: 700,
          }}
        >
          HeadPinz
        </div>
        <div style={{ padding: 24, fontSize: 15, lineHeight: 1.55 }}>
          {optedOut ? (
            <>
              <p style={{ margin: "0 0 12px", fontSize: 17, fontWeight: 700 }}>
                You&apos;re unsubscribed.
              </p>
              <p style={{ margin: "0 0 12px" }}>
                We won&apos;t send any more marketing texts or emails to{" "}
                <strong>{phoneE164}</strong>.
              </p>
              <p style={{ margin: 0, color: "#5b6b85", fontSize: 13 }}>
                Booking confirmations and lane-ready notifications will still come through — those
                are tied to specific reservations, not marketing.
              </p>
            </>
          ) : (
            <>
              <p style={{ margin: "0 0 12px", fontSize: 17, fontWeight: 700 }}>
                Unsubscribe didn&apos;t go through
              </p>
              <p style={{ margin: 0 }}>{error ?? "Unknown error."}</p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
