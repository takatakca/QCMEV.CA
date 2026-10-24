/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#f0f4ff',
          100: '#e0e9ff',
          500: '#3b5bdb',
          600: '#3451c7',
          700: '#2c44b0',
          900: '#1a2d7a',
        },
        rq: { // Revenu Québec brand blue
          500: '#005baa',
          600: '#004d91',
        },
      },
    },
  },
  plugins: [],
};
