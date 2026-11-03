import { useEffect, useId, useState } from 'react';
import { LatticeMark } from './LatticeMark';
import { useTheme } from './theme';

export function SiteHeader({
  source,
  operator,
}: {
  readonly source: string;
  readonly operator: boolean;
}) {
  const [theme, toggleTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const menu = useId();
  useEffect(() => {
    if (!open) return;
    // Escape, or any click outside the Menu button (a link in the menu included), closes the menu.
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const click = (event: MouseEvent) => {
      if (!(event.target instanceof Element && event.target.closest('.menu-button')))
        setOpen(false);
    };
    window.addEventListener('keydown', key);
    document.addEventListener('click', click);
    return () => {
      window.removeEventListener('keydown', key);
      document.removeEventListener('click', click);
    };
  }, [open]);
  return (
    <header className="site-header">
      <a className="brand" href="./" aria-label="Lattice home">
        <LatticeMark />
        <span aria-hidden="true">Lattice</span>
      </a>
      <nav id={menu} className="site-nav" aria-label="Site" data-open={open ? '' : undefined}>
        <a href="#stories">Stories</a>
        <a href="https://0vertrained.github.io/#lattice">Portfolio</a>
        <a href={source}>Source</a>
        {operator && (
          <a className="button" href="./operator.html">
            Operator sign-in
          </a>
        )}
      </nav>
      <button
        type="button"
        className="menu-button"
        aria-expanded={open}
        aria-controls={menu}
        onClick={() => setOpen(!open)}
      >
        Menu
      </button>
      <button
        type="button"
        className="theme-toggle"
        aria-pressed={theme === 'dark'}
        title="Dark theme"
        onClick={toggleTheme}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="7.25" />
          <path d="M10 2.75a7.25 7.25 0 0 1 0 14.5z" />
        </svg>
        <span className="visually-hidden">Dark theme</span>
      </button>
    </header>
  );
}
