/**
 * Daily Events board CSS, injected alongside baThemeCss(theme) + BOARD_CSS.
 *
 * `.de-spin` is the small rotating border-circle spinner used for loading
 * states (portal `animate-spin`). `.ba-row:hover` extends the reservations
 * board's row-hover idiom to the div-based rows this board uses (BOARD_CSS
 * only targets `td` children) — same `--ba-hover` surface, page-scoped.
 */
export const DE_CSS = `
    .de-spin { border-radius: 9999px; animation: de-spin 0.8s linear infinite; }
    @keyframes de-spin { to { transform: rotate(360deg); } }
    .ba-row:hover { background-color: var(--ba-hover); }
  `;
