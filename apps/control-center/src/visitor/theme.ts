import { useEffect, useState } from 'react';

// public/theme.js sets the theme before first paint; keep the key and values in step with it.
const key = 'lattice-theme';
export type Theme = 'light' | 'dark';

const query = () => window.matchMedia('(prefers-color-scheme: dark)');
const device = (): Theme => (query().matches ? 'dark' : 'light');
function stored(): Theme | null {
  try {
    const value = localStorage.getItem(key);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}
const apply = (theme: Theme) => {
  document.documentElement.dataset.theme = theme;
};

/** The theme follows the device until the visitor picks the other one; picking the device's theme again clears the choice. */
export function useTheme(): readonly [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? device());
  useEffect(() => {
    apply(stored() ?? device());
    const media = query();
    const follow = () => {
      if (stored()) return;
      apply(device());
      setTheme(device());
    };
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, []);
  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    try {
      if (next === device()) localStorage.removeItem(key);
      else localStorage.setItem(key, next);
    } catch {
      /* Storage can be unavailable; the choice then lasts for this page only. */
    }
    apply(next);
    setTheme(next);
  }
  return [theme, toggle] as const;
}
