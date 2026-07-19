"use client";

/**
 * Animated "which slot" guide for the game-card insert screens (reload &
 * balance check). Guests kept feeding cards into the barcode scanner, the
 * cash acceptor, and the Square terminal — the phone photos of the fascia
 * were too dark to read on screen, so this is a stylized vector recreation
 * of the kiosk panel instead: the game-card slot glows green and a card
 * slides into it on a loop; every wrong slot wears a no-entry mark.
 *
 * Pure CSS/SVG animation (keyframes in app/kiosk/kiosk.css); no JS timers.
 * With prefers-reduced-motion the card rests below the glowing slot and the
 * diagram still reads as a static "insert here" figure.
 */

/** Standard no-entry mark (circle + slash) over a wrong slot. */
function NoEntry({ cx, cy }: { cx: number; cy: number }) {
  const r = 25;
  const o = r * 0.7071;
  return (
    <g aria-hidden="true">
      <circle cx={cx} cy={cy} r={r} fill="rgba(40,0,0,0.45)" stroke="#ff4d4d" strokeWidth="6" />
      <line
        x1={cx - o}
        y1={cy - o}
        x2={cx + o}
        y2={cy + o}
        stroke="#ff4d4d"
        strokeWidth="6"
        strokeLinecap="round"
      />
    </g>
  );
}

