/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'sniper-dark': '#0f172a',
        'sniper-green': '#10b981',
        'sniper-red': '#ef4444',
      }
    },
  },
  plugins: [],
}