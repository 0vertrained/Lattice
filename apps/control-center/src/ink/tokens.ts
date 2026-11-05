import { useEffect, useState } from 'react';

const tokenNames = [
  'film',
  'paper',
  'ink',
  'graphite',
  'rule',
  'lane',
  'clear',
  'hold',
  'stop',
  'body',
] as const;
export type Tokens = Record<(typeof tokenNames)[number], string>;

const readTokens = (): Tokens => {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    tokenNames.map((name) => [name, style.getPropertyValue(`--${name}`).trim() || '#808080']),
  ) as Tokens;
};

/** The page's colour tokens for drawings that cannot use CSS, such as WebGL, read again whenever the theme changes. */
export function useTokens(): Tokens {
  const [tokens, setTokens] = useState(readTokens);
  useEffect(() => {
    const observer = new MutationObserver(() => setTokens(readTokens()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return tokens;
}
