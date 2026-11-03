// Applies a visitor's saved light/dark choice before first paint (the CSP allows only same-origin scripts).
try {
  const theme = localStorage.getItem('lattice-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  /* Without storage the page follows the device theme. */
}
