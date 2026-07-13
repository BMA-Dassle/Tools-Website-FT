import { Poppins } from "next/font/google";

/**
 * The portal's sans face (its tailwind font-sans), self-hosted by next/font.
 * Import from a page.tsx (server component) and wrap the admin client:
 *   <div className={adminPoppins.variable}><Client … /></div>
 * ADMIN_SANS in ./theme.ts consumes the --font-v2 variable this exposes.
 */
export const adminPoppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-v2",
});
