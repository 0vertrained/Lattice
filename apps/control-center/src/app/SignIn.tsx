import { lazy, Suspense, useState } from 'react';
import type { AuthConfig } from '../core/auth/oidc';
import { LatticeMark } from '../ink/LatticeMark';
import { ThemeToggle } from '../ink/ThemeToggle';
import { LampGlyph } from './StatusLamps';

// The drawing and its recording load beside the form, never in front of it.
const SignInDrawing = lazy(() => import('./SignInDrawing'));

const coreText = {
  checking: 'Checking the core',
  online: 'Core reachable',
  offline: 'Core unreachable',
} as const;
const coreLamp = { checking: 'off', online: 'clear', offline: 'stop' } as const;

export function SignIn({
  mode,
  health,
  error,
  onConnect,
  onSignIn,
}: {
  readonly mode: AuthConfig['mode'] | null;
  readonly health: 'checking' | 'online' | 'offline';
  readonly error: string;
  readonly onConnect: (apiKey: string) => Promise<void>;
  readonly onSignIn: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  return (
    <div className="signin">
      <header className="console-header signin-header">
        <div className="brand">
          <LatticeMark />
          <span>Lattice</span>
        </div>
        <ThemeToggle />
      </header>
      <main className="signin-body">
        <section className="signin-text" aria-labelledby="signin-title">
          <h1 id="signin-title">Operator console</h1>
          <p className="lead">
            See the fleet, review what it proposes, and approve what it does next. Your role decides
            what you can approve, and every decision is signed and audited.
          </p>
          <p className="signin-core" role="status">
            <LampGlyph state={coreLamp[health]} />
            {coreText[health]}
          </p>
          {mode === 'oidc' && (
            <div className="signin-actions">
              <button type="button" className="button primary" onClick={onSignIn}>
                Sign in
              </button>
            </div>
          )}
          {mode === 'development' && (
            <form
              className="signin-key"
              onSubmit={(event) => {
                event.preventDefault();
                void onConnect(apiKey);
              }}
            >
              <label>
                Development API key
                <input
                  type="password"
                  value={apiKey}
                  minLength={32}
                  autoComplete="off"
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <button type="submit" className="button primary">
                Connect to local core
              </button>
              <small>Local development mode. The key is cleared when you reload.</small>
            </form>
          )}
          {error !== '' && (
            <p className="console-alert" role="alert">
              {error}
            </p>
          )}
          <p className="signin-tour">
            No account? <a href="./">Explore the recorded tour</a>
          </p>
        </section>
        <Suspense fallback={<div className="plate signin-plate" />}>
          <SignInDrawing />
        </Suspense>
      </main>
    </div>
  );
}
