/**
 * The one way an icon is drawn in the CRM: `@tabler/icons-react`, 16px,
 * hidden from assistive tech (the surrounding button or label carries the
 * name), and `className="icon"` so the prototype's `svg.icon` rules apply.
 */
export const ICON = { size: 16, "aria-hidden": true, className: "icon" } as const;
