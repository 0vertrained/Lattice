import { useEffect, useState } from 'react';

// public/theme.js applies a stored choice before first paint; keep the key and values in step with it.
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

/** The theme follows the device until the visitor picks the other one; picking the device's theme again clears the choice. */
export function useTheme(): readonly [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? device());
  useEffect(() => {
    const saved = stored();
    if (saved && saved !== device()) document.documentElement.dataset.theme = saved;
    const media = query();
    const follow = () => {
      if (!stored()) setTheme(device());
    };
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, []);
  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    const root = document.documentElement;
    try {
      if (next === device()) localStorage.removeItem(key);
      else localStorage.setItem(key, next);
    } catch {
      /* Storage can be unavailable; the choice then lasts for this page only. */
    }
    if (next === device()) delete root.dataset.theme;
    else root.dataset.theme = next;
    setTheme(next);
  }
  return [theme, toggle] as const;
}
