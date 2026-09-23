module.exports = {
  content: ['../index.html', '../assets/app.js'],
  darkMode: 'class',
  theme: { extend: {
    fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
    colors: { brand: { 50: '#eef2ff', 100: '#e0e7ff', 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca' } },
    boxShadow: { soft: '0 1px 2px rgba(15,23,42,.04), 0 8px 24px -8px rgba(15,23,42,.10)' },
  } },
};
