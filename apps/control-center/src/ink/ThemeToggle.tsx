import { useTheme } from './theme';

/** Switches between the day and night themes; the choice is remembered until it matches the device again. */
export function ThemeToggle() {
  const [theme, toggleTheme] = useTheme();
  return (
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
  );
}
