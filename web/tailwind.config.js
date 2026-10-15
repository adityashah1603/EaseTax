/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#F3F5F2',
        panel: '#FFFFFF',
        ink: '#1A2420',
        graphite: '#56625C',
        faint: '#7F8A85',
        rule: '#DCE1DB',
        ruleSoft: '#ECEFEA',
        ledger: { DEFAULT: '#2E6A4E', soft: '#E3EFE8', ink: '#1F4D38' },
        pencil: { DEFAULT: '#B23A2E', soft: '#F8E6E3', ink: '#8A2A20' },
        blue: { DEFAULT: '#2C5BA0', soft: '#E4ECF7', ink: '#1F4277' },
        amber: { DEFAULT: '#9A6A10', soft: '#F7EEDB', ink: '#704C08' },
      },
      fontFamily: {
        sans: ['"Source Sans 3"', 'system-ui', 'Segoe UI', 'sans-serif'],
        serif: ['"Source Serif 4"', 'Georgia', 'serif'],
      },
      fontSize: {
        '2xs': ['11px', '15px'],
        xs: ['12px', '16px'],
        sm: ['13px', '18px'],
        base: ['14px', '20px'],
      },
    },
  },
  plugins: [],
};
