import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Design token: indigo-600 is the primary brand colour
        brand: {
          DEFAULT: "#6366f1",
          50:  "#eef2ff",
          100: "#e0e7ff",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
        },
        // Database-UI primitives. Values are CSS vars (globals.css) so the
        // light/dark swap lives in one place; these surface them to Tailwind.
        // Measured from live Notion — see the design doc §5.
        menu: {
          bg: "var(--menu-bg)",
          fg: "var(--menu-fg)",
          disabled: "var(--menu-fg-disabled)",
          divider: "var(--menu-divider)",
          hover: "var(--menu-row-hover-bg)",
          field: "var(--menu-field-bg)",
          badge: "var(--menu-badge-bg)",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      // Database-UI primitives. Values live as CSS vars in globals.css so the
      // light/dark swap happens in one place; these just surface them to
      // Tailwind. Measured from live Notion — see the design doc §5.
      borderRadius: { menu: "var(--menu-radius)" },
      boxShadow: { menu: "var(--menu-shadow)" },
      spacing: {
        "menu-row": "var(--menu-row-height)",
        "menu-icon": "var(--menu-icon-box)",
      },
      width: {
        "menu-sm": "var(--menu-width-sm)",
        "menu-md": "var(--menu-width-md)",
        "menu-lg": "var(--menu-width-lg)",
        "config-sidebar": "var(--config-sidebar-width)",
      },
      fontSize: { menu: "var(--menu-label-size)" },
    },
  },
  plugins: [],
};

export default config;
