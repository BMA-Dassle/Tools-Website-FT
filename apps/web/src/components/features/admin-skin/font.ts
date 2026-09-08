import { Poppins } from "next/font/google";

/**
 * The portal's sans face (its tailwind font-sans), self-hosted by next/font.
 * Import from a page.tsx (server component) and wrap the admin client:
 *   <div className={adminPoppins.variable}><Client … /></div>
 * ADMIN_SANS in ./theme.ts consumes the --font-v2 variable this exposes.
 */
export const adminPoppins = Poppins({
  subsets: ["latin"],
  // 800 is the pit board TV's eyebrow weight (see TV_DARK in ./theme). Without
  // the face loaded the browser synthesises it from 700 and the tracked-out
  // caps come back smeared, which is exactly the label the check-in board reads
  // most often.
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-v2",
});
