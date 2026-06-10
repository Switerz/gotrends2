import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./client/**/*.{ts,tsx}', './index.html'],
  theme: {
    extend: {
      colors: {
        ink: {
          900: '#0E0E12',
          800: '#15161D',
          700: '#1B1D26',
          600: '#272832',
          500: '#383A47',
          400: '#5A5C6C',
          300: '#7B7C8A',
          200: '#B6B7C2',
          100: '#EAE6DA',
        },
        sage:   { DEFAULT: '#74D4A6', dim: '#3B7A60', wash: '#1A3328' },
        amber:  { DEFAULT: '#F5C56A', dim: '#9C7C3A', wash: '#33291A' },
        coral:  { DEFAULT: '#E07A6B', dim: '#8C4A3F', wash: '#33201D' },
        cobalt: { DEFAULT: '#6FA1E6', dim: '#3F6BA0', wash: '#1A2333' },
        gold:   { DEFAULT: '#C5A572', dim: '#7A6A4A' },
      },
      fontFamily: {
        display: ['"Fraunces"', 'Georgia', 'serif'],
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        'soft-lift': '0 1px 2px rgba(0,0,0,0.4), 0 8px 24px -8px rgba(0,0,0,0.6)',
        'inset-hairline': 'inset 0 0 0 1px rgba(255,255,255,0.04)',
      },
      borderRadius: {
        card: '6px',
        pill: '999px',
      },
      transitionTimingFunction: {
        editorial: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
    },
  },
  plugins: [],
}

export default config
