import { NextRequest, NextResponse } from "next/server";
import { products } from "@/app/embed/booking-info/products";

function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("product");
  if (!slug || !products[slug]) {
    return new NextResponse("Not found", { status: 404 });
  }

  const p = products[slug];

  const qualBlock = p.qualification
    ? `<div style="background:linear-gradient(135deg,#cc0000,#e41c1d);padding:14px 18px;border-radius:8px;margin-bottom:16px;border-left:4px solid #ff4444;">
        <p style="margin:0;font-size:14px;font-weight:700;text-align:center;text-transform:uppercase;letter-spacing:0.5px;line-height:1.5;">
          ⚠ ${escHtml(p.qualification)}
        </p>
      </div>`
    : "";

  const noteBlock = p.note
    ? `<p style="margin:10px 0 0 0;font-size:13px;color:#ffcc00;font-weight:600;">${escHtml(p.note)}</p>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>body{margin:0;padding:8px;background:transparent;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;}</style>
</head>
<body>
  <div style="color:#ffffff;font-size:15px;line-height:1.6;max-width:600px;">

    ${qualBlock}

    <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:16px 18px;margin-bottom:16px;">
      <p style="margin:0 0 10px 0;font-size:14px;">
        <span style="color:#e41c1d;font-weight:700;">DRIVERS:</span>
        Ages ${escHtml(p.age)} &amp; ${escHtml(p.height)}.
      </p>
      <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.7);line-height:1.5;">
        A <strong style="color:#fff;">${escHtml(p.licenseFee)}</strong> online booking charge is required per driver.
        It includes a one-year FastTrax license renewal and is added to all online bookings.
        <strong style="color:#fff;">This renewal cannot be removed.</strong>
      </p>
      ${noteBlock}
    </div>

    <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:16px 18px;margin-bottom:16px;">
      <p style="margin:0 0 6px 0;font-size:14px;font-weight:700;color:#004AAD;">HOW CHECK-IN WORKS</p>
      <p style="margin:0 0 8px 0;font-size:13px;color:rgba(255,255,255,0.85);line-height:1.5;">
        The time you select is your <strong style="color:#fff;">karting check-in deadline</strong> at the 1st floor karting counter — not the race start. Be there at least 5 minutes early to get your POV camera and enter the safety briefing.
      </p>
      <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.85);line-height:1.5;">
        We ask that you <strong style="color:#fff;">arrive ${p.arriveMinutes} minutes before</strong> your selected time to check in at Guest Services (2nd floor) for your waivers, height check, and racing credentials. This gives you time for any unexpected lines.
      </p>
    </div>

    <div style="background:linear-gradient(135deg,#004AAD,#0058cc);padding:14px 18px;border-radius:8px;border-left:4px solid #3399ff;">
      <p style="margin:0;font-size:14px;font-weight:700;text-align:center;letter-spacing:0.3px;">
        🕐 Please arrive ${p.arriveMinutes} minutes before your selected time.
      </p>
    </div>

  </div>
  <script>
    // Auto-resize: tell parent iframe our height
    function postHeight(){
      var h = document.body.scrollHeight;
      window.parent.postMessage({type:'fasttrax-embed-height',height:h},'*');
    }
    postHeight();
    window.addEventListener('resize',postHeight);
    // Re-measure after fonts load
    if(document.fonts){document.fonts.ready.then(postHeight);}
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      "X-Frame-Options": "ALLOW-FROM https://booking.bmileisure.com",
    },
  });
}
