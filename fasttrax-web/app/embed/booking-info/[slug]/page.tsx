import { notFound } from "next/navigation";
import { products } from "../products";

export default async function EmbedBookingInfo({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = products[slug];
  if (!product) notFound();

  return (
    <html>
      <body style={{ margin: 0, padding: 0, background: "transparent", fontFamily: "'Segoe UI',system-ui,-apple-system,sans-serif" }}>
        <div style={{ color: "#ffffff", fontSize: "15px", lineHeight: 1.6, maxWidth: "600px" }}>

          {/* Qualification Warning */}
          {product.qualification && (
            <div style={{
              background: "linear-gradient(135deg,#cc0000,#e41c1d)",
              padding: "14px 18px",
              borderRadius: "8px",
              marginBottom: "16px",
              borderLeft: "4px solid #ff4444",
            }}>
              <p style={{
                margin: 0,
                fontSize: "14px",
                fontWeight: 700,
                textAlign: "center" as const,
                textTransform: "uppercase" as const,
                letterSpacing: "0.5px",
                lineHeight: 1.5,
              }}>
                ⚠ {product.qualification}
              </p>
            </div>
          )}

          {/* Driver Requirements + License Fee */}
          <div style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: "8px",
            padding: "16px 18px",
            marginBottom: "16px",
          }}>
            <p style={{ margin: "0 0 10px 0", fontSize: "14px" }}>
              <span style={{ color: "#e41c1d", fontWeight: 700 }}>DRIVERS:</span>{" "}
              Ages {product.age} &amp; {product.height}.
            </p>
            <p style={{ margin: 0, fontSize: "13px", color: "rgba(255,255,255,0.7)", lineHeight: 1.5 }}>
              A <strong style={{ color: "#fff" }}>{product.licenseFee}</strong> online booking charge is required per driver.
              It includes a one-year FastTrax license renewal and is added to all online bookings.{" "}
              <strong style={{ color: "#fff" }}>This renewal cannot be removed.</strong>
            </p>
            {product.note && (
              <p style={{ margin: "10px 0 0 0", fontSize: "13px", color: "#ffcc00", fontWeight: 600 }}>
                {product.note}
              </p>
            )}
          </div>

          {/* Check-in Timing */}
          <div style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: "8px",
            padding: "16px 18px",
            marginBottom: "16px",
          }}>
            <p style={{ margin: "0 0 6px 0", fontSize: "14px", fontWeight: 700, color: "#004AAD" }}>
              HOW CHECK-IN WORKS
            </p>
            <p style={{ margin: "0 0 8px 0", fontSize: "13px", color: "rgba(255,255,255,0.85)", lineHeight: 1.5 }}>
              The time you select is your{" "}
              <strong style={{ color: "#fff" }}>karting check-in deadline</strong> at the 1st floor karting
              counter — not the race start. Be there at least 5 minutes early to get your POV camera and
              enter the safety briefing.
            </p>
            <p style={{ margin: 0, fontSize: "13px", color: "rgba(255,255,255,0.85)", lineHeight: 1.5 }}>
              We ask that you{" "}
              <strong style={{ color: "#fff" }}>arrive {product.arriveMinutes} minutes before</strong> your
              selected time to check in at Guest Services (2nd floor) for your waivers, height check, and
              racing credentials. This gives you time for any unexpected lines.
            </p>
          </div>

          {/* Arrival Warning */}
          <div style={{
            background: "linear-gradient(135deg,#004AAD,#0058cc)",
            padding: "14px 18px",
            borderRadius: "8px",
            borderLeft: "4px solid #3399ff",
          }}>
            <p style={{ margin: 0, fontSize: "14px", fontWeight: 700, textAlign: "center" as const, letterSpacing: "0.3px" }}>
              🕐 Please arrive {product.arriveMinutes} minutes before your selected time.
            </p>
          </div>

        </div>
      </body>
    </html>
  );
}
