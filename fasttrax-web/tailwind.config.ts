import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Backgrounds
        "ft-deep":    "#000418",
        "ft-navy":    "#010A20",
        "ft-card":    "#071027",
        // Accents
        "ft-cyan":    "#00E2E5",
        "ft-magenta": "#F800C6",
        "ft-violet":  "#8652FF",
        "ft-red":     "#E53935",
        // Text
        "ft-light":   "#F5ECEE",
      },
      fontFamily: {
        anton:   ['"Bebas Neue"', "sans-serif"],
        poppins: ["Inter", "sans-serif"],
        jakarta: ['"Plus Jakarta Sans"', "sans-serif"],
      },
      backgroundImage: {
        "hero-gradient": "linear-gradient(to right, rgba(0,4,24,0.85) 40%, rgba(0,4,24,0.4) 100%)",
        "card-gradient": "linear-gradient(to top, rgba(0,4,24,0.95) 0%, rgba(0,4,24,0.4) 60%, transparent 100%)",
      },
    },
  },
  plugins: [],
};

export default config;
