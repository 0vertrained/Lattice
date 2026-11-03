// Sets the light or dark theme before first paint: the visitor's saved choice, otherwise the device's.
// The CSP allows only same-origin scripts, so this cannot be inline.
let theme = null;
try {
  theme = localStorage.getItem('lattice-theme');
} catch {
  /* Without storage the page follows the device. */
}
if (theme !== 'light' && theme !== 'dark')
  theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
document.documentElement.dataset.theme = theme;