export function CardSlotGuide({
  label,
  sublabel,
  width = 560,
}: {
  label?: string;
  sublabel?: string;
  width?: number;
}) {
  return (
    <div className="flex flex-col items-center gap-8 text-center" role="status" aria-live="polite">
      <svg
        viewBox="0 0 560 356"
        style={{ width, maxWidth: "100%" }}
        aria-label="Insert your game card into the glowing green slot on the left side of the panel"
      >
        <defs>
          <linearGradient id="ksg-panel" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#181e2b" />
            <stop offset="1" stopColor="#0c101a" />
          </linearGradient>
          <radialGradient id="ksg-scan" cx="0.5" cy="0.45" r="0.75">
            <stop offset="0" stopColor="#ff7a29" />
            <stop offset="0.55" stopColor="#e03a10" />
            <stop offset="1" stopColor="#5c0e00" />
          </radialGradient>
          <linearGradient id="ksg-card" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0d3f8f" />
            <stop offset="1" stopColor="#071f4a" />
          </linearGradient>
          {/* The card enters the panel through the slit — hide whatever has
              slid above the slit line. */}
          <clipPath id="ksg-slit-clip">
            <rect x="18" y="187" width="196" height="169" />
          </clipPath>
        </defs>

        {/* ── Panel fascia ── */}
        <rect x="0" y="0" width="560" height="300" rx="12" fill="url(#ksg-panel)" />
        <rect
          x="1.5"
          y="1.5"
          width="557"
          height="297"
          rx="11"
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="3"
        />

        {/* ── NFC pad (top-center) — neutral, just dimmed ── */}
        <g opacity="0.45">
          <rect
            x="225"
            y="16"
            width="110"
            height="82"
            rx="10"
            fill="#1c2233"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="2"
          />
          <circle cx="266" cy="57" r="3.5" fill="#8fa2c0" />
          <path
            d="M271.1 50.9 A8 8 0 0 1 271.1 63.1 M275.6 45.5 A15 15 0 0 1 275.6 68.5 M280.1 40.1 A22 22 0 0 1 280.1 73.9"
            fill="none"
            stroke="#8fa2c0"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <text
            x="280"
            y="115"
            textAnchor="middle"
            fill="rgba(255,255,255,0.4)"
            fontSize="12"
            fontWeight="700"
            letterSpacing="3"
          >
            NFC READER
          </text>
        </g>

        {/* ── Barcode scanner + receipt slot (center) — wrong ── */}
        <g opacity="0.75">
          <rect
            x="223"
            y="138"
            width="114"
            height="66"
            rx="8"
            fill="#11151f"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="2"
          />
          <rect x="233" y="148" width="94" height="46" rx="5" fill="url(#ksg-scan)" />
          <rect x="233" y="166" width="94" height="4" fill="#ffb08a" opacity="0.85" />
          <rect x="232" y="222" width="96" height="11" rx="5" fill="#cfd6e4" opacity="0.8" />
        </g>

        {/* ── Square terminal (top-right) — wrong ── */}
        <g opacity="0.8">
          <rect x="442" y="8" width="88" height="98" rx="14" fill="#f4f5f7" />
          <rect x="452" y="20" width="68" height="62" rx="6" fill="#10141d" />
          <circle cx="486" cy="94" r="4" fill="#9aa2b1" />
        </g>

        {/* ── Cash acceptor (lower-right) — wrong ── */}
        <g opacity="0.75">
          <rect
            x="420"
            y="168"
            width="110"
            height="66"
            rx="8"
            fill="#1c2233"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="2"
          />
          <rect x="430" y="178" width="90" height="34" rx="4" fill="#0a0d14" />
          <path
            d="M446 187 l10 8 -10 8 z M466 187 l10 8 -10 8 z M486 187 l10 8 -10 8 z"
            fill="#ff4030"
          />
          <text
            x="475"
            y="227"
            textAnchor="middle"
            fill="rgba(255,255,255,0.45)"
            fontSize="11"
            fontWeight="700"
            letterSpacing="3"
          >
            CASH
          </text>
        </g>

        {/* ── Game-card slot (left) — the RIGHT one ── */}
        <rect
          x="38"
          y="150"
          width="150"
          height="70"
          rx="8"
          fill="#0a0d14"
          stroke="rgba(255,255,255,0.07)"
          strokeWidth="2"
        />
        <rect
          x="58"
          y="181"
          width="110"
          height="8"
          rx="4"
          fill="#000"
          stroke="#2c3446"
          strokeWidth="1.5"
        />

        {/* Card sliding into the slit (clipped above the slit line) */}
        <g clipPath="url(#ksg-slit-clip)">
          <g className="k-slot-card">
            <rect
              x="76"
              y="205"
              width="74"
              height="112"
              rx="8"
              fill="url(#ksg-card)"
              stroke="#3d6ec9"
              strokeWidth="2"
            />
            <rect x="76" y="205" width="74" height="26" rx="8" fill="#00b8cf" />
            <rect x="76" y="222" width="74" height="9" fill="#00b8cf" />
            <text
              x="113"
              y="258"
              textAnchor="middle"
              fill="#ffffff"
              fontSize="12.5"
              fontWeight="800"
              fontStyle="italic"
              letterSpacing="0.5"
            >
              GAME
            </text>
            <text
              x="113"
              y="274"
              textAnchor="middle"
              fill="#9fd9ff"
              fontSize="12.5"
              fontWeight="800"
              fontStyle="italic"
              letterSpacing="0.5"
            >
              CARD
            </text>
            <rect x="84" y="286" width="58" height="14" rx="3" fill="rgba(255,255,255,0.85)" />
          </g>
        </g>

        {/* Green highlight + label (drawn over the card so the frame stays crisp) */}
        <g className="k-slot-glow">
          <rect
            x="26"
            y="138"
            width="174"
            height="94"
            rx="14"
            fill="rgba(70,214,140,0.05)"
            stroke="#46d68c"
            strokeWidth="4"
          />
        </g>
        <text
          x="113"
          y="125"
          textAnchor="middle"
          fill="#46d68c"
          fontSize="15"
          fontWeight="800"
          letterSpacing="3.5"
        >
          GAME CARD
        </text>

        <NoEntry cx={280} cy={187} />
        <NoEntry cx={486} cy={57} />
        <NoEntry cx={475} cy={201} />
      </svg>

      {label ? (
        <div className="font-heading text-[40px] font-bold italic leading-tight">{label}</div>
      ) : null}
      {sublabel ? <div className="-mt-4 text-[24px] text-white/55">{sublabel}</div> : null}
    </div>
  );
}
